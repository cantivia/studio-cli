/**
 * The standalone page a share link opens (plain HTML + JS, no build step, nothing from the main app).
 * It only talks to /share/api/<token>/... and /share/ws/<token>/..., so a visitor who is allowed in
 * through the share-link Access rule can reach nothing else.
 */
export const guestPage = () => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>studio cli · shared</title>
<link rel="stylesheet" href="/share/_/xterm.css">
<style>
  :root{--ink:#1d1d1f;--muted:#636366;--violet:#6d28d9;--paper:#fbf9f4;--line:rgba(0,0,0,.08)}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 Inter,-apple-system,system-ui,sans-serif;color:var(--ink);background:#fff;min-height:100vh}
  header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(255,255,255,.9);backdrop-filter:blur(8px);z-index:2}
  .brand{font-weight:700;letter-spacing:-.03em;font-size:18px}.brand b{font:800 12px ui-monospace,Menlo,monospace;margin-left:4px}
  h1{font-size:15px;margin:0;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pill{font-size:11px;font-weight:600;border-radius:99px;padding:3px 9px;background:#f0eefa;color:var(--violet);white-space:nowrap}
  .pill.live{background:#e8f7ee;color:#15803d}
  main{padding:20px;max-width:1500px;margin:0 auto}
  button,.btn{font-family:inherit;font-size:13px;font-weight:600;border:0;border-radius:99px;padding:8px 16px;background:var(--ink);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
  button:hover,.btn:hover{background:var(--violet)} button:disabled{opacity:.5;cursor:default}
  .btn.ghost{background:transparent;color:var(--muted)} .btn.ghost:hover{background:#f4f4f6;color:var(--ink)}
  .note{color:var(--muted);font-size:13px;margin:10px 0}
  .msg{border:1px solid var(--line);border-radius:16px;padding:12px 16px;margin:10px 0;white-space:pre-wrap;word-break:break-word;max-width:860px}
  .msg.user{background:#f7f5ff;border-color:#e4defa}.msg small{display:block;color:var(--muted);font-weight:600;margin-bottom:2px;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:16px}
  .pane{border:1px solid var(--line);border-radius:18px;overflow:hidden;background:var(--paper);min-width:0}
  .pane header{position:static;background:transparent;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
  .pane header b{color:var(--ink)} .term{padding:8px;overflow:auto}
  .gone{opacity:.5}
  .err{max-width:420px;margin:15vh auto;text-align:center;color:var(--muted)}
</style></head><body>
<header><span class="brand">studio<b>cli</b></span><h1 id="title">Loading…</h1><span id="badge"></span></header>
<main id="main"></main>
<script src="/share/_/xterm.js"></script>
<script>
(async () => {
  const token = location.pathname.split('/')[2];
  const q = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const api = (p) => fetch('/share/api/' + token + p, { cache: 'no-store' });
  const fail = (msg) => { $('main').replaceChildren(Object.assign(el('div', 'err'), { innerHTML: '<h2 style="color:#1d1d1f">This link doesn\\'t work</h2>' }), el('p', 'err', msg)); $('title').textContent = ''; };

  let meta;
  try { const r = await api(''); if (!r.ok) return fail('It may have expired or been turned off by whoever shared it.'); meta = await r.json(); }
  catch { return fail('The Studio that shared this is offline right now (their computer may be asleep). Try again later.'); }
  $('title').textContent = meta.title;
  document.title = meta.title + ' · studio cli';
  const main = $('main');

  if (meta.kind === 'session') {
    const badge = el('span', 'pill', 'Claude session'); $('badge').append(badge);
    const bar = el('div'); const open = el('button', '', 'Open in my Studio'); bar.append(open, ' ');
    const dl = el('a', 'btn ghost', 'Download'); dl.href = '/share/api/' + token + '/transcript?download=1'; bar.append(dl);
    const hint = el('p', 'note', 'Read-only copy of the conversation. "Open in my Studio" continues it in your own Claude, on your own computer; the sharer\\'s machine is not involved after that.');
    main.append(bar, hint);
    let text = '';
    try { text = await (await api('/transcript')).text(); } catch {}
    const rows = [];
    for (const line of text.split('\\n')) {
      if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.isMeta || r.isSidechain || !r.message) continue;
      const c = r.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\\n') : '';
      if (!t.trim() || /^<(command-|local-command|system-reminder)/.test(t) || t.startsWith('Caveat:')) continue;
      if (r.type === 'user' || r.type === 'assistant') rows.push([r.type, t.length > 6000 ? t.slice(0, 6000) + '…' : t]);
    }
    for (const [who, t] of rows) { const m = el('div', 'msg ' + who); m.append(el('small', '', who === 'user' ? 'You / sharer' : 'Claude'), document.createTextNode(t)); main.append(m); }
    if (!rows.length) main.append(el('p', 'note', 'No messages to show.'));
    // Hand the conversation to the visitor's own Studio, the window that opened this link.
    open.onclick = () => {
      let origin; try { origin = new URL(q.get('from') || '').origin; } catch {}
      if (!window.opener || !origin) { hint.textContent = 'To continue this in your own Studio: open its Shared tab, paste this page\\'s address into "Open a link", and press Open.'; return; }
      window.opener.postMessage({ type: 'studio-session', sessionId: meta.sessionId, project: meta.project, title: meta.title, transcript: text }, origin);
      open.disabled = true; open.textContent = 'Sent to your Studio ✓'; hint.textContent = 'Switch back to your Studio to pick where to continue. You can close this tab.';
    };
    return;
  }

  // Live workspace: one read-only (or typeable) terminal per pane, sized like the real one.
  $('badge').append(el('span', 'pill live', meta.canType ? 'Live · you can type' : 'Live · view only'));
  const grid = el('div', 'grid'); main.append(el('p', 'note', meta.canType ? 'These are real terminals on the sharer\\'s computer. What you type runs there.' : 'You are watching the sharer\\'s terminals live.'), grid);
  const open = new Map();
  const connect = (p) => {
    const box = el('div', 'pane'); const head = el('header'); const b = el('b', '', p.title); head.append(b, document.createTextNode('  ' + p.cwd)); const host = el('div', 'term');
    box.append(head, host); grid.append(box);
    const term = new Terminal({ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, cursorBlink: false, disableStdin: !meta.canType, scrollback: 3000,
      theme: { background: '#fbf9f4', foreground: '#1d1d1f', cursor: '#6d28d9', selectionBackground: '#6d28d933' } });
    term.open(host);
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/share/ws/' + token + '/term/' + p.id);
    ws.onmessage = (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : '';
      if (d.startsWith('\\x00')) { try { const m = JSON.parse(d.slice(1)); if (m.t === 'size') term.resize(m.cols, m.rows); } catch {} return; }
      term.write(d);
    };
    ws.onclose = () => box.classList.add('gone');
    if (meta.canType) term.onData((d) => ws.readyState === 1 && ws.send(d));
    open.set(p.id, { box, ws, term });
  };
  const sync = async () => {
    let m; try { m = await (await api('')).json(); } catch { return; }
    $('title').textContent = m.title;
    const ids = new Set(m.panes.map((p) => p.id));
    for (const p of m.panes) if (!open.has(p.id)) connect(p);
    for (const [id, o] of open) if (!ids.has(id)) { o.ws.close(); o.term.dispose(); o.box.remove(); open.delete(id); }
    if (!m.panes.length && !open.size) grid.replaceChildren(el('p', 'note', 'No terminals are open in this workspace right now.'));
  };
  await sync(); setInterval(sync, 4000);
})();
</script></body></html>`;
