#pragma once
/* Pair-token check for the lobby's UDP `SSBL HELLO <slot> [token]` / `SSBL HELLOACK <slot> [token]`.
 * The lobby server hands each pair of room members one private random token in the roster ("tok");
 * a HELLO from an address we have no candidate for is only learned when it carries that token.
 * Header-only and dependency-free so a standalone test can build it. */
#include <cstddef>
#include <string>

namespace hello_auth {

/* Constant-time equality; an empty expected token never matches (peer has no token from the server). */
inline bool token_ok(const std::string &expected, const std::string &given)
{
    if (expected.empty() || expected.size() != given.size()) {
        return false;
    }
    unsigned char diff = 0;
    for (size_t i = 0; i < expected.size(); i++) {
        diff |= static_cast<unsigned char>(expected[i] ^ given[i]);
    }
    return diff == 0;
}

/* "SSBL HELLO 2 abcd" -> "SSBL HELLO 2 abcd"; without a token the older two-word form. */
inline std::string make(const char *word, int my_slot, const std::string &token)
{
    std::string text = std::string("SSBL ") + word + " " + std::to_string(my_slot);
    if (!token.empty()) {
        text += " " + token;
    }
    return text;
}

/* May a HELLO/HELLOACK from an UNKNOWN address (args = split words) make `expected` the new path?
 * Needs the server's token for that pair to exist and to match. */
inline bool accept_unknown(const std::string &expected, size_t argc, const std::string *args)
{
    return argc >= 4 && token_ok(expected, args[3]);
}

/* Lobby rule: a server that predates tokens (no `expected`) keeps the old IP-only rule. */
inline bool may_learn(const std::string &expected, size_t argc, const std::string *args)
{
    return expected.empty() || accept_unknown(expected, argc, args);
}

}
