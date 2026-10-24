// Tests for GET /j/<CODE> invite pages. Usage:
// Run: npx wrangler dev --port 8801   (in another shell), then: node test_invite.mjs http://127.0.0.1:8801
//   node test_invite.mjs [http://127.0.0.1:8801]   (against a running wrangler dev)
//   node test_invite.mjs --unit                    (pure validator/page tests only)
import { isValidInviteCode, normalizeInviteCode, invitePage, cleanHostName } from "./src/invite.js";

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
check(page.includes('href="retrohub://join/ABCDEF"') && page.includes("Open in RetroHub"), "page has protocol link and fallback");
check(page.includes("https://github.com/fatty8me2/retrohub/releases/latest/download/RetroHub-Setup.exe"), "page links setup exe");
check(page.includes('property="og:title" content="Join a RetroHub room"'), "OpenGraph title (no host)");
check(page.includes('property="og:description"') && page.includes("twitter:card"), "OpenGraph description + twitter card");
const hp = invitePage("ABCDEF", "Oli <b>&\"x");
check(hp.includes("Join Oli bx's RetroHub room") && !hp.includes("<b>"), "host name sanitized into the preview title");
check(cleanHostName("A".repeat(60)).length === 24, "host name capped at 24 chars");
check(normalizeInviteCode("abc-def/") === "ABCDEF", "normalize strips hyphen and trailing slash");
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
  // Real-format codes: whatever hubnet::new_room_code() can emit (alphabet A-HJ-NP-Z2-9, 6 chars).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 25; i++) {
    let code = ""; for (let k = 0; k < 6; k++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const rr = await get("/j/" + code);
    const t = await rr.text();
    if (rr.status !== 200 || !t.includes(`retrohub://join/${code}`)) check(false, `real-format code ${code} served`);
  }
  check(true, "25 random real-format codes all served with the protocol link");
  check(body.includes('property="og:title"') && body.includes('id="open"') && body.includes("RetroHub-Setup.exe"), "served page has OG tags, Open button and setup link");
  check(!body.includes("not installed on this PC"), "page never claims RetroHub is not installed");
  r = await get("/j/ABCDEF/");
  check(r.status === 200, "trailing slash accepted");
  r = await get("/j/K7M2QX?h=Oliver");
  check((await r.text()).includes("Join Oliver's RetroHub room"), "?h= host name shown in title");
  r = await fetch(base + "/j/ABCDEF", { method: "HEAD" });
  check(r.status === 200, "HEAD works (link unfurlers)");
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
