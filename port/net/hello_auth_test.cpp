// Standalone: cl /EHsc /std:c++17 hello_auth_test.cpp  (or g++ -std=c++17). No game dependencies.
#include "hello_auth.h"
#include <cstdio>
#include <vector>
static int fails;
#define CHECK(c) do { if (!(c)) { fails++; std::printf("FAIL line %d: %s\n", __LINE__, #c); } } while (0)
int main()
{
    const std::string tok = "0123456789abcdef0123456789abcdef";
    CHECK(hello_auth::token_ok(tok, tok));
    CHECK(!hello_auth::token_ok(tok, "0123456789abcdef0123456789abcdee"));
    CHECK(!hello_auth::token_ok(tok, ""));
    CHECK(!hello_auth::token_ok(tok, tok + "0"));
    CHECK(!hello_auth::token_ok("", ""));            // no server token: never learn from an unknown address
    CHECK(hello_auth::make("HELLO", 2, tok) == "SSBL HELLO 2 " + tok);
    CHECK(hello_auth::make("HELLOACK", 1, "") == "SSBL HELLOACK 1");
    std::vector<std::string> good = {"SSBL", "HELLO", "2", tok};
    std::vector<std::string> bad = {"SSBL", "HELLO", "2", "deadbeef"};
    std::vector<std::string> none = {"SSBL", "HELLO", "2"};
    CHECK(hello_auth::accept_unknown(tok, good.size(), good.data()));
    CHECK(!hello_auth::accept_unknown(tok, bad.size(), bad.data()));
    CHECK(!hello_auth::accept_unknown(tok, none.size(), none.data()));
    CHECK(!hello_auth::accept_unknown("", good.size(), good.data()));
    CHECK(hello_auth::may_learn("", none.size(), none.data()));   // old server: no tokens issued
    CHECK(hello_auth::may_learn(tok, good.size(), good.data()));
    CHECK(!hello_auth::may_learn(tok, none.size(), none.data()));
    CHECK(!hello_auth::may_learn(tok, bad.size(), bad.data()));
    std::printf(fails ? "%d FAILED\n" : "all passed\n", fails);
    return fails != 0;
}
