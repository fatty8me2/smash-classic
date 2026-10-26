/* See netlobby.h.
 *
 * Lobby server: server/cloudflare (Cloudflare Worker + Durable Object),
 * reached over WebSocket: wss://<worker>/ws?room=CODE&role=host|join&v=2.
 * The game's UDP endpoint is learned from Cloudflare's public STUN server
 * and exchanged through the Worker, which numbers the players (slots 0-3; the
 * creator starts as host in slot 0) and tells everyone everyone's endpoints.
 * When the host leaves the Worker promotes the lowest remaining slot and
 * announces it ("host" message and the roster's `host` field): the room code
 * keeps working and the new host takes over the host duties. Every pair of
 * players then hole-punches a direct UDP path (a full mesh). If a pair's
 * punch fails, that pair's game packets are relayed through the Worker's
 * WebSocket instead.
 *
 * Peer-to-peer lobby messages ("SSBL" lines, over direct UDP or relay; the
 * sender is identified by the transport, a slot number is carried only where
 * a packet may arrive from an address nobody has heard of yet):
 *   SSBL HELLO <slot> | SSBL HELLOACK <slot>   punch / keepalive
 *   SSBL PICK <fkind> <time_ms> <tapjump_off> <version>
 *                                             character pick + RTT probe + own tap-jump setting + game version
 *   SSBL PONG <time_ms>                       immediate echo of a PICK's time
 *   SSBL START <stage> <stocks> <items> <seed> <delay> <autoz> <comp> <neutral> <hazards_off>
 *              <n> {<slot> <fkind> <costume> <tapjump_off>} * n
 *                                             host -> every player: the match, players in game-slot order
 *   SSBL GO <seed>                            player -> host: START accepted and every player is reachable
 *   SSBL BEGIN <seed>                         host -> players: everyone said GO, start now
 *   SSBL ABORT                                host -> players: the start was cancelled */
#include "netlobby.h"
#include "hello_auth.h"
#include "port_udp.h"
#include "port_ws.h"
#include "port_log.h"
#include "netrules.h"
#include "../build_version.h"

#include <libultraship/bridge/consolevariablebridge.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

extern "C" void syNetPeerStartOnlineMatch(int is_host, int local_player, int player_count, const int *transports,
                                          unsigned int delay, unsigned int stage, unsigned int stocks, int is_items,
                                          unsigned int seed, const int *fkinds, const int *costumes);
extern "C" void syNetPeerNotePlayerLeft(int transport);

namespace {

constexpr const char *kStunServer = "stun.cloudflare.com:3478";
constexpr const char *kCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I
constexpr unsigned int kStunRetryMs = 400;
constexpr unsigned int kStunGiveUpMs = 2000;
constexpr unsigned int kServerTimeoutMs = 12000;
constexpr unsigned int kKeepaliveMs = 20000;
constexpr unsigned int kHelloMs = 100;
constexpr unsigned int kPunchTimeoutMs = 3000;
constexpr unsigned int kRelayTimeoutMs = 6000;
constexpr unsigned int kPickMs = 250;
constexpr unsigned int kStartRetryMs = 100;
constexpr unsigned int kStartTimeoutMs = 10000;     // host: every GO must arrive within this
/* A client that misses every BEGIN must still be waiting when the host (already in the match,
 * barrier closed) keeps repeating it, so the client's stale window is not shorter than the host's
 * BEGIN repeat window. */
constexpr unsigned int kBeginRepeatMs = 10000;      // host keeps repeating BEGIN this long after starting
constexpr unsigned int kStartStaleMs = kBeginRepeatMs; // client: no START for this long = the host gave up
constexpr unsigned int kPeerTimeoutMs = 10000;
constexpr int kMaxCodeRetries = 4;
constexpr int kMaxFixedCodeRetries = 10;            // fixed room code: the old socket of a reconnecting host may linger
constexpr unsigned int kFixedCodeRetryMs = 1500;
constexpr unsigned int kJoinWaitForHostMs = 300000; // RetroHub guest waits this long for the host's room
constexpr int kMaxPlayers = PORT_NETLOBBY_MAX_PLAYERS;

enum LinkState {
    LINK_NONE,          // in the room, endpoint not reported yet
    LINK_PUNCHING,      // trying to reach it
    LINK_CONNECTED,
    LINK_FAILED         // gave up (not reachable even through the relay)
};

/* One other player in the room (indexed by lobby slot). */
struct Peer {
    bool present = false;
    std::string pub = "-";
    std::string local = "-";
    std::string tok;                // pair token from the server roster (empty: old server)
    LinkState link = LINK_NONE;
    unsigned int punch_ms = 0;
    unsigned int last_hello_ms = 0;
    bool relay_asked = false;
    unsigned int last_heard_ms = 0;
    int fkind = -1;
    int tap_jump_off = 0;
    std::string version;            // from PICK; "" = not heard yet, "old" = a build that predates the field
    int ping_ms = -1;
    bool go = false;                // host: this player answered START with GO
};

/* A player in the agreed match (game-slot order; the host is first). */
struct Member {
    int slot = 0;                   // lobby slot (= UDP peer index)
    int fkind = 0;
    int costume = 0;
    int tap_jump_off = 0;
};

struct Lobby {
    PortNetLobbyState state = PORT_NETLOBBY_IDLE;
    bool is_host = false;                   // we lead the room right now (host_slot == my_slot)
    bool want_host = false;                 // connection role: we created the room
    int host_slot = -1;                     // lobby slot that leads the room; -1 = unknown / being elected
    bool electing = false;                  // the host left and the server has not named the next one yet
    unsigned int electing_ms = 0;
    std::string host_notice;                // "Player N is now the host" (shown for a few seconds)
    unsigned int host_notice_ms = 0;
    bool options_agreed = false;            // stage / stocks / items / delay adopted from a host's START
    int my_slot = -1;
    std::string server;                     // ws(s)://host[:port]
    std::string code;
    std::string status = "Not connected";
    std::string note;                       // transient message that overrides the computed status
    std::string match_note;                 // why the game ended the match early; shown once it is over
    unsigned int note_ms = 0;
    std::string stun_public = "-";          // our public UDP endpoint from STUN
    bool stun_done = false;
    uint8_t stun_txid[12] = {};
    bool ws_welcomed = false;
    bool endpoint_sent = false;
    int code_retries = 0;
    Peer peers[kMaxPlayers];
    unsigned int state_ms = 0;
    unsigned int connect_ms = 0;
    unsigned int stun_ms = 0;
    unsigned int last_stun_ms = 0;
    unsigned int last_keepalive_ms = 0;
    unsigned int last_pick_ms = 0;
    unsigned int last_start_ms = 0;         // host: last START sent; client: last START heard
    unsigned int last_begin_ms = 0;
    unsigned int begin_until_ms = 0;
    int my_fkind = 0;
    bool after_match = false;       // an online match ended; players are back in their own menus
    int stage = 0;
    int stocks = 3;
    int items = 0;
    int delay = 2;
    unsigned int seed = 0;
    std::vector<Member> match;      // the match being started
    int pending_rules[4] = {};      // autoz, comp, neutral, hazards_off of the pending/started match
};

Lobby sLobby;
std::mt19937 sRng{ std::random_device{}() };

/* Unattended testing (scripts/netplay_lobbytest.ps1):
 *   SSB64_LOBBY_HOST=<server url>  host a room; writes the code to SSB64_LOBBY_CODE_FILE
 *   SSB64_LOBBY_JOIN=<server url>  join the code read from SSB64_LOBBY_CODE_FILE
 *   SSB64_LOBBY_FKIND / SSB64_LOBBY_STAGE / SSB64_LOBBY_AUTOSTART=1
 *   SSB64_LOBBY_PLAYERS=<n>        host autostarts once n players (2-4, itself included) are connected
 *   SSB64_LOBBY_START_DELAY_MS=<ms> wait this long (default 1000) after everyone is connected before starting
 *   SSB64_LOBBY_AUTOREMATCH=<n>   host starts n rematches, each a few seconds after a match ends
 *   SSB64_LOBBY_FORCE_RELAY=1      skip the direct path (tests the relay)
 *   SSB64_LOBBY_RELAY_PEER=<slot>  skip the direct path to that one lobby slot only
 *   SSB64_LOBBY_MIGRATE_PLAYERS=<n> autostart threshold after this process became host through a host migration
 *   SSB64_LOBBY_TEST_DIE=start|begin|begin1|begin2  the room's creator kills itself right after its first START / BEGIN (test only)
 *   SSB64_LOBBY_CODE=<code>        use this room code (RetroHub passes the code its own
 *                                  lobby agreed on); joiners retry until the host's room exists
 * Without SSB64_LOBBY_FKIND/STAGE the player's Netplay menu choices are used. */
struct LobbyAuto {
    bool checked = false;
    bool host = false;
    bool join = false;
    bool autostart = false;
    bool code_written = false;
    std::string server;
    std::string code_file;
    unsigned int start_after_ms = 0;
    int players = 2;
    int rematches_left = 0;
    unsigned int rematch_after_ms = 0;
    int migrate_players = 0;         // SSB64_LOBBY_MIGRATE_PLAYERS: autostart threshold once this process became host
    bool migrated = false;
    std::string fixed_code;          // SSB64_LOBBY_CODE
    unsigned int join_deadline_ms = 0;
    unsigned int join_retry_ms = 0;
    bool join_no_room = false;       // the last join failed with no-such-room (the host may not have created it yet)
    unsigned int host_retry_ms = 0;  // fixed-code host: reconnect at this time after room-in-use (0 = none pending)
    int host_retries = 0;
};
LobbyAuto sAuto;

const char *env(const char *name)
{
    const char *value = std::getenv(name);
    return (value != nullptr && value[0] != '\0') ? value : nullptr;
}

bool elapsed(unsigned int since, unsigned int ms)
{
    return static_cast<int>(port_udp_now_ms() - since) >= static_cast<int>(ms);
}

/* Wire values are untrusted: they index fighter, stage and team-colour tables in the game.
 * Ranges mirror nFTKindPlayableStart..End, nGRKindBattleStart..End and the 4 costumes. */
constexpr int kMaxFkind = 11;      // nFTKindNess
constexpr int kMaxStage = 9;       // nGRKindInishie (last VS stage)
constexpr int kMaxCostume = 3;

bool valid_fkind(int fkind) { return fkind >= 0 && fkind <= kMaxFkind; }
bool valid_costume(int costume) { return costume >= 0 && costume <= kMaxCostume; }
bool valid_stage(int stage) { return stage >= 0 && stage <= kMaxStage; }

bool valid_slot(int slot)
{
    return slot >= 0 && slot < kMaxPlayers;
}

bool force_direct_skip(int slot)
{
    if (env("SSB64_LOBBY_FORCE_RELAY") != nullptr) {
        return true;
    }
    if (const char *only = env("SSB64_LOBBY_RELAY_PEER")) {
        return std::atoi(only) == slot;
    }
    return false;
}

void set_state(PortNetLobbyState state, const std::string &status)
{
    if (state == PORT_NETLOBBY_IN_MATCH || state == PORT_NETLOBBY_IDLE || state == PORT_NETLOBBY_FAILED) {
        sLobby.after_match = false;
    }
    sLobby.state = state;
    sLobby.status = status;
    sLobby.note.clear();
    sLobby.state_ms = port_udp_now_ms();
    port_log("SSB64 Lobby: %s\n", status.c_str());
}

void set_note(const std::string &note)
{
    sLobby.note = note;
    sLobby.note_ms = port_udp_now_ms();
}

/* The peer that leads the room, when it is someone else. */
Peer *host_peer(void)
{
    return (!sLobby.is_host && valid_slot(sLobby.host_slot) && sLobby.host_slot != sLobby.my_slot)
               ? &sLobby.peers[sLobby.host_slot] : nullptr;
}

void reset_peers(void)
{
    for (int i = 0; i < kMaxPlayers; i++) {
        sLobby.peers[i] = Peer();
    }
    port_udp_peers_clear();
}

void shutdown_net(void)
{
    port_netrules_clear();
    port_ws_close();
    port_udp_close();       // also drops the relay hooks and every peer
    reset_peers();
    sLobby.match.clear();
    sLobby.my_slot = -1;
    sLobby.host_slot = -1;
    sLobby.electing = false;
    sLobby.host_notice.clear();
}

void fail(const std::string &why)
{
    shutdown_net();
    set_state(PORT_NETLOBBY_FAILED, why);
}

/* ---- relay over the lobby WebSocket ---- */

int relay_send(const void *data, int size)
{
    return port_ws_send_binary(data, size);
}

int relay_recv(void *buffer, int capacity)
{
    return port_ws_poll_binary(buffer, capacity);
}

/* ---- STUN (RFC 5389 binding request to stun.cloudflare.com) ---- */

constexpr uint32_t kStunCookie = 0x2112A442;

void send_stun(void)
{
    uint8_t req[20] = { 0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42 };
    std::memcpy(req + 8, sLobby.stun_txid, 12);
    port_udp_send_to(kStunServer, req, sizeof(req));
}

bool parse_stun(const uint8_t *msg, int size)
{
    if (size < 20 || msg[0] != 0x01 || msg[1] != 0x01 ||
        msg[4] != 0x21 || msg[5] != 0x12 || msg[6] != 0xA4 || msg[7] != 0x42 ||
        std::memcmp(msg + 8, sLobby.stun_txid, 12) != 0) {
        return false;
    }
    if (sLobby.stun_done) {
        return true;    // answer to a retransmitted request
    }
    int length = (msg[2] << 8) | msg[3];
    int end = (20 + length < size) ? 20 + length : size;
    for (int at = 20; at + 4 <= end;) {
        int type = (msg[at] << 8) | msg[at + 1];
        int alen = (msg[at + 2] << 8) | msg[at + 3];
        const uint8_t *v = msg + at + 4;
        if (at + 4 + alen > end) {
            break;
        }
        if ((type == 0x0020 || type == 0x0001) && alen >= 8 && v[1] == 0x01) {   // (XOR-)MAPPED-ADDRESS, IPv4
            uint16_t port = static_cast<uint16_t>((v[2] << 8) | v[3]);
            uint32_t addr = (static_cast<uint32_t>(v[4]) << 24) | (v[5] << 16) | (v[6] << 8) | v[7];
            if (type == 0x0020) {
                port ^= static_cast<uint16_t>(kStunCookie >> 16);
                addr ^= kStunCookie;
            }
            char text[32];
            std::snprintf(text, sizeof(text), "%u.%u.%u.%u:%u", addr >> 24, (addr >> 16) & 0xFF, (addr >> 8) & 0xFF,
                          addr & 0xFF, port);
            sLobby.stun_public = text;
            sLobby.stun_done = true;
            port_log("SSB64 Lobby: public UDP endpoint %s\n", text);
            return true;
        }
        at += 4 + ((alen + 3) & ~3);
    }
    return false;
}

/* ---- server (WebSocket) ---- */

std::string local_endpoint(void)
{
    char text[64];
    return port_udp_local_endpoint(text, sizeof(text)) ? std::string(text) : std::string("-");
}

std::string json_field(const std::string &json, const char *key)
{
    std::string needle = std::string("\"") + key + "\":";
    size_t at = json.find(needle);
    if (at == std::string::npos) {
        return std::string();
    }
    at += needle.size();
    while (at < json.size() && json[at] == ' ') at++;
    if (at < json.size() && json[at] == '"') {
        size_t end = json.find('"', at + 1);
        return (end == std::string::npos) ? std::string() : json.substr(at + 1, end - at - 1);
    }
    size_t end = json.find_first_of(",}", at);
    return json.substr(at, end - at);
}

std::string new_code(void)
{
    std::string code;
    for (int i = 0; i < 6; i++) {
        code += kCodeAlphabet[sRng() % 32];
    }
    return code;
}

void connect_server(void)
{
    std::string url = sLobby.server;
    while (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    url += "/ws?room=" + sLobby.code + "&role=" + (sLobby.want_host ? "host" : "join") + "&v=2&hm=1";
    if (const char *hs = env("SSB64_LOBBY_HUBSLOT")) {      // RetroHub launch: ask for the slot we hold in its room
        if (hs[0] >= '0' && hs[0] <= '3' && hs[1] == 0) {
            url += std::string("&hs=") + hs;
        }
    }
    sLobby.ws_welcomed = false;
    sLobby.endpoint_sent = false;
    sLobby.connect_ms = port_udp_now_ms();
    port_ws_connect(url.c_str());
}

void send_endpoint_if_ready(void)
{
    if (!sLobby.ws_welcomed || sLobby.endpoint_sent || (!sLobby.stun_done && !elapsed(sLobby.stun_ms, kStunGiveUpMs))) {
        return;
    }
    std::string msg = "{\"type\":\"endpoint\",\"public\":\"" + sLobby.stun_public + "\",\"local\":\"" + local_endpoint() + "\"}";
    port_ws_send_text(msg.c_str());
    sLobby.endpoint_sent = true;
}

/* ---- peers (SSBL over direct UDP or relay) ---- */

void send_peer(int slot, const std::string &text)
{
    port_udp_peer_send(slot, text.data(), static_cast<int>(text.size()));
}

/* To every connected player (other than yourself). */
void send_connected(const std::string &text)
{
    for (int i = 0; i < kMaxPlayers; i++) {
        if (sLobby.peers[i].present && sLobby.peers[i].link == LINK_CONNECTED) {
            send_peer(i, text);
        }
    }
}

int connected_peers(void)
{
    int n = 0;
    for (const Peer &p : sLobby.peers) {
        n += (p.present && p.link == LINK_CONNECTED) ? 1 : 0;
    }
    return n;
}

int present_peers(void)
{
    int n = 0;
    for (const Peer &p : sLobby.peers) {
        n += p.present ? 1 : 0;
    }
    return n;
}

bool any_relayed(void)
{
    for (int i = 0; i < kMaxPlayers; i++) {
        if (sLobby.peers[i].present && port_udp_peer_is_relay(i)) {
            return true;
        }
    }
    return false;
}

void mark_connected(int slot)
{
    Peer &p = sLobby.peers[slot];
    if (p.link == LINK_CONNECTED) {
        return;
    }
    p.link = LINK_CONNECTED;
    p.last_heard_ms = port_udp_now_ms();
    port_log("SSB64 Lobby: player %d connected (%s)\n", slot, port_udp_peer_is_relay(slot) ? "via relay" : "direct");
}

/* This player's own tap-jump setting: they play on their controller port 1. */
int local_tap_jump_off(void)
{
    return CVarGetInteger("gEnhancements.TapJumpDisabled.P1", 0) != 0;
}

/* Host-wide gameplay rules that would otherwise be read from each peer's
 * local settings mid-match (see netrules.h). */
void host_rules(int *autoz, int *comp, int *neutral, int *hazards_off)
{
    *autoz = CVarGetInteger("gEnhancements.CasualRules.AutoZCancel", 0) != 0;
    *comp = CVarGetInteger("gEnhancements.CompRuleset", 0) != 0;
    *neutral = CVarGetInteger("gEnhancements.NeutralSpawns", 0) != 0;
    *hazards_off = CVarGetInteger("gEnhancements.StageHazardsDisabled", 0) != 0;
}

const char *const kGameVersion = BATTLESHIP_CURRENT_VERSION;

/* Two different builds can simulate the same inputs differently, so an online
 * match only starts when every player runs the same version. Returns true
 * (and says why) when the player in `slot` runs another one. */
bool version_mismatch(int slot)
{
    const Peer &p = sLobby.peers[slot];
    if (p.version.empty() || p.version == kGameVersion) {
        return false;
    }
    const std::string theirs = (p.version == "old") ? std::string("an older version") : p.version;
    set_note(std::string("Can't start: you're on ") + kGameVersion + ", player " + std::to_string(slot + 1) +
             " is on " + theirs + ". Everyone needs to update to the same version.");
    return true;
}

std::vector<std::string> split(const char *text)
{
    std::vector<std::string> parts;
    std::string current;
    for (const char *c = text; *c != '\0'; c++) {
        if (*c == ' ' || *c == '\n' || *c == '\r') {
            if (!current.empty()) {
                parts.push_back(current);
                current.clear();
            }
        } else {
            current += *c;
        }
    }
    if (!current.empty()) {
        parts.push_back(current);
    }
    return parts;
}

/* Hands the agreed match to the game (sys/netpeer.c). */
void enter_match(bool is_host)
{
    const int n = static_cast<int>(sLobby.match.size());
    int transports[kMaxPlayers] = {};
    int fkinds[kMaxPlayers] = {};
    int costumes[kMaxPlayers] = {};
    int tap_jump[kMaxPlayers] = {};
    int local = 0;

    for (int i = 0; i < n; i++) {
        transports[i] = sLobby.match[i].slot;
        fkinds[i] = sLobby.match[i].fkind;
        costumes[i] = sLobby.match[i].costume;
        tap_jump[i] = sLobby.match[i].tap_jump_off;
        if (sLobby.match[i].slot == sLobby.my_slot) {
            local = i;
        }
    }
    port_netrules_set(sLobby.pending_rules[0], sLobby.pending_rules[1], sLobby.pending_rules[2],
                      sLobby.pending_rules[3], tap_jump);
    sLobby.match_note.clear();
    if (!is_host) {
        sLobby.begin_until_ms = 0;      // we never repeat a BEGIN, even if we lead the room after this match
    }
    set_state(PORT_NETLOBBY_IN_MATCH, "In match");
    syNetPeerStartOnlineMatch(is_host ? 1 : 0, local, n, transports, static_cast<unsigned int>(sLobby.delay),
                              static_cast<unsigned int>(sLobby.stage), static_cast<unsigned int>(sLobby.stocks),
                              sLobby.items, sLobby.seed, fkinds, costumes);
}

std::string start_message(void)
{
    std::string text = "SSBL START " + std::to_string(sLobby.stage) + " " + std::to_string(sLobby.stocks) + " " +
                       std::to_string(sLobby.items) + " " + std::to_string(sLobby.seed) + " " +
                       std::to_string(sLobby.delay);
    for (int rule : sLobby.pending_rules) {
        text += " " + std::to_string(rule);
    }
    text += " " + std::to_string(sLobby.match.size());
    for (const Member &m : sLobby.match) {
        text += " " + std::to_string(m.slot) + " " + std::to_string(m.fkind) + " " + std::to_string(m.costume) + " " +
                std::to_string(m.tap_jump_off);
    }
    return text;
}

/* Client: the host's START. Answers GO once every other player in the match
 * is reachable from here; the match begins on the host's BEGIN. */
void handle_start(const std::vector<std::string> &args)
{
    if (args.size() < 12) {
        return;
    }
    const int n = std::atoi(args[11].c_str());
    if (n < 2 || n > kMaxPlayers || args.size() < static_cast<size_t>(12 + 4 * n)) {
        return;
    }
    sLobby.last_start_ms = port_udp_now_ms();

    if (sLobby.state == PORT_NETLOBBY_STARTING) {
        send_peer(sLobby.host_slot, "SSBL GO " + args[5]);      // our GO was lost; the host is still waiting
        return;
    }
    if (version_mismatch(sLobby.host_slot)) {
        return;
    }
    std::vector<Member> members;
    bool me_in = false;
    for (int i = 0; i < n; i++) {
        Member m;
        m.slot = std::atoi(args[12 + 4 * i].c_str());
        m.fkind = std::atoi(args[13 + 4 * i].c_str());
        m.costume = std::atoi(args[14 + 4 * i].c_str());
        m.tap_jump_off = std::atoi(args[15 + 4 * i].c_str());
        if (!valid_slot(m.slot) || !valid_fkind(m.fkind) || !valid_costume(m.costume)) {
            return;
        }
        members.push_back(m);
        me_in = me_in || (m.slot == sLobby.my_slot);
    }
    if (!me_in) {
        return;
    }
    for (const Member &m : members) {
        if (m.slot != sLobby.my_slot && sLobby.peers[m.slot].link != LINK_CONNECTED) {
            sLobby.status = "Connecting to the other players...";
            return;        // the host keeps repeating START until we can answer
        }
    }
    sLobby.stage = std::atoi(args[2].c_str());
    sLobby.stocks = std::atoi(args[3].c_str());
    sLobby.items = std::atoi(args[4].c_str());
    sLobby.seed = static_cast<unsigned int>(std::strtoul(args[5].c_str(), nullptr, 10));
    sLobby.delay = std::atoi(args[6].c_str());
    if (!valid_stage(sLobby.stage) || sLobby.stocks < 1 || sLobby.stocks > 99 || sLobby.delay < 0 || sLobby.delay > 16) {
        return;
    }
    for (int i = 0; i < 4; i++) {
        sLobby.pending_rules[i] = std::atoi(args[7 + i].c_str());
    }
    sLobby.match = members;
    sLobby.options_agreed = true;       // if the host leaves, we carry these settings into the next match
    set_state(PORT_NETLOBBY_STARTING, "Starting match - waiting for the other players...");
    send_peer(sLobby.host_slot, "SSBL GO " + args[5]);
}

/* Test only: die without a word, like a crashed host (SSB64_LOBBY_TEST_DIE). */
void die_now(const char *where)
{
    port_log("SSB64 Lobby: TEST_DIE at %s\n", where);
    std::_Exit(3);
}

bool test_die_at(const char *where)
{
    const char *at = env("SSB64_LOBBY_TEST_DIE");
    return at != nullptr && sAuto.host && std::strcmp(at, where) == 0;
}

void begin_as_host(void)
{
    sLobby.begin_until_ms = port_udp_now_ms() + kBeginRepeatMs;
    sLobby.last_begin_ms = port_udp_now_ms();
    const bool partial = test_die_at("begin1");     // test: only the first player hears BEGIN
    const bool skip_first = test_die_at("begin2");  // test: everyone but the first player hears BEGIN
    bool first = true;
    for (const Member &m : sLobby.match) {
        if (m.slot != sLobby.my_slot) {
            if (skip_first && first) {
                first = false;
                continue;
            }
            for (int i = 0; i < 3; i++) {
                send_peer(m.slot, "SSBL BEGIN " + std::to_string(sLobby.seed));
            }
            if (partial) {
                break;
            }
        }
    }
    if (test_die_at("begin") || partial || skip_first) {
        die_now("begin");
    }
    enter_match(true);
}

void abort_start(const std::string &why)
{
    for (const Member &m : sLobby.match) {
        if (m.slot != sLobby.my_slot && valid_slot(m.slot) && sLobby.peers[m.slot].link == LINK_CONNECTED) {
            send_peer(m.slot, "SSBL ABORT");
        }
    }
    sLobby.match.clear();
    set_state(PORT_NETLOBBY_CONNECTED, why);
    set_note(why);
}

void handle_peer(const std::vector<std::string> &args, int slot)
{
    if (args.size() < 2 || !valid_slot(slot) || !sLobby.peers[slot].present) {
        return;
    }
    Peer &p = sLobby.peers[slot];
    p.last_heard_ms = port_udp_now_ms();

    if (p.link != LINK_CONNECTED) {
        mark_connected(slot);       // any word from it proves the path works
    }
    if (args[1] == "HELLO") {
        send_peer(slot, hello_auth::make("HELLOACK", sLobby.my_slot, p.tok));
    } else if (args[1] == "PICK" && args.size() >= 3) {
        const int fkind = std::atoi(args[2].c_str());
        if (!valid_fkind(fkind)) {
            return;
        }
        p.fkind = fkind;
        if (args.size() >= 4) {
            send_peer(slot, "SSBL PONG " + args[3]);
        }
        p.tap_jump_off = (args.size() >= 5) ? (std::atoi(args[4].c_str()) != 0) : 0;
        p.version = (args.size() >= 6) ? args[5] : "old";
    } else if (args[1] == "PONG" && args.size() >= 3) {
        p.ping_ms = static_cast<int>(port_udp_now_ms() - std::strtoul(args[2].c_str(), nullptr, 10));
    } else if (args[1] == "START" && !sLobby.is_host && slot == sLobby.host_slot &&
               (sLobby.state == PORT_NETLOBBY_CONNECTED || sLobby.state == PORT_NETLOBBY_STARTING)) {
        handle_start(args);
    } else if (args[1] == "GO" && sLobby.is_host && sLobby.state == PORT_NETLOBBY_STARTING) {
        /* A GO answers one START: one from an earlier host's start (or an earlier start of ours) must not count. */
        if (args.size() >= 3 && std::strtoul(args[2].c_str(), nullptr, 10) == sLobby.seed) {
            p.go = true;
        }
    } else if (args[1] == "BEGIN" && !sLobby.is_host && slot == sLobby.host_slot && sLobby.state == PORT_NETLOBBY_STARTING) {
        enter_match(false);
    } else if (args[1] == "ABORT" && !sLobby.is_host && slot == sLobby.host_slot && sLobby.state == PORT_NETLOBBY_STARTING) {
        sLobby.match.clear();
        set_state(PORT_NETLOBBY_CONNECTED, "The host cancelled the start");
    }
}

/* ---- roster from the server ---- */

void peer_gone(int slot)
{
    Peer &p = sLobby.peers[slot];
    if (!p.present) {
        return;
    }
    port_log("SSB64 Lobby: player %d left the room\n", slot);
    if (sLobby.state == PORT_NETLOBBY_IN_MATCH) {
        /* The match goes on without them: the game agrees with the others on the tick they drop out. */
        syNetPeerNotePlayerLeft(slot);
    }
    p = Peer();
    port_udp_peer_clear(slot);

    if (sLobby.state == PORT_NETLOBBY_STARTING) {
        for (const Member &m : sLobby.match) {
            if (m.slot == slot) {
                if (sLobby.is_host) {
                    abort_start("Player " + std::to_string(slot + 1) + " left - start cancelled");
                } else {
                    sLobby.match.clear();
                    set_state(PORT_NETLOBBY_CONNECTED, "A player left - waiting for the host");
                }
                break;
            }
        }
    }
}

/* The host's socket closed. The server promotes the lowest remaining slot and tells us in a moment
 * ("host" message, roster); until then nobody leads. */
void begin_election(int old_host)
{
    if (sLobby.is_host || old_host != sLobby.host_slot) {
        return;
    }
    port_log("SSB64 Lobby: the host (player %d) left the room, waiting for the server to name the next one\n", old_host);
    sLobby.host_slot = -1;
    sLobby.electing = true;
    sLobby.electing_ms = port_udp_now_ms();
}

/* The server named `slot` host. The first assignment (welcome) is just information; a change after
 * the host left is a migration: the new host takes over with the settings every peer already holds. */
void set_host(int slot)
{
    if (!valid_slot(slot) || slot == sLobby.host_slot) {
        return;
    }
    const bool migrated = sLobby.electing || sLobby.host_slot >= 0;
    const bool was_host = sLobby.is_host;
    sLobby.host_slot = slot;
    sLobby.electing = false;
    sLobby.is_host = (sLobby.my_slot >= 0) ? (slot == sLobby.my_slot) : sLobby.want_host;
    if (!migrated) {
        return;
    }
    port_log("SSB64 Lobby: player %d is now the host%s\n", slot, sLobby.is_host ? " (that is us)" : "");
    sLobby.host_notice = sLobby.is_host ? std::string("You are now the host") : "Player " + std::to_string(slot + 1) + " is now the host";
    sLobby.host_notice_ms = port_udp_now_ms();
    if (sLobby.is_host && !was_host) {
        /* Host duties start from the state every peer shares: the last agreed stage / stocks / items /
         * delay (adopted from the previous host's START), or our own menu choices if no match was started yet. */
        if (!sLobby.options_agreed) {
            sLobby.stage = valid_stage(CVarGetInteger("gNetplay.Stage", 0)) ? CVarGetInteger("gNetplay.Stage", 0) : 0;
            sLobby.stocks = std::max(1, std::min(99, CVarGetInteger("gNetplay.Stocks", 3)));
            sLobby.items = CVarGetInteger("gNetplay.Items", 0);
            sLobby.delay = std::max(0, std::min(16, CVarGetInteger("gNetplay.Delay", 2)));
        }
        for (Peer &p : sLobby.peers) {
            p.go = false;
        }
        sAuto.migrated = true;
        sAuto.start_after_ms = 0;
        sAuto.rematch_after_ms = 0;
        if (sLobby.state == PORT_NETLOBBY_STARTING) {
            sLobby.match.clear();       // a start the old host began is void; we begin a new one
            set_state(PORT_NETLOBBY_CONNECTED, "The host left - start cancelled");
        }
    }
    if (sLobby.state == PORT_NETLOBBY_CONNECTED || sLobby.state == PORT_NETLOBBY_WAITING) {
        set_note(sLobby.host_notice);
    }
}

/* A HELLO from an address we have no candidate for is only accepted when its IP is one the server
 * announced for that slot (a NAT may remap the port, not the address): a stale packet from the previous
 * holder of the slot must not become the new player's path. */
bool same_host_ip(const char *from, const Peer &p)
{
    const std::string addr(from);
    const std::string ip = addr.substr(0, addr.rfind(':'));
    for (const std::string &known : { p.pub, p.local }) {
        if (known != "-" && known.substr(0, known.rfind(':')) == ip) {
            return true;
        }
    }
    return false;
}

void apply_endpoint(int slot, const std::string &pub, const std::string &local, const std::string &tok)
{
    Peer &p = sLobby.peers[slot];
    p.tok = tok;
    const bool changed = (p.pub != pub) || (p.local != local);

    p.present = true;
    if (!changed) {
        return;
    }
    p.pub = pub;
    p.local = local;
    for (const std::string &endpoint : { pub, local }) {
        if (!endpoint.empty() && endpoint != "-") {
            port_udp_peer_add_candidate(slot, endpoint.c_str());
        }
    }
    if (p.link == LINK_NONE && port_udp_peer_has_candidates(slot)) {
        p.link = LINK_PUNCHING;
        p.punch_ms = port_udp_now_ms();
        p.relay_asked = false;
    }
}

void handle_peers(const std::string &msg)
{
    bool seen[kMaxPlayers] = {};
    size_t at = msg.find("\"peers\":[");
    if (at == std::string::npos) {
        return;
    }
    const std::string host = json_field(msg.substr(0, at), "host");
    if (!host.empty() && host != "null") {
        set_host(std::atoi(host.c_str()));
    }
    at += 9;
    for (;;) {
        size_t open = msg.find('{', at);
        if (open == std::string::npos) {
            break;
        }
        size_t close = msg.find('}', open);
        if (close == std::string::npos) {
            break;
        }
        std::string obj = msg.substr(open, close - open + 1);
        at = close + 1;

        int slot = std::atoi(json_field(obj, "slot").c_str());
        if (!valid_slot(slot) || slot == sLobby.my_slot) {
            continue;
        }
        seen[slot] = true;
        apply_endpoint(slot, json_field(obj, "public"), json_field(obj, "local"), json_field(obj, "tok"));
    }
    for (int i = 0; i < kMaxPlayers; i++) {
        if (!seen[i] && sLobby.peers[i].present) {
            if (sLobby.state == PORT_NETLOBBY_IN_MATCH) {
                /* A roster that merely omits someone is not proof they left (it can be a transient hiccup):
                 * mid-match only the server's explicit peer_left counts. */
                continue;
            }
            peer_gone(i);
        }
    }
}

void handle_server(const std::string &msg)
{
    std::string type = json_field(msg, "type");

    if (type == "welcome") {
        sLobby.ws_welcomed = true;
        std::string slot = json_field(msg, "slot");
        if (slot.empty()) {
            fail("The lobby server is out of date and can't host 3-4 player rooms yet");
            return;
        }
        sLobby.my_slot = std::atoi(slot.c_str());
        {
            /* A server that predates host migration doesn't say who leads: slot 0 does. */
            const std::string host = json_field(msg, "host");
            sLobby.host_slot = -1;
            sLobby.electing = false;
            if (host == "null") {
                fail("No room with code " + sLobby.code);      // a room without a host is closing
                return;
            }
            set_host(host.empty() ? 0 : std::atoi(host.c_str()));
        }
        port_udp_set_relay_hooks(relay_send, relay_recv);   // sending through it is decided per peer
        if (sLobby.is_host) {
            set_state(PORT_NETLOBBY_WAITING, "Room " + sLobby.code + " - waiting for players to join");
        } else {
            sLobby.status = "Joined room " + sLobby.code + " - contacting host...";
        }
    } else if (type == "peers") {
        handle_peers(msg);
    } else if (type == "relaying") {
        /* The room allows relaying now; each pair opts in when its own
         * hole punching fails. Nothing to do. */
    } else if (type == "host") {
        set_host(std::atoi(json_field(msg, "slot").c_str()));
    } else if (type == "peer_left") {
        int slot = std::atoi(json_field(msg, "slot").c_str());
        if (valid_slot(slot) && slot != sLobby.my_slot) {
            begin_election(slot);       // no-op unless it was the host
            peer_gone(slot);
        }
    } else if (type == "error") {
        std::string reason = json_field(msg, "reason");
        if (reason == "room-in-use" && sLobby.want_host && !sAuto.fixed_code.empty()) {
            /* The code is fixed (RetroHub launch): never switch to another one, the guests only know this one.
             * A reconnecting host may still be holding the room for a moment - retry, then explain. */
            if (sAuto.host_retries++ < kMaxFixedCodeRetries) {
                port_ws_close();
                sAuto.host_retry_ms = port_udp_now_ms() + kFixedCodeRetryMs;
                sLobby.status = "Room " + sLobby.code + " is still held - retrying (" + std::to_string(sAuto.host_retries) + "/" +
                                std::to_string(kMaxFixedCodeRetries) + ")...";
            } else {
                fail("Room " + sLobby.code + " is still in use by an earlier session. Close any other game using this room and try again.");
            }
        } else if (reason == "room-in-use" && sLobby.want_host && sLobby.code_retries++ < kMaxCodeRetries) {
            sLobby.code = new_code();
            connect_server();
        } else if (reason == "no-such-room") {
            sAuto.join_no_room = true;
            fail("No room with code " + sLobby.code);
        } else if (reason == "room-full") {
            fail("Room " + sLobby.code + " already has four players");
        } else {
            fail("Lobby server: " + reason);
        }
    }
}

void receive(void)
{
    char text[1024];
    while (port_ws_poll_text(text, sizeof(text))) {
        handle_server(text);
        if (sLobby.state == PORT_NETLOBBY_FAILED) {
            return;
        }
    }
    if (sLobby.state == PORT_NETLOBBY_IN_MATCH) {
        return;     // netpeer owns the UDP socket (and relay queue) now
    }
    uint8_t buffer[512];
    char from[64];
    for (;;) {
        int peer = -1;
        int size = port_udp_recv_any(buffer, sizeof(buffer) - 1, &peer, from, sizeof(from));
        if (size <= 0) {
            return;
        }
        if (peer < 0 && parse_stun(buffer, size)) {
            continue;
        }
        buffer[size] = '\0';
        std::vector<std::string> args = split(reinterpret_cast<const char *>(buffer));
        if (!args.empty() && args[0] == "SSBL") {
            if (peer < 0 && args.size() >= 3 && (args[1] == "HELLO" || args[1] == "HELLOACK")) {
                /* A punch from an address we don't know (the peer's NAT mapped
                 * it to another port): its slot is in the packet. */
                int slot = std::atoi(args[2].c_str());
                if (valid_slot(slot) && slot != sLobby.my_slot && sLobby.peers[slot].present &&
                    same_host_ip(from, sLobby.peers[slot]) &&
                    hello_auth::may_learn(sLobby.peers[slot].tok, args.size(), args.data()) && port_udp_peer_add_candidate(slot, from)) {
                    peer = slot;
                }
            }
            if (peer >= 0) {
                handle_peer(args, peer);
            }
        }
        if (sLobby.state == PORT_NETLOBBY_IN_MATCH || sLobby.state == PORT_NETLOBBY_FAILED) {
            return;
        }
    }
}

void begin(bool is_host, const char *server)
{
    shutdown_net();
    sLobby.is_host = is_host;
    sLobby.want_host = is_host;
    sLobby.options_agreed = false;
    sLobby.server = server ? server : "";
    sLobby.stun_public = "-";
    sLobby.stun_done = false;
    sLobby.code_retries = 0;
    for (uint8_t &b : sLobby.stun_txid) {
        b = static_cast<uint8_t>(sRng());
    }
    if (sLobby.server.rfind("ws://", 0) != 0 && sLobby.server.rfind("wss://", 0) != 0) {
        fail("Lobby server must be a ws:// or wss:// address");
        return;
    }
    if (!port_udp_open("0.0.0.0:0")) {
        fail("Couldn't open a UDP socket");
        return;
    }
    sLobby.stun_ms = port_udp_now_ms();
    sLobby.last_stun_ms = 0;
    sLobby.last_keepalive_ms = port_udp_now_ms();
    send_stun();
    connect_server();
}

/* ---- host: starting a match ---- */

/* Why the host can't start yet (empty = it can). */
std::string start_blocker(void)
{
    if (!sLobby.is_host || sLobby.state != PORT_NETLOBBY_CONNECTED) {
        return "not ready";
    }
    int ready = 0;
    for (int i = 0; i < kMaxPlayers; i++) {
        const Peer &p = sLobby.peers[i];
        if (!p.present || p.link == LINK_FAILED) {
            continue;
        }
        if (p.link != LINK_CONNECTED) {
            return "connecting";
        }
        if (p.fkind < 0 || p.version.empty()) {
            return "picking";
        }
        ready++;
    }
    return (ready >= 1) ? std::string() : std::string("alone");
}

void refresh_status(void)
{
    std::string text;
    const int in_room = present_peers() + 1;
    const int connected = connected_peers() + 1;

    switch (sLobby.state) {
    case PORT_NETLOBBY_WAITING:
        if (present_peers() > 0) {
            text = "Room " + sLobby.code + " - connecting to " + std::to_string(present_peers()) + " player" +
                   (present_peers() > 1 ? "s" : "") + "...";
        } else {
            text = "Room " + sLobby.code + " - waiting for players to join";
        }
        break;
    case PORT_NETLOBBY_PUNCHING:
        text = (host_peer() != nullptr && host_peer()->relay_asked) ? "Direct connection failed, trying relay..." : "Connecting to the host...";
        break;
    case PORT_NETLOBBY_CONNECTED:
        if (!sLobby.note.empty() && !elapsed(sLobby.note_ms, 8000)) {
            text = sLobby.note;
        } else if (sLobby.after_match) {
            text = sLobby.is_host ? "Match over - press Start rematch to play again"
                                  : "Match over - waiting for the host to start a rematch";
        } else {
            text = std::string("Connected") + (any_relayed() ? " (via relay)" : " (direct)") + " - " +
                   std::to_string(connected) + " of " + std::to_string(in_room) + " players";
            if (sLobby.is_host) {
                std::string blocker = start_blocker();
                if (blocker.empty()) {
                    text += " - press Start match";
                } else if (blocker == "connecting") {
                    text += " - waiting for everyone to connect";
                } else {
                    text += " - waiting for everyone to pick";
                }
            } else {
                text += " - waiting for host to start";
            }
        }
        break;
    case PORT_NETLOBBY_STARTING:
        text = "Starting match...";
        break;
    default:
        return;
    }
    if (text != sLobby.status) {
        sLobby.status = text;
        port_log("SSB64 Lobby: %s\n", text.c_str());
    }
}

void update_peers(void)
{
    for (int i = 0; i < kMaxPlayers; i++) {
        Peer &p = sLobby.peers[i];
        if (!p.present || p.link == LINK_NONE || p.link == LINK_FAILED) {
            continue;
        }
        if (p.link == LINK_PUNCHING) {
            if (!p.relay_asked && (force_direct_skip(i) || elapsed(p.punch_ms, kPunchTimeoutMs))) {
                port_ws_send_text("{\"type\":\"relay\"}");
                port_udp_peer_set_relay(i, 1);
                p.relay_asked = true;
                port_log("SSB64 Lobby: direct path to player %d failed, trying relay\n", i);
            }
            if (elapsed(p.last_hello_ms, kHelloMs)) {
                const std::string hello = hello_auth::make("HELLO", sLobby.my_slot, p.tok);
                if (!force_direct_skip(i)) {
                    port_udp_peer_punch(i, hello.data(), static_cast<int>(hello.size()));
                }
                if (p.relay_asked) {
                    send_peer(i, hello);
                }
                p.last_hello_ms = port_udp_now_ms();
            }
            if (elapsed(p.punch_ms, kPunchTimeoutMs + kRelayTimeoutMs)) {
                p.link = LINK_FAILED;
                port_log("SSB64 Lobby: couldn't reach player %d\n", i);
                if (!sLobby.is_host && i == sLobby.host_slot) {
                    fail("Couldn't reach the host");
                    return;
                }
            }
        } else if (sLobby.state != PORT_NETLOBBY_IN_MATCH && elapsed(p.last_heard_ms, kPeerTimeoutMs)) {
            port_log("SSB64 Lobby: lost player %d\n", i);
            if (!sLobby.is_host && i == sLobby.host_slot) {
                fail("Lost connection to the host");
                return;
            }
            p.link = LINK_PUNCHING;
            p.punch_ms = port_udp_now_ms();
            p.relay_asked = false;
            port_udp_peer_set_relay(i, 0);
            p.fkind = -1;
            p.version.clear();
        }
    }
}

void update_state(void)
{
    if (sLobby.is_host) {
        if (sLobby.state == PORT_NETLOBBY_JOINING || sLobby.state == PORT_NETLOBBY_PUNCHING) {
            /* The host left before we reached it and we are the next one. */
            set_state(PORT_NETLOBBY_WAITING, "Room " + sLobby.code + " - waiting for players to join");
        }
        if (sLobby.state == PORT_NETLOBBY_WAITING && connected_peers() > 0) {
            set_state(PORT_NETLOBBY_CONNECTED, "Connected");
        } else if (sLobby.state == PORT_NETLOBBY_CONNECTED && connected_peers() == 0) {
            sLobby.after_match = false;
            set_state(PORT_NETLOBBY_WAITING, "Room " + sLobby.code + " - waiting for players to join");
        }
    } else {
        const Peer *host = host_peer();
        if (host != nullptr) {
            if (sLobby.state == PORT_NETLOBBY_JOINING && host->present && host->link == LINK_PUNCHING) {
                set_state(PORT_NETLOBBY_PUNCHING, "Connecting to the host...");
            }
            if ((sLobby.state == PORT_NETLOBBY_PUNCHING || sLobby.state == PORT_NETLOBBY_JOINING) && host->present &&
                host->link == LINK_CONNECTED) {
                set_state(PORT_NETLOBBY_CONNECTED, "Connected");
            }
        }
    }
    refresh_status();
}

void update_auto(void)
{
    if (!sAuto.checked) {
        sAuto.checked = true;
        if (const char *server = env("SSB64_LOBBY_HOST")) {
            sAuto.host = true;
            sAuto.server = server;
        } else if (const char *server = env("SSB64_LOBBY_JOIN")) {
            sAuto.join = true;
            sAuto.server = server;
        }
        sAuto.code_file = env("SSB64_LOBBY_CODE_FILE") ? env("SSB64_LOBBY_CODE_FILE") : "lobby_code.txt";
        sAuto.autostart = env("SSB64_LOBBY_AUTOSTART") != nullptr;
        sAuto.rematches_left = env("SSB64_LOBBY_AUTOREMATCH") ? std::atoi(env("SSB64_LOBBY_AUTOREMATCH")) : 0;
        sAuto.migrate_players = env("SSB64_LOBBY_MIGRATE_PLAYERS") ? std::max(2, std::min(kMaxPlayers, std::atoi(env("SSB64_LOBBY_MIGRATE_PLAYERS")))) : 0;
        sAuto.players = env("SSB64_LOBBY_PLAYERS") ? std::max(2, std::min(kMaxPlayers, std::atoi(env("SSB64_LOBBY_PLAYERS")))) : 2;
        int fkind = env("SSB64_LOBBY_FKIND") ? std::atoi(env("SSB64_LOBBY_FKIND"))
                                             : CVarGetInteger("gNetplay.Fighter", 0);
        int stage = env("SSB64_LOBBY_STAGE") ? std::atoi(env("SSB64_LOBBY_STAGE"))
                                             : CVarGetInteger("gNetplay.Stage", 0);
        if (const char *code = env("SSB64_LOBBY_CODE")) {
            sAuto.fixed_code = code;
            sAuto.join_deadline_ms = port_udp_now_ms() + kJoinWaitForHostMs;
        }

        if (sAuto.host) {
            std::remove(sAuto.code_file.c_str());
            port_netlobby_host(sAuto.server.c_str(), fkind, stage, 3, 0, 2);
        }
        sLobby.my_fkind = fkind;
    }
    if (sAuto.host_retry_ms != 0 && sLobby.state == PORT_NETLOBBY_CREATING && elapsed(sAuto.host_retry_ms, 0)) {
        sAuto.host_retry_ms = 0;
        connect_server();
    }
    if (sAuto.host && !sAuto.code_written && sLobby.state == PORT_NETLOBBY_WAITING) {
        if (FILE *f = std::fopen(sAuto.code_file.c_str(), "w")) {
            std::fputs(sLobby.code.c_str(), f);
            std::fclose(f);
            sAuto.code_written = true;
        }
    }
    if (sAuto.join && !sAuto.fixed_code.empty()) {
        /* RetroHub launch: everyone starts at once, so the host's room may
         * not exist yet - retry "no such room" until the deadline. */
        bool waiting = sLobby.state == PORT_NETLOBBY_FAILED && sAuto.join_no_room && !elapsed(sAuto.join_deadline_ms, 0);
        if (waiting) {
            sLobby.status = "Waiting for host... (Cancel to leave)";
        }
        bool retry = (sLobby.state == PORT_NETLOBBY_IDLE) || waiting;
        if (retry && elapsed(sAuto.join_retry_ms, 0)) {
            port_netlobby_join(sAuto.server.c_str(), sAuto.fixed_code.c_str(), sLobby.my_fkind);
            sAuto.join_retry_ms = port_udp_now_ms() + 1500;
            sAuto.join_no_room = false;
            sLobby.status = "Waiting for host... (Cancel to leave)";
        }
        if (sLobby.state != PORT_NETLOBBY_IDLE && sLobby.state != PORT_NETLOBBY_FAILED &&
            sLobby.state != PORT_NETLOBBY_JOINING) {
            sAuto.join = false;   // connected (or past the server introduction)
        }
    } else if (sAuto.join && sLobby.state == PORT_NETLOBBY_IDLE) {
        if (FILE *f = std::fopen(sAuto.code_file.c_str(), "r")) {
            char code[16] = {};
            if (std::fgets(code, sizeof(code), f) != nullptr && std::strlen(code) >= 6) {
                code[6] = '\0';
                port_netlobby_join(sAuto.server.c_str(), code, sLobby.my_fkind);
                sAuto.join = false;
            }
            std::fclose(f);
        }
    }
    /* Whoever leads the room runs the scripted start / rematches (after a host migration that is another process). */
    const int autostart_players = (sAuto.migrated && sAuto.migrate_players > 0) ? sAuto.migrate_players : sAuto.players;
    if (sLobby.is_host && sAuto.autostart && sLobby.state == PORT_NETLOBBY_CONNECTED && !sLobby.after_match &&
        port_netlobby_connected_count() >= autostart_players && port_netlobby_can_start()) {
        if (sAuto.start_after_ms == 0) {
            sAuto.start_after_ms = port_udp_now_ms() + (env("SSB64_LOBBY_START_DELAY_MS") ? (unsigned)std::atoi(env("SSB64_LOBBY_START_DELAY_MS")) : 1000u);
        } else if (elapsed(sAuto.start_after_ms, 0)) {
            port_netlobby_start_match();
            sAuto.autostart = false;
        }
    }
    if (sLobby.is_host && sAuto.rematches_left > 0 && sLobby.after_match && sLobby.state == PORT_NETLOBBY_CONNECTED &&
        port_netlobby_can_start()) {
        if (sAuto.rematch_after_ms == 0) {
            sAuto.rematch_after_ms = port_udp_now_ms() + (env("SSB64_LOBBY_REMATCH_DELAY_MS") ? (unsigned)std::atoi(env("SSB64_LOBBY_REMATCH_DELAY_MS")) : 4000u);
        } else if (elapsed(sAuto.rematch_after_ms, 0)) {
            port_netlobby_start_match();
            sAuto.rematches_left--;
            sAuto.rematch_after_ms = 0;
        }
    }
}

} // namespace

extern "C" void port_netlobby_update(void)
{
    Lobby &l = sLobby;

    update_auto();

    if (l.state == PORT_NETLOBBY_IDLE || l.state == PORT_NETLOBBY_FAILED) {
        return;
    }
    if (port_ws_state() == PORT_WS_FAILED) {
        if (l.state == PORT_NETLOBBY_IN_MATCH && !any_relayed()) {
            return;     // direct match: losing the lobby server doesn't matter
        }
        fail(sLobby.electing ? std::string("The host closed the room") : std::string("Lobby server: ") + port_ws_error());
        return;
    }
    receive();
    if (l.state == PORT_NETLOBBY_FAILED) {
        return;
    }
    if (elapsed(l.last_keepalive_ms, kKeepaliveMs)) {
        port_ws_send_text("{\"type\":\"keepalive\"}");
        l.last_keepalive_ms = port_udp_now_ms();
    }
    send_endpoint_if_ready();

    if (l.state == PORT_NETLOBBY_IN_MATCH) {
        /* The host keeps repeating BEGIN for a moment so a lost one can't
         * strand a player in the lobby. */
        if (l.is_host && !elapsed(l.begin_until_ms, 0) && elapsed(l.last_begin_ms, kStartRetryMs)) {
            for (const Member &m : l.match) {
                if (m.slot != l.my_slot) {
                    send_peer(m.slot, "SSBL BEGIN " + std::to_string(l.seed));
                }
            }
            l.last_begin_ms = port_udp_now_ms();
        }
        return;
    }
    if (l.electing && elapsed(l.electing_ms, 10000)) {
        fail("The host left the room");
        return;
    }
    if (!l.stun_done && !elapsed(l.stun_ms, kStunGiveUpMs) && elapsed(l.last_stun_ms, kStunRetryMs)) {
        send_stun();
        l.last_stun_ms = port_udp_now_ms();
    }
    if (!l.ws_welcomed && elapsed(l.connect_ms, kServerTimeoutMs) &&
        (l.state == PORT_NETLOBBY_CREATING || l.state == PORT_NETLOBBY_JOINING)) {
        fail("No answer from the lobby server");
        return;
    }
    update_peers();
    if (l.state == PORT_NETLOBBY_FAILED) {
        return;
    }
    update_state();

    /* Fighter picks, version and ping probes go to every connected player. */
    if (elapsed(l.last_pick_ms, (l.state == PORT_NETLOBBY_STARTING) ? kStartRetryMs : kPickMs)) {
        send_connected("SSBL PICK " + std::to_string(l.my_fkind) + " " + std::to_string(port_udp_now_ms()) + " " +
                       std::to_string(local_tap_jump_off()) + " " + kGameVersion);
        l.last_pick_ms = port_udp_now_ms();
    }
    if (l.state == PORT_NETLOBBY_STARTING) {
        if (l.is_host) {
            if (elapsed(l.last_start_ms, kStartRetryMs)) {
                const std::string start = start_message();
                for (const Member &m : l.match) {
                    if (m.slot != l.my_slot) {
                        send_peer(m.slot, start);
                    }
                }
                l.last_start_ms = port_udp_now_ms();
                static int start_sends = 0;
                if (test_die_at("start") && ++start_sends >= 1) {
                    die_now("start");   // clients get START, but never BEGIN
                }
            }
            bool all_go = true;
            std::string missing;
            for (const Member &m : l.match) {
                if (m.slot != l.my_slot && !l.peers[m.slot].go) {
                    all_go = false;
                    missing = "Player " + std::to_string(m.slot + 1);
                }
            }
            if (all_go) {
                begin_as_host();
            } else if (elapsed(l.state_ms, kStartTimeoutMs)) {
                abort_start(missing + " didn't respond - start cancelled");
            }
        } else if (elapsed(l.last_start_ms, kStartStaleMs)) {
            l.match.clear();
            set_state(PORT_NETLOBBY_CONNECTED, "The host didn't finish starting - waiting for the host");
        }
    }
}

extern "C" void port_netlobby_host(const char *server, int fkind, int stage, int stocks, int items, int delay)
{
    sLobby.my_fkind = fkind;
    sLobby.stage = valid_stage(stage) ? stage : 0;
    sLobby.stocks = stocks;
    sLobby.items = items;
    sLobby.delay = delay;
    sLobby.code = (!sAuto.fixed_code.empty()) ? sAuto.fixed_code : new_code();
    set_state(PORT_NETLOBBY_CREATING, "Creating room...");
    begin(true, server);
}

extern "C" void port_netlobby_join(const char *server, const char *code, int fkind)
{
    sLobby.my_fkind = fkind;
    sLobby.code = code ? code : "";
    for (char &c : sLobby.code) {
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    }
    if (sLobby.code.size() != 6) {
        fail("Room codes are 6 characters");
        return;
    }
    set_state(PORT_NETLOBBY_JOINING, "Joining room " + sLobby.code + "...");
    begin(false, server);
}

extern "C" void port_netlobby_cancel(void)
{
    sAuto.join = false;         // a cancelled "Waiting for host..." must not retry
    sAuto.host_retry_ms = 0;
    shutdown_net();
    set_state(PORT_NETLOBBY_IDLE, "Not connected");
}

extern "C" int port_netlobby_can_start(void)
{
    return start_blocker().empty() ? 1 : 0;
}

extern "C" void port_netlobby_start_match(void)
{
    sLobby.note.clear();
    if (!start_blocker().empty()) {
        return;
    }
    for (int i = 0; i < kMaxPlayers; i++) {
        if (sLobby.peers[i].present && sLobby.peers[i].link == LINK_CONNECTED && version_mismatch(i)) {
            return;
        }
    }
    /* Freeze the line-up: the host first (game slot 0), then the connected
     * joiners by lobby slot. Players with the same fighter get different costumes. */
    sLobby.match.clear();
    Member host;
    host.slot = sLobby.my_slot;
    host.fkind = sLobby.my_fkind;
    host.tap_jump_off = local_tap_jump_off();
    sLobby.match.push_back(host);
    for (int i = 0; i < kMaxPlayers; i++) {
        const Peer &p = sLobby.peers[i];
        if (i != sLobby.my_slot && p.present && p.link == LINK_CONNECTED) {
            Member m;
            m.slot = i;
            m.fkind = p.fkind;
            m.tap_jump_off = p.tap_jump_off;
            sLobby.match.push_back(m);
        }
    }
    for (size_t i = 0; i < sLobby.match.size(); i++) {
        int same = 0;
        for (size_t j = 0; j < i; j++) {
            same += (sLobby.match[j].fkind == sLobby.match[i].fkind) ? 1 : 0;
        }
        sLobby.match[i].costume = same % 4;
    }
    host_rules(&sLobby.pending_rules[0], &sLobby.pending_rules[1], &sLobby.pending_rules[2], &sLobby.pending_rules[3]);
    for (Peer &p : sLobby.peers) {
        p.go = false;
    }
    sLobby.seed = (sRng() & 0x7FFFFFFF) | 1;
    sLobby.last_start_ms = 0;
    set_state(PORT_NETLOBBY_STARTING, "Starting match...");
}

extern "C" void port_netlobby_set_fkind(int fkind)
{
    sLobby.my_fkind = fkind;
}

extern "C" void port_netlobby_set_match_note(const char *note)
{
    sLobby.match_note = note ? note : "";
}

extern "C" void port_netlobby_on_match_end(void)
{
    port_netrules_clear();
    if (sLobby.state == PORT_NETLOBBY_IN_MATCH) {
        for (Peer &p : sLobby.peers) {
            p.last_heard_ms = port_udp_now_ms();
            p.go = false;
        }
        sLobby.match.clear();
        set_state(PORT_NETLOBBY_CONNECTED, "Match over");
        sLobby.after_match = true;
        if (!sLobby.match_note.empty()) {
            set_note(sLobby.match_note);
            sLobby.match_note.clear();
        }
        refresh_status();
        if (port_ws_state() == PORT_WS_FAILED) {
            /* The lobby connection died during the match (this player may be a host the room already replaced). */
            fail(sLobby.electing ? std::string("The host closed the room") : std::string("Lobby server: ") + port_ws_error());
            return;
        }
        /* If the host dropped out mid-match, the server has already promoted the next one (see set_host):
         * whoever leads the room now starts the rematch. */
    }
}

extern "C" int port_netlobby_state(void) { return sLobby.state; }
extern "C" const char *port_netlobby_status(void) { return sLobby.status.c_str(); }
extern "C" const char *port_netlobby_code(void) { return sLobby.code.c_str(); }
extern "C" int port_netlobby_is_host(void) { return sLobby.is_host ? 1 : 0; }
extern "C" int port_netlobby_is_relay(void) { return any_relayed() ? 1 : 0; }

extern "C" int port_netlobby_ping_ms(void)
{
    int worst = -1;
    for (const Peer &p : sLobby.peers) {
        if (p.present && p.link == LINK_CONNECTED && p.ping_ms > worst) {
            worst = p.ping_ms;
        }
    }
    return worst;
}

extern "C" int port_netlobby_get_player(int slot, PortNetLobbyPlayer *out)
{
    if (!valid_slot(slot) || out == nullptr || sLobby.my_slot < 0) {
        return 0;
    }
    if (slot == sLobby.my_slot) {
        out->slot = slot;
        out->is_self = 1;
        out->is_host = sLobby.is_host ? 1 : 0;
        out->connected = 1;
        out->fkind = sLobby.my_fkind;
        out->ping_ms = -1;
        out->relay = 0;
        return 1;
    }
    const Peer &p = sLobby.peers[slot];
    if (!p.present) {
        return 0;
    }
    out->slot = slot;
    out->is_self = 0;
    out->is_host = (slot == sLobby.host_slot) ? 1 : 0;
    out->connected = (p.link == LINK_CONNECTED) ? 1 : 0;
    out->fkind = p.fkind;
    out->ping_ms = p.ping_ms;
    out->relay = port_udp_peer_is_relay(slot) ? 1 : 0;
    return 1;
}

extern "C" int port_netlobby_player_count(void)
{
    return (sLobby.my_slot >= 0) ? present_peers() + 1 : 0;
}

extern "C" int port_netlobby_connected_count(void)
{
    return (sLobby.my_slot >= 0) ? connected_peers() + 1 : 0;
}

extern "C" int port_netlobby_peer_fkind(void)
{
    for (const Peer &p : sLobby.peers) {
        if (p.present && p.link == LINK_CONNECTED && p.fkind >= 0) {
            return p.fkind;
        }
    }
    return -1;
}

extern "C" int port_netlobby_after_match(void) { return sLobby.after_match ? 1 : 0; }
extern "C" int port_netlobby_host_slot(void) { return sLobby.host_slot; }
extern "C" const char *port_netlobby_host_notice(void)
{
    if (sLobby.host_notice.empty() || elapsed(sLobby.host_notice_ms, 10000)) {
        return "";
    }
    return sLobby.host_notice.c_str();
}
extern "C" void port_netlobby_set_options(int stage, int stocks, int items, int delay)
{
    if (sLobby.is_host && sLobby.state != PORT_NETLOBBY_IN_MATCH && sLobby.state != PORT_NETLOBBY_STARTING) {
        sLobby.stage = valid_stage(stage) ? stage : sLobby.stage;
        sLobby.stocks = std::max(1, std::min(99, stocks));
        sLobby.items = items != 0;
        sLobby.delay = std::max(0, std::min(16, delay));
    }
}
extern "C" int port_netlobby_my_fkind(void) { return sLobby.my_fkind; }
extern "C" int port_netlobby_stage(void) { return sLobby.stage; }
extern "C" void port_netlobby_set_stage(int stage)
{
    if (sLobby.is_host && valid_stage(stage) && sLobby.state != PORT_NETLOBBY_IN_MATCH &&
        sLobby.state != PORT_NETLOBBY_STARTING) {
        sLobby.stage = stage;
    }
}
extern "C" int port_netlobby_auto_active(void) { return (sAuto.host || !sAuto.fixed_code.empty()) ? 1 : 0; }
