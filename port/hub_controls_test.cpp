// Standalone console test (own main). Build:
//   cl /std:c++17 /EHsc /I<nlohmann include> port\hub_controls_test.cpp port\hub_controls.cpp
#include "hub_controls.h"
#include <cstdio>

static int fails = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)

int main() {
    using namespace hubc;
    auto e = parse_expr("x|b|leftx-@9000|lefttrigger");
    CHECK(e.size() == 4 && !e[0].axis && e[0].idx == 2 && e[2].axis && e[2].idx == 0 && e[2].sign == -1);
    CHECK(e[3].axis && e[3].idx == 4 && e[3].sign == 1);
    CHECK(parse_expr("bogus").empty());

    Plan p = plan_from_json(R"({"name":"t","system":"n64","buttons":{"a":"a","b":"x|b","c_up":"righty-","z":"lefttrigger"},
      "analogs":{"stick":{"x":"leftx","y":"lefty","deadzone":0.15,"sensitivity":1.2}},"axis_threshold":16384,
      "port_order":["g1#s","g2"],"rumble":true})");
    CHECK(p.valid && p.buttons.size() == 5 && p.has_stick && p.deadzone_pct == 15 && p.sensitivity_pct == 120);
    CHECK(p.rumble && p.port_order.size() == 2);
    CHECK(!plan_from_json("{bad").valid);
    CHECK(!plan_from_json(R"({"system":"gc"})").valid);

    CHECK(e[2].threshold == 9000 && e[0].threshold == 0);
    Plan dp = plan_from_json(R"({"name":"default-n64","system":"n64","buttons":{"z":"lefttrigger@16000","c_up":"righty-"},"axis_threshold":20000})");
    CHECK(dp.is_default && dp.trigger_thr_pct == 49 && dp.stick_thr_pct == 61);
    CHECK(order_pads({ "a#1", "b#2", "c" }, { "c", "b", "zz" }) == std::vector<int>({ 2, 1, 0 }));
    CHECK(order_pads({ "a#1", "a#2" }, { "a#2", "a" }) == std::vector<int>({ 1, 0 }));

    ExitCombo c(1.0);
    bool on[1] = { true }, off[1] = { false };
    CHECK(!c.update(on, 1, 0.0));
    CHECK(!c.update(on, 1, 0.9));
    CHECK(c.update(on, 1, 1.0));
    CHECK(!c.update(on, 1, 1.5));     // fires once
    ExitCombo d(1.0);
    d.update(on, 1, 0.0); d.update(off, 1, 0.5);   // release resets
    CHECK(!d.update(on, 1, 1.2));
    CHECK(d.update(on, 1, 2.3));

    std::printf(fails ? "hub_controls_test: %d FAILED\n" : "hub_controls_test: OK\n", fails);
    return fails ? 1 : 0;
}
