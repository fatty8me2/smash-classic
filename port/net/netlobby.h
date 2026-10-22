#pragma once

/* Online lobby: room codes through server/cloudflare (Worker + Durable
 * Object), UDP hole punching via Cloudflare STUN with WebSocket relay
 * fallback, character picks, and the hand-off into a rollback netplay match
 * (sys/netpeer.c). Up to 4 players: the creator is lobby slot 0 and the host,
 * joiners take the other slots, and every player connects to every other (a
 * full mesh). If the host leaves, the server promotes the lowest remaining
 * slot (host migration): the room code keeps working and the new host takes
 * over starting matches, the stage and rematches.
 * Non-blocking; port_netlobby_update() runs once per frame from
 * PortPushFrame. */

/* Lobby server (server/cloudflare). Release builds bake the deployed Worker
 * in via -DSSB64_NETPLAY_SERVER=...; players can override it in the menu. */
#ifdef SSB64_NETPLAY_SERVER
#define PORT_NETLOBBY_DEFAULT_SERVER SSB64_NETPLAY_SERVER
#else
#define PORT_NETLOBBY_DEFAULT_SERVER "wss://smash-netplay.jumpcircuit.workers.dev"
#endif

#define PORT_NETLOBBY_MAX_PLAYERS 4

#ifdef __cplusplus
extern "C" {
#endif

enum PortNetLobbyState {
    PORT_NETLOBBY_IDLE,
    PORT_NETLOBBY_CREATING,     /* host: waiting for a room code */
    PORT_NETLOBBY_WAITING,      /* host: room open, nobody connected yet */
    PORT_NETLOBBY_JOINING,      /* client: waiting for the server introduction */
    PORT_NETLOBBY_PUNCHING,     /* client: establishing the path to the host */
    PORT_NETLOBBY_CONNECTED,    /* talking; the host can start once everyone has picked */
    PORT_NETLOBBY_STARTING,     /* host: sent START, waiting for every GO; client: answered START */
    PORT_NETLOBBY_IN_MATCH,
    PORT_NETLOBBY_FAILED
};

/* One lobby slot, for the status window. */
typedef struct PortNetLobbyPlayer {
    int slot;           /* lobby slot 0-3 */
    int is_self;
    int is_host;
    int connected;      /* link established (always 1 for yourself) */
    int fkind;          /* picked fighter, -1 = not picked yet */
    int ping_ms;        /* -1 = unknown */
    int relay;          /* link goes through the server relay */
} PortNetLobbyPlayer;

void port_netlobby_update(void);

void port_netlobby_host(const char *server, int fkind, int stage, int stocks, int items, int delay);
void port_netlobby_join(const char *server, const char *code, int fkind);
void port_netlobby_cancel(void);
void port_netlobby_start_match(void);
void port_netlobby_set_fkind(int fkind);

int port_netlobby_state(void);
const char *port_netlobby_status(void);
const char *port_netlobby_code(void);
int port_netlobby_is_host(void);
/* Lobby slot that leads the room, -1 while the next host is being elected. */
int port_netlobby_host_slot(void);
/* "Player N is now the host" for a few seconds after a host migration, else "". */
const char *port_netlobby_host_notice(void);
int port_netlobby_is_relay(void);
/* Worst ping among connected players, -1 when unknown. */
int port_netlobby_ping_ms(void);

/* The room's players. Fills `out` for lobby slot `slot` (0-3); returns 0 when
 * that slot is empty. */
int port_netlobby_get_player(int slot, PortNetLobbyPlayer *out);
/* Players in the room including yourself (connected or still connecting). */
int port_netlobby_player_count(void);
/* Connected players including yourself. */
int port_netlobby_connected_count(void);
/* First connected opponent's fighter, -1 if none has picked. */
int port_netlobby_peer_fkind(void);
/* 1 when you are the host and a match can start right now (everyone in the
 * room is connected and has picked a fighter). */
int port_netlobby_can_start(void);

/* 1 after an online match has ended while the players are still connected
 * (each is back in their own local menus; the host can start a rematch). */
int port_netlobby_after_match(void);

int port_netlobby_my_fkind(void);
int port_netlobby_stage(void);
/* Host only, before the match starts. */
void port_netlobby_set_stage(int stage);
/* Host only, before the match starts: stage, stocks (1-99), items on/off, input delay (0-16). */
void port_netlobby_set_options(int stage, int stocks, int items, int delay);
/* 1 when this session was started by RetroHub / test automation (env). */
int port_netlobby_auto_active(void);

/* Called by sys/netpeer.c when an online match's VS session ends. */
void port_netlobby_on_match_end(void);

#ifdef __cplusplus
}
#endif
