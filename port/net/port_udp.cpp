/* See port_udp.h. */
#include "port_udp.h"
#include "port_log.h"

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <deque>
#include <random>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mstcpip.h>
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET _WSAIOW(IOC_VENDOR, 12)
#endif
typedef SOCKET PortSocket;
static const PortSocket kInvalidSocket = INVALID_SOCKET;
static int port_udp_last_error(void) { return WSAGetLastError(); }
static bool port_udp_would_block(int err) { return err == WSAEWOULDBLOCK; }
static void port_udp_close_socket(PortSocket s) { closesocket(s); }
#else
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int PortSocket;
static const PortSocket kInvalidSocket = -1;
static int port_udp_last_error(void) { return errno; }
static bool port_udp_would_block(int err) { return err == EAGAIN || err == EWOULDBLOCK; }
static void port_udp_close_socket(PortSocket s) { close(s); }
#endif

namespace {

/* A direct packet this recent keeps a peer on the direct path even if the
 * other side relays to us (asymmetric NATs); older than this and a relayed
 * frame from the peer flips us to the relay as well. */
constexpr unsigned int kDirectFreshMs = 2000;

struct PendingPacket {
    unsigned int release_ms;
    int peer;
    std::vector<uint8_t> bytes;
};

struct Peer {
    sockaddr_in candidates[PORT_UDP_MAX_CANDIDATES];
    int candidate_count = 0;
    sockaddr_in chosen;             /* where its datagrams last came from */
    bool has_chosen = false;
    bool relay = false;             /* send through the relay hooks */
    unsigned int last_direct_ms = 0;
};

PortSocket sSocket = kInvalidSocket;
Peer sPeers[PORT_UDP_MAX_PEERS];

/* Relay fallback: game packets travel through the lobby server instead of
 * UDP (port/net/netlobby.cpp installs WebSocket send/receive hooks). */
port_udp_relay_send_fn sRelaySend = nullptr;
port_udp_relay_recv_fn sRelayRecv = nullptr;

/* Network simulator (send side). */
unsigned int sSimLatencyMs = 0;
unsigned int sSimJitterMs = 0;
unsigned int sSimLossPct = 0;
std::mt19937 sSimRng(1);
std::deque<PendingPacket> sSimQueue;
bool sSimConfigured = false;

unsigned int env_uint(const char *name, unsigned int fallback)
{
    const char *value = std::getenv(name);
    return (value != nullptr) ? static_cast<unsigned int>(std::strtoul(value, nullptr, 10)) : fallback;
}

void configure_sim(void)
{
    if (sSimConfigured) {
        return;
    }
    sSimConfigured = true;
    sSimLatencyMs = env_uint("SSB64_NETPLAY_SIM_LATENCY_MS", 0);
    sSimJitterMs = env_uint("SSB64_NETPLAY_SIM_JITTER_MS", 0);
    sSimLossPct = env_uint("SSB64_NETPLAY_SIM_LOSS_PCT", 0);
    sSimRng.seed(env_uint("SSB64_NETPLAY_SIM_SEED", 1));

    if (sSimLatencyMs || sSimJitterMs || sSimLossPct) {
        port_log("SSB64 UDP: simulating latency=%ums jitter=%ums loss=%u%%\n",
                 sSimLatencyMs, sSimJitterMs, sSimLossPct);
    }
}

bool startup(void)
{
#if defined(_WIN32)
    static bool sStarted = false;
    if (!sStarted) {
        WSADATA data;
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
            port_log("SSB64 UDP: WSAStartup failed\n");
            return false;
        }
        sStarted = true;
    }
#endif
    return true;
}

bool valid_peer(int peer)
{
    return peer >= 0 && peer < PORT_UDP_MAX_PEERS;
}

/* "host:port" -> sockaddr_in. "*" / "0.0.0.0" -> INADDR_ANY. Hostnames resolve. */
bool parse_address(const char *spec, sockaddr_in *out)
{
    if (spec == nullptr) {
        return false;
    }
    std::string text(spec);
    size_t colon = text.rfind(':');
    if (colon == std::string::npos || colon == 0 || colon + 1 >= text.size()) {
        return false;
    }
    std::string host = text.substr(0, colon);
    long port = std::strtol(text.c_str() + colon + 1, nullptr, 10);
    if (port < 0 || port > 65535) {     /* 0 = let the OS pick (bind only) */
        return false;
    }
    std::memset(out, 0, sizeof(*out));
    out->sin_family = AF_INET;
    out->sin_port = htons(static_cast<uint16_t>(port));

    if (host == "*" || host == "0.0.0.0") {
        out->sin_addr.s_addr = htonl(INADDR_ANY);
        return true;
    }
    if (inet_pton(AF_INET, host.c_str(), &out->sin_addr) == 1) {
        return true;
    }
    addrinfo hints;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    addrinfo *result = nullptr;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &result) != 0 || result == nullptr) {
        return false;
    }
    out->sin_addr = reinterpret_cast<sockaddr_in *>(result->ai_addr)->sin_addr;
    freeaddrinfo(result);
    return true;
}

bool same_endpoint(const sockaddr_in &a, const sockaddr_in &b)
{
    return a.sin_addr.s_addr == b.sin_addr.s_addr && a.sin_port == b.sin_port;
}

int raw_send_to(const sockaddr_in &to, const uint8_t *data, int size)
{
    int sent = sendto(sSocket, reinterpret_cast<const char *>(data), size, 0,
                      reinterpret_cast<const sockaddr *>(&to), sizeof(to));
    return (sent == size) ? size : -1;
}

/* Game traffic to one peer: direct UDP, or through the relay hook. */
int raw_send_peer(int peer, const uint8_t *data, int size)
{
    Peer &p = sPeers[peer];

    if (p.relay && sRelaySend != nullptr) {
        std::vector<uint8_t> frame(static_cast<size_t>(size) + 1);
        frame[0] = static_cast<uint8_t>(peer);
        std::memcpy(frame.data() + 1, data, size);
        return sRelaySend(frame.data(), size + 1) ? size : -1;
    }
    if (p.has_chosen) {
        return raw_send_to(p.chosen, data, size);
    }
    /* Not heard from yet: try every address we know. */
    int result = -1;
    for (int i = 0; i < p.candidate_count; i++) {
        if (raw_send_to(p.candidates[i], data, size) == size) {
            result = size;
        }
    }
    return result;
}

int find_peer(const sockaddr_in &from)
{
    for (int i = 0; i < PORT_UDP_MAX_PEERS; i++) {
        const Peer &p = sPeers[i];

        if (p.has_chosen && same_endpoint(from, p.chosen)) {
            return i;
        }
    }
    for (int i = 0; i < PORT_UDP_MAX_PEERS; i++) {
        const Peer &p = sPeers[i];

        for (int c = 0; c < p.candidate_count; c++) {
            if (same_endpoint(from, p.candidates[c])) {
                return i;
            }
        }
    }
    return -1;
}

/* Receives one datagram. *peer is the sender (-1 for strangers); *relayed is
 * set for frames unwrapped from the server relay. Returns size, 0 none, -1
 * error. Relayed packets come first so the relay can't be starved by stray
 * UDP. */
int raw_recv(void *buffer, int capacity, sockaddr_in *from, int *peer, bool *relayed)
{
    *relayed = false;
    *peer = -1;
    std::memset(from, 0, sizeof(*from));

    if (sRelayRecv != nullptr) {
        uint8_t frame[2048];
        int size = sRelayRecv(frame, sizeof(frame));

        if (size > 1 && valid_peer(frame[0]) && size - 1 <= capacity) {
            Peer &p = sPeers[frame[0]];

            *relayed = true;
            *peer = frame[0];
            std::memcpy(buffer, frame + 1, size - 1);

            /* The peer is sending through the relay. Unless a direct packet
             * arrived from it a moment ago, answer the same way. */
            if (!p.relay && static_cast<int>(port_udp_now_ms() - p.last_direct_ms) >= static_cast<int>(kDirectFreshMs)) {
                p.relay = true;
                port_log("SSB64 UDP: peer %d is using the relay; answering through it\n", frame[0]);
            }
            return size - 1;
        }
    }
#if defined(_WIN32)
    int from_len = sizeof(*from);
#else
    socklen_t from_len = sizeof(*from);
#endif
    /* Receive into a full-size buffer: on Windows a datagram larger than the
     * caller's buffer fails recvfrom outright (WSAEMSGSIZE) instead of
     * truncating, which would wedge the socket on one stray packet. */
    uint8_t bytes[2048];
    int size = recvfrom(sSocket, reinterpret_cast<char *>(bytes), sizeof(bytes), 0,
                        reinterpret_cast<sockaddr *>(from), &from_len);
    if (size < 0) {
        int err = port_udp_last_error();
        return port_udp_would_block(err) ? 0 : -1;
    }
    *peer = find_peer(*from);
    if (size > capacity) {
        return -1;  /* not one of ours: every protocol datagram fits its caller's buffer */
    }
    if (*peer >= 0) {
        Peer &p = sPeers[*peer];

        p.chosen = *from;
        p.has_chosen = true;
        p.last_direct_ms = port_udp_now_ms();
        if (p.relay) {
            p.relay = false;
            port_log("SSB64 UDP: peer %d reachable directly again\n", *peer);
        }
    }
    std::memcpy(buffer, bytes, size);
    return size;
}

void flush_sim_queue(void)
{
    unsigned int now = port_udp_now_ms();
    while (!sSimQueue.empty() && static_cast<int>(now - sSimQueue.front().release_ms) >= 0) {
        raw_send_peer(sSimQueue.front().peer, sSimQueue.front().bytes.data(),
                      static_cast<int>(sSimQueue.front().bytes.size()));
        sSimQueue.pop_front();
    }
}

void text_of(const sockaddr_in &addr, char *out, int capacity)
{
    char ip[INET_ADDRSTRLEN] = "?";
    inet_ntop(AF_INET, &addr.sin_addr, ip, sizeof(ip));
    std::snprintf(out, capacity, "%s:%u", ip, static_cast<unsigned>(ntohs(addr.sin_port)));
}

} // namespace

extern "C" int port_udp_open(const char *bind_spec)
{
    sockaddr_in bind_addr;

    configure_sim();

    if (sSocket != kInvalidSocket) {
        return 1;
    }
    if (!startup()) {
        return 0;
    }
    if (!parse_address(bind_spec, &bind_addr)) {
        port_log("SSB64 UDP: invalid bind address '%s' (expected host:port)\n", bind_spec ? bind_spec : "(null)");
        return 0;
    }
    sSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sSocket == kInvalidSocket) {
        port_log("SSB64 UDP: socket failed err=%d\n", port_udp_last_error());
        return 0;
    }
    if (bind(sSocket, reinterpret_cast<const sockaddr *>(&bind_addr), sizeof(bind_addr)) != 0) {
        port_log("SSB64 UDP: bind %s failed err=%d\n", bind_spec, port_udp_last_error());
        port_udp_close();
        return 0;
    }
#if defined(_WIN32)
    u_long nonblocking = 1;
    if (ioctlsocket(sSocket, FIONBIO, &nonblocking) != 0) {
        port_log("SSB64 UDP: nonblocking setup failed err=%d\n", port_udp_last_error());
        port_udp_close();
        return 0;
    }
    /* Without this, an ICMP port-unreachable from a peer that isn't up yet
     * makes the next recvfrom fail with WSAECONNRESET. */
    BOOL report_reset = FALSE;
    DWORD returned = 0;
    WSAIoctl(sSocket, SIO_UDP_CONNRESET, &report_reset, sizeof(report_reset), nullptr, 0, &returned, nullptr, nullptr);
#else
    int flags = fcntl(sSocket, F_GETFL, 0);
    if (flags < 0 || fcntl(sSocket, F_SETFL, flags | O_NONBLOCK) != 0) {
        port_log("SSB64 UDP: nonblocking setup failed err=%d\n", port_udp_last_error());
        port_udp_close();
        return 0;
    }
#endif
    return 1;
}

extern "C" void port_udp_close(void)
{
    if (sSocket != kInvalidSocket) {
        port_udp_close_socket(sSocket);
        sSocket = kInvalidSocket;
    }
    sSimQueue.clear();
    sRelaySend = nullptr;
    sRelayRecv = nullptr;
    port_udp_peers_clear();
}

extern "C" int port_udp_is_open(void)
{
    return sSocket != kInvalidSocket;
}

extern "C" void port_udp_peers_clear(void)
{
    for (int i = 0; i < PORT_UDP_MAX_PEERS; i++) {
        port_udp_peer_clear(i);
    }
}

extern "C" void port_udp_peer_clear(int peer)
{
    if (!valid_peer(peer)) {
        return;
    }
    sPeers[peer] = Peer();
    /* Packets still queued by the simulator for it are moot. */
    for (auto it = sSimQueue.begin(); it != sSimQueue.end();) {
        it = (it->peer == peer) ? sSimQueue.erase(it) : it + 1;
    }
}

extern "C" int port_udp_peer_add_candidate(int peer, const char *spec)
{
    sockaddr_in addr;

    if (!valid_peer(peer) || !startup() || !parse_address(spec, &addr) || addr.sin_addr.s_addr == htonl(INADDR_ANY) ||
        addr.sin_port == 0) {
        port_log("SSB64 UDP: invalid peer address '%s' (expected host:port)\n", spec ? spec : "(null)");
        return 0;
    }
    Peer &p = sPeers[peer];

    for (int i = 0; i < p.candidate_count; i++) {
        if (same_endpoint(p.candidates[i], addr)) {
            return 1;
        }
    }
    if (p.candidate_count >= PORT_UDP_MAX_CANDIDATES) {
        return 0;
    }
    p.candidates[p.candidate_count++] = addr;
    return 1;
}

extern "C" int port_udp_peer_set(int peer, const char *spec)
{
    port_udp_peer_clear(peer);
    return port_udp_peer_add_candidate(peer, spec);
}

extern "C" int port_udp_peer_has_candidates(int peer)
{
    return valid_peer(peer) && sPeers[peer].candidate_count > 0;
}

extern "C" int port_udp_peer_is_direct(int peer)
{
    return valid_peer(peer) && sPeers[peer].has_chosen && !sPeers[peer].relay;
}

extern "C" void port_udp_peer_set_relay(int peer, int relay)
{
    if (valid_peer(peer)) {
        sPeers[peer].relay = relay != 0;
    }
}

extern "C" int port_udp_peer_is_relay(int peer)
{
    return valid_peer(peer) && sPeers[peer].relay && sRelaySend != nullptr;
}

extern "C" int port_udp_peer_send(int peer, const void *data, int size)
{
    if (sSocket == kInvalidSocket || !valid_peer(peer) || data == nullptr || size <= 0) {
        return -1;
    }
    Peer &p = sPeers[peer];

    if (p.candidate_count == 0 && !p.has_chosen && !(p.relay && sRelaySend != nullptr)) {
        return -1;
    }
    const uint8_t *bytes = static_cast<const uint8_t *>(data);

    if (sSimLossPct != 0 && (sSimRng() % 100u) < sSimLossPct) {
        return size;
    }
    if (sSimLatencyMs == 0 && sSimJitterMs == 0) {
        return raw_send_peer(peer, bytes, size);
    }
    unsigned int delay = sSimLatencyMs + ((sSimJitterMs != 0) ? (sSimRng() % (sSimJitterMs + 1)) : 0);
    PendingPacket packet{ port_udp_now_ms() + delay, peer, std::vector<uint8_t>(bytes, bytes + size) };

    /* Jitter may reorder packets, exactly like a real network. */
    auto it = sSimQueue.end();
    while (it != sSimQueue.begin() && static_cast<int>((it - 1)->release_ms - packet.release_ms) > 0) {
        --it;
    }
    sSimQueue.insert(it, std::move(packet));
    flush_sim_queue();
    return size;
}

extern "C" int port_udp_peer_punch(int peer, const void *data, int size)
{
    if (sSocket == kInvalidSocket || !valid_peer(peer) || data == nullptr || size <= 0) {
        return -1;
    }
    const Peer &p = sPeers[peer];
    int result = -1;

    for (int i = 0; i < p.candidate_count; i++) {
        if (raw_send_to(p.candidates[i], static_cast<const uint8_t *>(data), size) == size) {
            result = size;
        }
    }
    return result;
}

extern "C" int port_udp_recv_peer(void *buffer, int capacity, int *peer)
{
    if (sSocket == kInvalidSocket || buffer == nullptr || capacity <= 0 || peer == nullptr) {
        return -1;
    }
    flush_sim_queue();

    for (;;) {
        sockaddr_in from;
        bool relayed = false;
        int size = raw_recv(buffer, capacity, &from, peer, &relayed);

        if (size <= 0) {
            return size;
        }
        if (*peer >= 0) {
            return size;
        }
        /* not one of our peers (stray lobby/server traffic) */
    }
}

extern "C" int port_udp_recv_any(void *buffer, int capacity, int *peer, char *from_text, int from_capacity)
{
    sockaddr_in from;
    bool relayed = false;
    int source = -1;

    if (sSocket == kInvalidSocket || buffer == nullptr || capacity <= 0) {
        return -1;
    }
    flush_sim_queue();

    int size = raw_recv(buffer, capacity, &from, &source, &relayed);
    if (peer != nullptr) {
        *peer = source;
    }
    if (size > 0 && from_text != nullptr && from_capacity > 0) {
        if (relayed) {
            std::snprintf(from_text, from_capacity, "relay");
        } else {
            text_of(from, from_text, from_capacity);
        }
    }
    return size;
}

extern "C" int port_udp_send_to(const char *spec, const void *data, int size)
{
    sockaddr_in to;

    if (sSocket == kInvalidSocket || data == nullptr || size <= 0 || !parse_address(spec, &to)) {
        return -1;
    }
    return raw_send_to(to, static_cast<const uint8_t *>(data), size);
}

extern "C" void port_udp_set_relay_hooks(port_udp_relay_send_fn send, port_udp_relay_recv_fn recv)
{
    sRelaySend = send;
    sRelayRecv = recv;
    if (send == nullptr) {
        for (Peer &p : sPeers) {
            p.relay = false;
        }
    }
}

extern "C" int port_udp_has_relay_hooks(void)
{
    return (sRelaySend != nullptr) ? 1 : 0;
}

extern "C" int port_udp_local_endpoint(char *out, int capacity)
{
    sockaddr_in bound;
#if defined(_WIN32)
    int len = sizeof(bound);
#else
    socklen_t len = sizeof(bound);
#endif
    if (sSocket == kInvalidSocket || out == nullptr ||
        getsockname(sSocket, reinterpret_cast<sockaddr *>(&bound), &len) != 0) {
        return 0;
    }
    /* Route-selection trick: "connecting" a throwaway UDP socket sends
     * nothing but makes the OS pick the outbound interface address. */
    in_addr local = bound.sin_addr;
    PortSocket probe = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (probe != kInvalidSocket) {
        sockaddr_in remote;
        std::memset(&remote, 0, sizeof(remote));
        remote.sin_family = AF_INET;
        remote.sin_port = htons(53);
        inet_pton(AF_INET, "8.8.8.8", &remote.sin_addr);
        if (connect(probe, reinterpret_cast<sockaddr *>(&remote), sizeof(remote)) == 0) {
            sockaddr_in name;
#if defined(_WIN32)
            int name_len = sizeof(name);
#else
            socklen_t name_len = sizeof(name);
#endif
            if (getsockname(probe, reinterpret_cast<sockaddr *>(&name), &name_len) == 0) {
                local = name.sin_addr;
            }
        }
        port_udp_close_socket(probe);
    }
    char ip[INET_ADDRSTRLEN] = "127.0.0.1";
    inet_ntop(AF_INET, &local, ip, sizeof(ip));
    std::snprintf(out, capacity, "%s:%u", ip, static_cast<unsigned>(ntohs(bound.sin_port)));
    return 1;
}

extern "C" void port_udp_sleep_us(unsigned int usecs)
{
    std::this_thread::sleep_for(std::chrono::microseconds(usecs));
}

extern "C" unsigned int port_udp_now_ms(void)
{
    using namespace std::chrono;
    return static_cast<unsigned int>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}
