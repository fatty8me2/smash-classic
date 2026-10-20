/* See netlobby.h.
 *
 * Lobby server: server/cloudflare (Cloudflare Worker + Durable Object),
 * reached over WebSocket: wss://<worker>/ws?room=CODE&role=host|join.
 * The game's UDP endpoint is learned from Cloudflare's public STUN server
 * and exchanged through the Worker; the players then hole-punch a direct
 * UDP path. If that fails the Worker relays game packets over the
 * WebSocket.
 *
 * Peer-to-peer lobby messages ("SSBL" lines, over direct UDP or relay):
 *   SSBL HELLO | SSBL HELLOACK                punch / keepalive
 *   SSBL PICK <fkind> <time_ms> <tapjump_off> <version>
 *                                             character pick + RTT probe + own tap-jump setting + game version
 *   SSBL PONG <time_ms>                       immediate echo of a PICK's time
 *   SSBL START <stage> <stocks> <items> <seed> <delay> <hostfk> <hostcos> <clientfk> <clientcos>
 *              <autoz> <comp> <neutral> <hazards_off> <host_tapjump_off> <client_tapjump_off>
 *   SSBL GO <seed>                            client accepted START */
#include "netlobby.h"
#include "port_udp.h"
#include "port_ws.h"
#include "port_log.h"
#include "netrules.h"

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

extern "C" void syNetPeerStartOnlineMatch(int is_host, unsigned int delay, unsigned int stage, unsigned int stocks,
                                          int is_items, unsigned int seed, int host_fkind, int host_costume,
                                          int client_fkind, int client_costume);

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
constexpr unsigned int kPeerTimeoutMs = 10000;
constexpr int kMaxCodeRetries = 4;

struct Lobby {
    PortNetLobbyState state = PORT_NETLOBBY_IDLE;
    bool is_host = false;
    std::string server;                     // ws(s)://host[:port]
    std::string code;
    std::string status = "Not connected";
    std::string stun_public = "-";          // our public UDP endpoint from STUN
    bool stun_done = false;
    uint8_t stun_txid[12] = {};
    bool ws_welcomed = false;
    bool endpoint_sent = false;
    int code_retries = 0;
    std::vector<std::string> candidates;    // peer public + LAN endpoints
    std::string peer;                       // chosen endpoint, or "relay"
    bool relay_requested = false;
    unsigned int state_ms = 0;
    unsigned int stun_ms = 0;
    unsigned int last_send_ms = 0;
    unsigned int last_keepalive_ms = 0;
    unsigned int last_heard_ms = 0;
    int my_fkind = 0;
    int peer_fkind = -1;
    int peer_tap_jump_off = 0;
    std::string peer_version;       // from PICK; "" = not heard yet, "old" = a build that predates the field
    bool after_match = false;       // an online match ended; players are back in their own menus
    int stage = 0;
    int stocks = 3;
    int items = 0;
    int delay = 2;
    unsigned int seed = 0;
    int ping_ms = -1;
};

Lobby sLobby;
std::mt19937 sRng{ std::random_device{}() };

/* Unattended testing (scripts/netplay_lobbytest.ps1):
 *   SSB64_LOBBY_HOST=<server url>  host a room; writes the code to SSB64_LOBBY_CODE_FILE
 *   SSB64_LOBBY_JOIN=<server url>  join the code read from SSB64_LOBBY_CODE_FILE
 *   SSB64_LOBBY_FKIND / SSB64_LOBBY_STAGE / SSB64_LOBBY_AUTOSTART=1
 *   SSB64_LOBBY_AUTOREMATCH=<n>   host starts n rematches, each a few seconds after a match ends
 *   SSB64_LOBBY_FORCE_RELAY=1      skip the direct path (tests the relay)
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
    int rematches_left = 0;
    unsigned int rematch_after_ms = 0;
    std::string fixed_code;          // SSB64_LOBBY_CODE
    unsigned int join_deadline_ms = 0;
    unsigned int join_retry_ms = 0;
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

void set_state(PortNetLobbyState state, const std::string &status)
{
    if (state == PORT_NETLOBBY_IN_MATCH || state == PORT_NETLOBBY_IDLE || state == PORT_NETLOBBY_FAILED) {
        sLobby.after_match = false;
    }
    sLobby.state = state;
    sLobby.status = status;
    sLobby.state_ms = port_udp_now_ms();
    sLobby.last_send_ms = 0;
    port_log("SSB64 Lobby: %s\n", status.c_str());
}

void shutdown_net(void)
{
    port_netrules_clear();
    port_udp_set_relay_hooks(nullptr, nullptr);
    port_ws_close();
    port_udp_close();
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
    url += "/ws?room=" + sLobby.code + "&role=" + (sLobby.is_host ? "host" : "join");
    sLobby.ws_welcomed = false;
    sLobby.endpoint_sent = false;
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

/* ---- peer (SSBL over direct UDP or relay) ---- */

void send_peer(const std::string &text)
{
    port_udp_send(text.data(), static_cast<int>(text.size()));
}

void connect_to(const std::string &endpoint)
{
    sLobby.peer = endpoint;
    if (endpoint != "relay") {
        port_udp_set_relay_hooks(nullptr, nullptr);     // a direct path beats the relay
        port_udp_set_peer(endpoint.c_str());
    }
    sLobby.last_heard_ms = port_udp_now_ms();
    set_state(PORT_NETLOBBY_CONNECTED,
              std::string("Connected") + (endpoint == "relay" ? " (via relay)" : " (direct)") +
              (sLobby.is_host ? " - press Start match" : " - waiting for host to start"));
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

std::string start_message(void)
{
    char text[200];
    int autoz, comp, neutral, hazards_off;
    int client_costume = (sLobby.peer_fkind == sLobby.my_fkind) ? 1 : 0;   // same fighter: tell them apart
    host_rules(&autoz, &comp, &neutral, &hazards_off);
    std::snprintf(text, sizeof(text), "SSBL START %d %d %d %u %d %d %d %d %d %d %d %d %d %d %d", sLobby.stage,
                  sLobby.stocks, sLobby.items, sLobby.seed, sLobby.delay, sLobby.my_fkind, 0, sLobby.peer_fkind,
                  client_costume, autoz, comp, neutral, hazards_off, local_tap_jump_off(), sLobby.peer_tap_jump_off);
    return text;
}

#ifdef BATTLESHIP_CURRENT_VERSION
const char *const kGameVersion = BATTLESHIP_CURRENT_VERSION;
#else
const char *const kGameVersion = "dev";
#endif

/* Two different builds can simulate the same inputs differently, so an online
 * match only starts when both players run the same version. */
bool version_mismatch()
{
    if (sLobby.peer_version.empty() || sLobby.peer_version == kGameVersion) {
        return false;
    }
    const std::string theirs = (sLobby.peer_version == "old") ? std::string("an older version") : sLobby.peer_version;
    set_state(PORT_NETLOBBY_CONNECTED, std::string("Can't start: you're on ") + kGameVersion + ", your opponent is on " +
              theirs + ". Both players need to update to the same version.");
    return true;
}

void start_as_client(const std::vector<std::string> &args)
{
    if (args.size() < 11) {
        return;
    }
    if (version_mismatch()) {
        return;
    }
    unsigned int stage = std::strtoul(args[2].c_str(), nullptr, 10);
    unsigned int stocks = std::strtoul(args[3].c_str(), nullptr, 10);
    int items = std::atoi(args[4].c_str());
    unsigned int seed = std::strtoul(args[5].c_str(), nullptr, 10);
    unsigned int delay = std::strtoul(args[6].c_str(), nullptr, 10);
    int hostfk = std::atoi(args[7].c_str()), hostcos = std::atoi(args[8].c_str());
    int clientfk = std::atoi(args[9].c_str()), clientcos = std::atoi(args[10].c_str());

    if (args.size() >= 17) {
        port_netrules_set(std::atoi(args[11].c_str()), std::atoi(args[12].c_str()), std::atoi(args[13].c_str()),
                          std::atoi(args[14].c_str()), std::atoi(args[15].c_str()), std::atoi(args[16].c_str()));
    } else {
        port_netrules_set(0, 0, 0, 0, 0, 0);    // older host: stock rules on both sides
    }

    /* netpeer owns the receive side once the match starts, so acknowledge
     * redundantly now (the host retransmits START until it sees GO). */
    std::string go = "SSBL GO " + std::to_string(seed);
    for (int i = 0; i < 5; i++) {
        send_peer(go);
    }
    set_state(PORT_NETLOBBY_IN_MATCH, "In match");
    syNetPeerStartOnlineMatch(0, delay, stage, stocks, items, seed, hostfk, hostcos, clientfk, clientcos);
}

void start_as_host(void)
{
    int client_costume = (sLobby.peer_fkind == sLobby.my_fkind) ? 1 : 0;
    int autoz, comp, neutral, hazards_off;

    host_rules(&autoz, &comp, &neutral, &hazards_off);
    port_netrules_set(autoz, comp, neutral, hazards_off, local_tap_jump_off(), sLobby.peer_tap_jump_off);
    set_state(PORT_NETLOBBY_IN_MATCH, "In match");
    syNetPeerStartOnlineMatch(1, sLobby.delay, sLobby.stage, sLobby.stocks, sLobby.items, sLobby.seed,
                              sLobby.my_fkind, 0, sLobby.peer_fkind, client_costume);
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

void handle_peer(const std::vector<std::string> &args, const std::string &from)
{
    if (args.size() < 2) {
        return;
    }
    sLobby.last_heard_ms = port_udp_now_ms();

    if (sLobby.state == PORT_NETLOBBY_PUNCHING && (args[1] == "HELLO" || args[1] == "HELLOACK")) {
        connect_to(from);
        send_peer("SSBL HELLOACK");
        return;
    }
    if (args[1] == "HELLO") {
        send_peer("SSBL HELLOACK");
    } else if (args[1] == "PICK" && args.size() >= 3) {
        sLobby.peer_fkind = std::atoi(args[2].c_str());
        if (args.size() >= 4) {
            send_peer("SSBL PONG " + args[3]);
        }
        sLobby.peer_tap_jump_off = (args.size() >= 5) ? (std::atoi(args[4].c_str()) != 0) : 0;
        sLobby.peer_version = (args.size() >= 6) ? args[5] : "old";
    } else if (args[1] == "PONG" && args.size() >= 3) {
        sLobby.ping_ms = static_cast<int>(port_udp_now_ms() - std::strtoul(args[2].c_str(), nullptr, 10));
    } else if (args[1] == "START" && !sLobby.is_host && sLobby.state == PORT_NETLOBBY_CONNECTED) {
        start_as_client(args);
    } else if (args[1] == "GO" && sLobby.is_host && sLobby.state == PORT_NETLOBBY_STARTING) {
        start_as_host();
    }
}

void handle_server(const std::string &msg)
{
    std::string type = json_field(msg, "type");

    if (type == "welcome") {
        sLobby.ws_welcomed = true;
        if (sLobby.is_host) {
            set_state(PORT_NETLOBBY_WAITING, "Room " + sLobby.code + " - waiting for a player to join");
        } else {
            sLobby.status = "Joined room " + sLobby.code + " - contacting host...";
        }
    } else if (type == "peer") {
        if (sLobby.state == PORT_NETLOBBY_WAITING || sLobby.state == PORT_NETLOBBY_JOINING ||
            sLobby.state == PORT_NETLOBBY_CREATING) {
            sLobby.candidates.clear();
            for (const char *key : { "public", "local" }) {
                std::string endpoint = json_field(msg, key);
                if (!endpoint.empty() && endpoint != "-" &&
                    std::find(sLobby.candidates.begin(), sLobby.candidates.end(), endpoint) == sLobby.candidates.end()) {
                    sLobby.candidates.push_back(endpoint);
                }
            }
            sLobby.relay_requested = false;
            set_state(PORT_NETLOBBY_PUNCHING, "Connecting to opponent...");
        }
    } else if (type == "relaying") {
        port_udp_set_relay_hooks(relay_send, relay_recv);
        sLobby.peer = "relay";
        sLobby.status = "Connecting through relay...";
    } else if (type == "peer_left") {
        if (sLobby.state != PORT_NETLOBBY_IN_MATCH) {
            if (sLobby.is_host) {
                port_udp_set_relay_hooks(nullptr, nullptr);
                sLobby.peer.clear();
                sLobby.peer_fkind = -1;
                sLobby.peer_version.clear();
                set_state(PORT_NETLOBBY_WAITING, "Opponent left - room " + sLobby.code + " is open again");
            } else {
                fail("The host closed the room");
            }
        }
    } else if (type == "error") {
        std::string reason = json_field(msg, "reason");
        if (reason == "room-in-use" && sLobby.is_host && sLobby.code_retries++ < kMaxCodeRetries) {
            sLobby.code = new_code();
            connect_server();
        } else if (reason == "no-such-room") {
            fail("No room with code " + sLobby.code);
        } else if (reason == "room-full") {
            fail("Room " + sLobby.code + " already has two players");
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
        int size = port_udp_recv_from(buffer, sizeof(buffer) - 1, from, sizeof(from));
        if (size <= 0) {
            return;
        }
        if (parse_stun(buffer, size)) {
            continue;
        }
        buffer[size] = '\0';
        std::vector<std::string> args = split(reinterpret_cast<const char *>(buffer));
        if (!args.empty() && args[0] == "SSBL") {
            handle_peer(args, from);
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
    sLobby.server = server ? server : "";
    sLobby.stun_public = "-";
    sLobby.stun_done = false;
    sLobby.code_retries = 0;
    sLobby.peer.clear();
    sLobby.candidates.clear();
    sLobby.peer_fkind = -1;
    sLobby.peer_version.clear();
    sLobby.ping_ms = -1;
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
    sLobby.last_keepalive_ms = port_udp_now_ms();
    send_stun();
    connect_server();
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
        int fkind = env("SSB64_LOBBY_FKIND") ? std::atoi(env("SSB64_LOBBY_FKIND"))
                                             : CVarGetInteger("gNetplay.Fighter", 0);
        int stage = env("SSB64_LOBBY_STAGE") ? std::atoi(env("SSB64_LOBBY_STAGE"))
                                             : CVarGetInteger("gNetplay.Stage", 0);
        if (const char *code = env("SSB64_LOBBY_CODE")) {
            sAuto.fixed_code = code;
            sAuto.join_deadline_ms = port_udp_now_ms() + 30000;
        }

        if (sAuto.host) {
            std::remove(sAuto.code_file.c_str());
            port_netlobby_host(sAuto.server.c_str(), fkind, stage, 3, 0, 2);
        }
        sLobby.my_fkind = fkind;
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
        bool retry = (sLobby.state == PORT_NETLOBBY_IDLE) ||
                     (sLobby.state == PORT_NETLOBBY_FAILED && !elapsed(sAuto.join_deadline_ms, 0));
        if (retry && elapsed(sAuto.join_retry_ms, 0)) {
            port_netlobby_join(sAuto.server.c_str(), sAuto.fixed_code.c_str(), sLobby.my_fkind);
            sAuto.join_retry_ms = port_udp_now_ms() + 1500;
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
    if (sAuto.host && sAuto.autostart && sLobby.state == PORT_NETLOBBY_CONNECTED && sLobby.peer_fkind >= 0) {
        if (sAuto.start_after_ms == 0) {
            sAuto.start_after_ms = port_udp_now_ms() + 1000;
        } else if (elapsed(sAuto.start_after_ms, 0)) {
            port_netlobby_start_match();
            sAuto.autostart = false;
        }
    }
    if (sAuto.host && sAuto.rematches_left > 0 && sLobby.after_match && sLobby.state == PORT_NETLOBBY_CONNECTED) {
        if (sAuto.rematch_after_ms == 0) {
            sAuto.rematch_after_ms = port_udp_now_ms() + 4000;
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
        if (l.state == PORT_NETLOBBY_IN_MATCH && l.peer != "relay") {
            return;     // direct match: losing the lobby server doesn't matter
        }
        fail(std::string("Lobby server: ") + port_ws_error());
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

    switch (l.state) {
    case PORT_NETLOBBY_CREATING:
    case PORT_NETLOBBY_JOINING:
    case PORT_NETLOBBY_WAITING:
        if (!l.stun_done && !elapsed(l.stun_ms, kStunGiveUpMs) && elapsed(l.last_send_ms, kStunRetryMs)) {
            send_stun();
            l.last_send_ms = port_udp_now_ms();
        }
        if (l.state != PORT_NETLOBBY_WAITING && !l.ws_welcomed && elapsed(l.state_ms, kServerTimeoutMs)) {
            fail("No answer from the lobby server");
        }
        break;

    case PORT_NETLOBBY_PUNCHING:
        if (!l.relay_requested && (env("SSB64_LOBBY_FORCE_RELAY") != nullptr || elapsed(l.state_ms, kPunchTimeoutMs))) {
            port_ws_send_text("{\"type\":\"relay\"}");
            l.relay_requested = true;
            l.status = "Direct connection failed, trying relay...";
        }
        if (elapsed(l.last_send_ms, kHelloMs)) {
            if (l.peer == "relay") {
                send_peer("SSBL HELLO");
            } else if (env("SSB64_LOBBY_FORCE_RELAY") == nullptr) {
                for (const std::string &candidate : l.candidates) {
                    port_udp_send_to(candidate.c_str(), "SSBL HELLO", 10);
                }
            }
            l.last_send_ms = port_udp_now_ms();
        }
        if (elapsed(l.state_ms, kPunchTimeoutMs + kRelayTimeoutMs)) {
            fail("Couldn't reach the other player");
        }
        break;

    case PORT_NETLOBBY_CONNECTED:
    case PORT_NETLOBBY_STARTING:
        if (elapsed(l.last_send_ms, (l.state == PORT_NETLOBBY_STARTING) ? kStartRetryMs : kPickMs)) {
            send_peer("SSBL PICK " + std::to_string(l.my_fkind) + " " + std::to_string(port_udp_now_ms()) + " " +
                      std::to_string(local_tap_jump_off()) + " " + kGameVersion);
            if (l.state == PORT_NETLOBBY_STARTING) {
                send_peer(start_message());
            }
            l.last_send_ms = port_udp_now_ms();
        }
        if (elapsed(l.last_heard_ms, kPeerTimeoutMs)) {
            fail("Lost connection to the other player");
        }
        break;

    default:
        break;
    }
}

extern "C" void port_netlobby_host(const char *server, int fkind, int stage, int stocks, int items, int delay)
{
    sLobby.my_fkind = fkind;
    sLobby.stage = stage;
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
    shutdown_net();
    set_state(PORT_NETLOBBY_IDLE, "Not connected");
}

extern "C" void port_netlobby_start_match(void)
{
    if (!sLobby.is_host || sLobby.state != PORT_NETLOBBY_CONNECTED || sLobby.peer_fkind < 0) {
        return;
    }
    if (version_mismatch()) {
        return;
    }
    sLobby.seed = (sRng() & 0x7FFFFFFF) | 1;
    set_state(PORT_NETLOBBY_STARTING, "Starting match...");
}

extern "C" void port_netlobby_set_fkind(int fkind)
{
    sLobby.my_fkind = fkind;
}

extern "C" void port_netlobby_on_match_end(void)
{
    port_netrules_clear();
    if (sLobby.state == PORT_NETLOBBY_IN_MATCH) {
        sLobby.last_heard_ms = port_udp_now_ms();
        set_state(PORT_NETLOBBY_CONNECTED, std::string("Match over") +
                  (sLobby.is_host ? " - press Start rematch to play again" : " - waiting for the host to start a rematch"));
        sLobby.after_match = true;
    }
}

extern "C" int port_netlobby_state(void) { return sLobby.state; }
extern "C" const char *port_netlobby_status(void) { return sLobby.status.c_str(); }
extern "C" const char *port_netlobby_code(void) { return sLobby.code.c_str(); }
extern "C" int port_netlobby_peer_fkind(void) { return sLobby.peer_fkind; }
extern "C" int port_netlobby_is_host(void) { return sLobby.is_host ? 1 : 0; }
extern "C" int port_netlobby_is_relay(void) { return port_udp_is_relay(); }
extern "C" int port_netlobby_ping_ms(void) { return sLobby.ping_ms; }
extern "C" int port_netlobby_after_match(void) { return sLobby.after_match ? 1 : 0; }
extern "C" int port_netlobby_my_fkind(void) { return sLobby.my_fkind; }
extern "C" int port_netlobby_stage(void) { return sLobby.stage; }
extern "C" void port_netlobby_set_stage(int stage)
{
    if (sLobby.is_host && sLobby.state != PORT_NETLOBBY_IN_MATCH && sLobby.state != PORT_NETLOBBY_STARTING) {
        sLobby.stage = stage;
    }
}
extern "C" int port_netlobby_auto_active(void) { return (sAuto.host || !sAuto.fixed_code.empty()) ? 1 : 0; }
