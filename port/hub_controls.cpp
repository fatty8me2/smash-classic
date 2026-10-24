/* Pure half of the RetroHub controls integration. See hub_controls.h. */
#include "hub_controls.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <map>
#include <nlohmann/json.hpp>

namespace hubc {

int button_index(const std::string& n) {
    static const char* const k[] = { "a", "b", "x", "y", "back", "guide", "start", "leftstick", "rightstick",
                                     "leftshoulder", "rightshoulder", "dpup", "dpdown", "dpleft", "dpright" };
    for (int i = 0; i < 15; i++) if (n == k[i]) return i;
    return -1;
}

int axis_index(const std::string& n) {
    static const char* const k[] = { "leftx", "lefty", "rightx", "righty", "lefttrigger", "righttrigger" };
    for (int i = 0; i < 6; i++) if (n == k[i]) return i;
    return -1;
}

std::vector<Source> parse_expr(const std::string& expr) {
    std::vector<Source> out;
    size_t pos = 0;
    while (pos <= expr.size()) {
        size_t bar = expr.find('|', pos);
        std::string t = expr.substr(pos, bar == std::string::npos ? std::string::npos : bar - pos);
        pos = (bar == std::string::npos) ? expr.size() + 1 : bar + 1;
        size_t at = t.find('@');
        if (at != std::string::npos) t.resize(at);   // threshold: libultraship uses its own fixed one
        while (!t.empty() && t.front() == ' ') t.erase(t.begin());
        while (!t.empty() && t.back() == ' ') t.pop_back();
        int sign = 0;
        if (!t.empty() && (t.back() == '+' || t.back() == '-')) { sign = t.back() == '-' ? -1 : 1; t.pop_back(); }
        Source s;
        int b = button_index(t);
        if (b >= 0 && sign == 0) { s.idx = b; out.push_back(s); continue; }
        int a = axis_index(t);
        if (a >= 0) { s.axis = true; s.idx = a; s.sign = sign == 0 ? 1 : sign; out.push_back(s); }
    }
    return out;
}

Plan plan_from_json(const std::string& json) {
    Plan p;
    auto j = nlohmann::json::parse(json, nullptr, false);
    if (j.is_discarded() || !j.is_object()) return p;
    if (j.value("system", std::string("n64")) != "n64") return p;
    p.name = j.value("name", std::string());
    p.rumble = j.value("rumble", false);

    static const std::map<std::string, uint32_t> kMap = {
        { "a", kA }, { "b", kB }, { "z", kZ }, { "start", kStart }, { "l", kL }, { "r", kR },
        { "c_up", kCUp }, { "c_down", kCDown }, { "c_left", kCLeft }, { "c_right", kCRight },
        { "dpad_up", kDUp }, { "dpad_down", kDDown }, { "dpad_left", kDLeft }, { "dpad_right", kDRight },
    };
    if (j.contains("buttons") && j["buttons"].is_object()) {
        for (auto it = j["buttons"].begin(); it != j["buttons"].end(); ++it) {
            auto m = kMap.find(it.key());
            if (m == kMap.end() || !it.value().is_string()) continue;
            for (const Source& s : parse_expr(it.value().get<std::string>())) p.buttons.push_back({ m->second, s });
        }
    }
    if (j.contains("analogs") && j["analogs"].is_object() && j["analogs"].contains("stick")) {
        const auto& a = j["analogs"]["stick"];
        std::string xs = a.value("x", std::string()), ys = a.value("y", std::string());
        int ax = axis_index(xs), ay = axis_index(ys);
        if (ax >= 0 && ay >= 0) {
            p.has_stick = true;
            p.stick = { { kLeft, ax, -1 }, { kRight, ax, 1 }, { kUp, ay, -1 }, { kDown, ay, 1 } };   // SDL: down = +y
        }
        double dz = a.value("deadzone", 0.08), sens = a.value("sensitivity", 1.0);
        p.deadzone_pct = std::clamp((int)std::lround(dz * 100.0), 0, 95);
        p.sensitivity_pct = std::clamp((int)std::lround(sens * 100.0), 1, 255);
    }
    if (j.contains("port_order") && j["port_order"].is_array())
        for (const auto& k : j["port_order"]) if (k.is_string()) p.port_order.push_back(k.get<std::string>());
    p.valid = true;
    return p;
}

bool ExitCombo::update(const bool* held, int pads, double now) {
    bool any = false;
    for (int i = 0; i < pads; i++) if (held[i]) { any = true; break; }
    if (!any) { since_ = -1.0; return false; }
    if (since_ < 0) since_ = now;
    if (!fired_ && now - since_ >= hold_) { fired_ = true; return true; }
    return false;
}

} // namespace hubc
