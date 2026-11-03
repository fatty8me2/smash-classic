#pragma once
/* The RetroHub account behind a lobby seat: the {"type":"ident"} frame the Smash lobby server (/ws) checks before it lets a seat stay
 * (banned / unapproved accounts are refused, see server/cloudflare/src/adminreg.js). Header-only and dependency-free so a standalone test
 * can build it. The secret is never logged and never put on a command line.
 *
 * Sources, in order:
 *   1. RETROHUB_IDENT = "<server url>|<uid>|<secret>"  (inherited environment; RetroHub sets it only around the CreateProcess of this exe).
 *      Used only when its server equals the lobby server we are connecting to.
 *   2. RetroHub's identity file (<RetroHub dir>/userdata/identity.json, {"user_id","secret"}): only for the official lobby server, because
 *      the file is not bound to a server and the secret must not go to a private/test host. */
#include <string>

namespace lobby_ident {

inline std::string norm_server(std::string s)
{
    while (!s.empty() && s.back() == '/') s.pop_back();
    for (char &c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

/* base32 (a-z, 2-7) of an exact length: also means nothing here can break the JSON we build. */
inline bool field_ok(const std::string &s, size_t n)
{
    if (s.size() != n) return false;
    for (char c : s) if (!((c >= 'a' && c <= 'z') || (c >= '2' && c <= '7'))) return false;
    return true;
}

inline std::string frame(const std::string &uid, const std::string &secret)
{
    if (!field_ok(uid, 26) || !field_ok(secret, 52)) return std::string();
    return "{\"type\":\"ident\",\"uid\":\"" + uid + "\",\"secret\":\"" + secret + "\",\"nopair\":true}";
}

/* RETROHUB_IDENT value -> frame for `lobby_server`, or "" (unset, malformed, or bound to another server). */
inline std::string from_env(const std::string &lobby_server, const char *env_value)
{
    if (env_value == nullptr || env_value[0] == '\0') return std::string();
    const std::string v = env_value;
    const size_t a = v.find('|');
    const size_t b = (a == std::string::npos) ? a : v.find('|', a + 1);
    if (b == std::string::npos) return std::string();
    if (norm_server(v.substr(0, a)) != norm_server(lobby_server)) return std::string();
    return frame(v.substr(a + 1, b - a - 1), v.substr(b + 1));
}

inline std::string json_str(const std::string &json, const char *key)
{
    const std::string needle = std::string("\"") + key + "\"";
    size_t at = json.find(needle);
    if (at == std::string::npos) return std::string();
    at = json.find(':', at + needle.size());
    if (at == std::string::npos) return std::string();
    at = json.find('"', at);
    if (at == std::string::npos) return std::string();
    const size_t end = json.find('"', at + 1);
    return end == std::string::npos ? std::string() : json.substr(at + 1, end - at - 1);
}

/* identity.json text -> frame, only when `lobby_server` is the official server. */
inline std::string from_identity_file(const std::string &lobby_server, const std::string &official_server, const std::string &file_text)
{
    if (norm_server(lobby_server) != norm_server(official_server)) return std::string();
    return frame(json_str(file_text, "user_id"), json_str(file_text, "secret"));
}

/* What a refusal from the lobby server means to the player. `reason` is the server's error reason, or text that contains it (a close reason).
 * "" = not an account refusal. */
inline const char *refusal_text(const std::string &reason)
{
    if (reason.find("account-unavailable") != std::string::npos) return "This account can't play online";
    if (reason.find("pending-approval") != std::string::npos) return "Waiting for the owner's approval";
    if (reason.find("ident-required") != std::string::npos) return "This room needs a RetroHub account - open Smash from RetroHub";
    if (reason.find("server-busy") != std::string::npos) return "Server busy, try again shortly";
    return "";
}

} // namespace lobby_ident
