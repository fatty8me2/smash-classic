// Clickable invite landing page: GET /j/<CODE>.
//
// Opens retrohub://join/<CODE> when RetroHub is installed. If nothing picks up
// the link, the page explains how to get RetroHub and shows the code to type
// in. The code alphabet matches the netplay room codes (src/index.js CODE_RE).

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const SETUP_URL = "https://github.com/fatty8me2/smash-classic/releases/latest/download/RetroHub-Setup.exe";

export function isValidInviteCode(code) {
  return typeof code === "string" && CODE_RE.test(code);
}

export function normalizeInviteCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function invitePage(code) {
  if (!isValidInviteCode(code)) throw new Error("invalid invite code");
  const c = escapeHtml(code);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RetroHub invite ${c}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #14161c; color: #e9ecf2; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 480px; padding: 32px 24px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  .code { font: 700 32px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 4px;
          background: #222632; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  a.btn { display: inline-block; background: #3b82f6; color: #fff; text-decoration: none;
          border-radius: 8px; padding: 12px 20px; font-weight: 600; margin-top: 8px; }
  p { color: #aab1c0; }
</style>
</head>
<body>
<main>
  <h1>Joining a RetroHub friend</h1>
  <p id="status">Opening RetroHub&hellip;</p>
  <div class="code" aria-label="Invite code">${c}</div>
  <div id="fallback" hidden>
    <p>RetroHub did not open. If it is not installed yet, get it below, then type the code above into
       Friends &gt; Join with code.</p>
    <a class="btn" href="${SETUP_URL}">Get RetroHub</a>
  </div>
</main>
<script>
  (function () {
    var code = ${JSON.stringify(code)};
    var fallback = document.getElementById("fallback");
    var status = document.getElementById("status");
    var opened = false;
    // If the page loses focus, the protocol handler took over.
    window.addEventListener("blur", function () { opened = true; });
    document.addEventListener("visibilitychange", function () { if (document.hidden) opened = true; });
    window.location.href = "retrohub://join/" + encodeURIComponent(code);
    setTimeout(function () {
      if (!opened) {
        status.textContent = "Looks like RetroHub is not installed on this PC.";
        fallback.hidden = false;
      } else {
        status.textContent = "If RetroHub did not open, use the code below.";
      }
    }, 1500);
  })();
</script>
</body>
</html>`;
}

export function inviteFetch(request, pathname) {
  const raw = pathname.slice("/j/".length);
  const code = normalizeInviteCode(decodeURIComponent(raw));
  if (!isValidInviteCode(code)) {
    return new Response("bad invite code", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(invitePage(code), {
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
