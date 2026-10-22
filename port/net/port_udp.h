#pragma once

/* Minimal non-blocking UDP endpoint for netplay (sys/netpeer.c).
 *
 * Lives in the port layer so decomp TUs never include winsock2.h/windows.h
 * (whose near/far macros collide with decomp struct fields). One socket per
 * process, shared by up to PORT_UDP_MAX_PEERS peers (a full mesh in a 3-4
 * player match). A peer is addressed by its index, which is its lobby slot.
 * Addresses are "host:port" strings ("*" or "0.0.0.0" binds all).
 *
 * Each peer has a few candidate addresses (public + LAN). The first datagram
 * heard from one of them makes it that peer's direct path. Per peer, game
 * traffic goes either direct or through the lobby server's relay, which the
 * lobby selects when hole punching to that peer fails; a relayed frame is
 * [destination peer][payload] going out and [source peer][payload] coming in.
 *
 * Optional network simulation for testing (host-side only, never game state):
 *   SSB64_NETPLAY_SIM_LATENCY_MS  one-way delay added to every sent packet
 *   SSB64_NETPLAY_SIM_JITTER_MS   extra random delay in [0, jitter]
 *   SSB64_NETPLAY_SIM_LOSS_PCT    percent of sent packets dropped
 *   SSB64_NETPLAY_SIM_SEED        PRNG seed for jitter/loss (default 1) */

#ifdef __cplusplus
extern "C" {
#endif

#define PORT_UDP_MAX_PEERS 4
#define PORT_UDP_MAX_CANDIDATES 4

int port_udp_open(const char *bind_spec);      /* 1 on success */
void port_udp_close(void);
int port_udp_is_open(void);

/* ---- peers ---- */

void port_udp_peers_clear(void);
void port_udp_peer_clear(int peer);
/* Adds a candidate address for the peer; 1 on success. */
int port_udp_peer_add_candidate(int peer, const char *spec);
/* Replaces the peer's addresses with one fixed address (env-configured debug
 * netplay). */
int port_udp_peer_set(int peer, const char *spec);
int port_udp_peer_has_candidates(int peer);
/* 1 once a datagram arrived directly from the peer (and none since went via relay). */
int port_udp_peer_is_direct(int peer);
/* Route this peer's game traffic through the relay hooks (or back to direct). */
void port_udp_peer_set_relay(int peer, int relay);
int port_udp_peer_is_relay(int peer);

/* Sends to one peer over its current path. Returns size on success (including
 * when the simulator queued or dropped it, as a real lossy network would),
 * -1 on error. */
int port_udp_peer_send(int peer, const void *data, int size);

/* Hole punching: sends to every candidate address of the peer, unsimulated. */
int port_udp_peer_punch(int peer, const void *data, int size);

/* Returns the size of one received datagram from any known peer, 0 when none
 * is pending, -1 on error; *peer is the sender's index. Datagrams from other
 * addresses are skipped. */
int port_udp_recv_peer(void *buffer, int capacity, int *peer);

/* Like port_udp_recv_peer but also returns datagrams from unknown addresses
 * (STUN replies, strays): *peer is -1 then and `from` holds "ip:port". */
int port_udp_recv_any(void *buffer, int capacity, int *peer, char *from, int from_capacity);

/* Lobby / NAT traversal (port/net/netlobby.cpp): unsimulated send to an address. */
int port_udp_send_to(const char *spec, const void *data, int size);

/* Relay fallback: the lobby routes frames through its WebSocket to
 * server/cloudflare. `send` is handed [destination peer][payload]; `recv`
 * yields [source peer][payload]. NULL hooks disable the relay. */
typedef int (*port_udp_relay_send_fn)(const void *data, int size);   /* 1 = sent */
typedef int (*port_udp_relay_recv_fn)(void *buffer, int capacity);  /* size, 0 = none */
void port_udp_set_relay_hooks(port_udp_relay_send_fn send, port_udp_relay_recv_fn recv);
int port_udp_has_relay_hooks(void);

/* The primary local IPv4 of this machine plus the bound port ("ip:port"),
 * for peers behind the same NAT. Returns 1 on success. */
int port_udp_local_endpoint(char *out, int capacity);

void port_udp_sleep_us(unsigned int usecs);
unsigned int port_udp_now_ms(void);

#ifdef __cplusplus
}
#endif
