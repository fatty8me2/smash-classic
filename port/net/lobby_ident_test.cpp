// Standalone: cl /EHsc /std:c++17 lobby_ident_test.cpp  (or g++ -std=c++17). No game dependencies.
#include "lobby_ident.h"
#include <cstdio>
static int fails;
#define CHECK(c) do { if (!(c)) { fails++; std::printf("FAIL line %d: %s\n", __LINE__, #c); } } while (0)
int main()
{
    const std::string uid(26, 'a'), sec(52, 'b');
    const std::string want = "{\"type\":\"ident\",\"uid\":\"" + uid + "\",\"secret\":\"" + sec + "\",\"nopair\":true}";
    const std::string env = "wss://Smash.example.dev/|" + uid + "|" + sec;
    CHECK(lobby_ident::from_env("wss://smash.example.dev", env.c_str()) == want);
    CHECK(lobby_ident::from_env("wss://other.example.dev", env.c_str()).empty());        // bound to one server
    CHECK(lobby_ident::from_env("wss://smash.example.dev", nullptr).empty());
    CHECK(lobby_ident::from_env("wss://smash.example.dev", "").empty());
    CHECK(lobby_ident::from_env("wss://smash.example.dev", ("wss://smash.example.dev|" + uid).c_str()).empty());
    CHECK(lobby_ident::from_env("wss://smash.example.dev", ("wss://smash.example.dev|" + uid + "|short").c_str()).empty());
    CHECK(lobby_ident::from_env("wss://smash.example.dev", ("wss://smash.example.dev|" + uid + "|" + std::string(52, '"')).c_str()).empty());   // no JSON injection
    const std::string file = "{\"user_id\":\"" + uid + "\",\"secret\":\"" + sec + "\",\"created\":123}\n";
    CHECK(lobby_ident::from_identity_file("wss://smash.example.dev/", "wss://smash.example.dev", file) == want);
    CHECK(lobby_ident::from_identity_file("ws://127.0.0.1:8787", "wss://smash.example.dev", file).empty());   // never to another host
    CHECK(lobby_ident::from_identity_file("wss://smash.example.dev", "wss://smash.example.dev", "{}").empty());
    CHECK(std::string(lobby_ident::refusal_text("account-unavailable")) == "This account can't play online");
    CHECK(std::string(lobby_ident::refusal_text("Lobby: server closed the connection: pending-approval")) == "Waiting for the owner's approval");
    CHECK(std::string(lobby_ident::refusal_text("ident-required")).find("RetroHub account") != std::string::npos);
    CHECK(std::string(lobby_ident::refusal_text("server-busy")) == "Server busy, try again shortly");
    CHECK(std::string(lobby_ident::refusal_text("room-full")).empty());
    std::printf(fails ? "%d FAILED\n" : "all passed\n", fails);
    return fails != 0;
}
