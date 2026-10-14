/** The page a phone sees at <your address>/pair: enter the code shown on your computer (or arrive by scanning its QR code). */
export const pairPage = () => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>Connect to Studio</title>
<link rel="icon" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{--ink:#1d1d1f;--muted:#636366;--violet:#6d28d9;--line:rgba(0,0,0,.1)}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.5 Inter,-apple-system,system-ui,sans-serif;color:var(--ink);
    background:radial-gradient(900px 500px at 15% 0%,#ece6fb 0%,transparent 60%),#fff}
  main{width:min(420px,100%)}
  .brand{font-weight:700;letter-spacing:-.03em;font-size:22px;margin-bottom:28px}.brand b{font:800 13px ui-monospace,Menlo,monospace;margin-left:5px}
  h1{font-size:28px;letter-spacing:-.025em;margin:0 0 8px}
  p{color:var(--muted);margin:0 0 22px}
  input{width:100%;font:600 28px ui-monospace,Menlo,monospace;letter-spacing:.18em;text-align:center;text-transform:uppercase;padding:16px;border:1.5px solid var(--line);border-radius:18px;outline:0;background:#fff}
  input:focus{border-color:var(--violet)}
  button{width:100%;margin-top:14px;font:600 16px inherit;font-family:inherit;border:0;border-radius:99px;padding:15px;background:var(--ink);color:#fff}
  button:disabled{opacity:.45} button:not(:disabled):active{background:var(--violet)}
  .err{margin-top:14px;color:#b42318;font-size:14px;min-height:21px;text-align:center}
</style></head><body><main>
<div class="brand">studio<b>cli</b></div>
<h1>Connect this device</h1>
<p>On your computer, open Studio → Phone &amp; remote access → <b>Add a phone</b>, then type the code it shows.</p>
<input id="code" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" autofocus>
<button id="go" disabled>Connect</button>
<div class="err" id="err"></div>
<script>
const input = document.getElementById('code'), go = document.getElementById('go'), err = document.getElementById('err');
const clean = () => input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
input.addEventListener('input', () => { const c = clean().slice(0, 8); input.value = c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c; go.disabled = c.length !== 8; });
async function submit() {
  go.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: clean() }) });
    if (r.ok) return location.replace('/');
    err.textContent = r.status === 429 ? 'Too many tries. Wait a minute, then try again.' : 'That code didn’t work or has expired. Make a new one on your computer.';
  } catch { err.textContent = 'Couldn’t reach your computer. Is it on and awake?'; }
  go.disabled = clean().length !== 8;
}
go.addEventListener('click', submit);
input.addEventListener('keydown', (e) => e.key === 'Enter' && !go.disabled && submit());
// Arriving from the QR code: the code is in the address after the #. Use it, then remove it from the address bar.
function fromQr() {
  const c = location.hash.slice(1);
  if (!c) return;
  history.replaceState(null, '', location.pathname);
  input.value = c; input.dispatchEvent(new Event('input')); if (!go.disabled) submit();
}
fromQr();
addEventListener('hashchange', fromQr); // scanning a QR code while this page is already open
</script></main></body></html>`;
