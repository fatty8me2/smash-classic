// Clickable invite landing page: GET /j/<CODE>.
//
// Opens retrohub://join/<CODE> when RetroHub is installed. If nothing picks up
// the link, the page explains how to get RetroHub and shows the code to type
// in. The code alphabet matches the netplay room codes (src/index.js CODE_RE).

// Plain 6-char codes only: netplay rooms are never "-N" suffixed (src/index.js CODE_RE is strict), so an invite link
// never carries a suffix. (friends.js LOBBY_RE tolerates "-N" on presence/invites, but nothing emits it.)
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const SETUP_URL = "https://github.com/fatty8me2/retrohub/releases/latest/download/RetroHub-Setup.exe";

export function isValidInviteCode(code) {
  return typeof code === "string" && CODE_RE.test(code);
}

export function normalizeInviteCode(raw) {
  return String(raw || "").trim().replace(/\/+$/, "").replace(/[-\s]/g, "").toUpperCase();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Host name shown in the preview ("Join <host>'s RetroHub room"). Optional ?h= on the link; letters, digits, space and a few marks only. */
export function cleanHostName(raw) {
  const s = String(raw || "").normalize("NFKC").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 24);
  return s;
}

export function invitePage(code, host = "") {
  if (!isValidInviteCode(code)) throw new Error("invalid invite code");
  const c = escapeHtml(code);
  const h = escapeHtml(cleanHostName(host));
  const title = h ? `Join ${h}'s RetroHub room` : "Join a RetroHub room";
  const desc = `Room code ${c}. Play retro games online together: click to open RetroHub, or get it free.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#3b82f6">
<meta property="og:type" content="website">
<meta property="og:site_name" content="RetroHub">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #14161c; color: #e9ecf2; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 480px; padding: 32px 24px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  .code { font: 700 32px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 4px;
          background: #222632; border-radius: 8px; padding: 12px 16px; margin: 16px 0; user-select: all; }
  a.btn { display: block; background: #3b82f6; color: #fff; text-decoration: none; font-size: 20px;
          border-radius: 10px; padding: 16px 24px; font-weight: 700; margin: 12px 0; }
  a.btn.alt { background: #2b3040; font-size: 16px; font-weight: 600; padding: 12px 20px; }
  p, small { color: #aab1c0; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <div class="code" aria-label="Invite code">${c}</div>
  <a class="btn" id="open" href="retrohub://join/${c}">Open in RetroHub</a>
  <p id="status">If your browser asks, allow it to open RetroHub.</p>
  <a class="btn alt" href="${SETUP_URL}">Don't have RetroHub? Download it (free)</a>
  <small>After installing, click Open in RetroHub again, or paste the code above into Play Online &gt; Join with code.</small>
</main>
<script>
  (function () {
    var code = ${JSON.stringify(code)};
    var status = document.getElementById("status");
    var url = "retrohub://join/" + encodeURIComponent(code);
    // Best-effort automatic open. Browsers may block it without a click, so the button above always works.
    setTimeout(function () { try { window.location.href = url; } catch (e) {} }, 300);
    setTimeout(function () { status.textContent = "Nothing opened? Click Open in RetroHub, or download RetroHub below."; }, 2500);
  })();
</script>
</body>
</html>`;
}

export function inviteFetch(request, pathname) {
  let host = "";
  try { host = new URL(request.url).searchParams.get("h") || ""; } catch { /* no host name */ }
  const raw = pathname.slice("/j/".length);
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch {
    return new Response("bad invite code", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const code = normalizeInviteCode(decoded);
  if (!isValidInviteCode(code)) {
    return new Response("bad invite code", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(request.method === "HEAD" ? null : invitePage(code, host), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
