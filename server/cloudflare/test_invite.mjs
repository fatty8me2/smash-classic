// Tests for GET /j/<CODE> invite pages. Usage:
// Run: npx wrangler dev --port 8801   (in another shell), then: node test_invite.mjs http://127.0.0.1:8801
//   node test_invite.mjs [http://127.0.0.1:8801]   (against a running wrangler dev)
//   node test_invite.mjs --unit                    (pure validator/page tests only)
import { isValidInviteCode, normalizeInviteCode, invitePage } from "./src/invite.js";

let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };

// Unit checks.
check(isValidInviteCode("ABCDEF"), "valid code accepted");
check(isValidInviteCode("234789"), "digits from the alphabet accepted");
check(!isValidInviteCode("ABCDE"), "5 chars rejected");
check(!isValidInviteCode("ABCDEFG"), "7 chars rejected");
check(!isValidInviteCode("ABCDE0"), "0 (zero) rejected: not in alphabet");
check(!isValidInviteCode("ABCDEI"), "I rejected: not in alphabet");
check(!isValidInviteCode("abcdef"), "lowercase rejected before normalize");
check(!isValidInviteCode('<script>'), "markup rejected");
check(normalizeInviteCode(" abcdef ") === "ABCDEF", "normalize trims and uppercases");
const page = invitePage("ABCDEF");
check(page.includes('retrohub://join/') && page.includes("Get RetroHub"), "page has protocol link and fallback");
check(page.includes("https://github.com/fatty8me2/smash-classic/releases/latest/download/RetroHub-Setup.exe"), "page links setup exe");
let threw = false; try { invitePage('"><img src=x onerror=alert(1)>'); } catch { threw = true; }
check(threw, "invitePage refuses non-code input");

if (process.argv[2] !== "--unit") {
  const base = process.argv[2] || "http://127.0.0.1:8801";
  const get = async (p) => fetch(base + p, { redirect: "manual" });
  let r = await get("/j/ABCDEF");
  check(r.status === 200, "GET /j/ABCDEF returns 200");
  check((r.headers.get("content-type") || "").startsWith("text/html"), "content-type is html");
  const body = await r.text();
  check(body.includes("retrohub://join/") && body.includes('var code = "ABCDEF"'), "body builds retrohub://join URL for the code");
  r = await get("/j/abcdef");
  check(r.status === 200, "lowercase code normalized and served");
  for (const bad of ["/j/ABC", "/j/ABCDEF9X", "/j/ABCD%3CE", "/j/", "/j/ABCDE0", "/j/%E0%A4%A", "/j/%"]) {
    r = await get(bad);
    check(r.status === 400, `GET ${bad} returns 400`);
  }
  r = await get("/health");
  check(r.status === 200, "/health still works");
}

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
