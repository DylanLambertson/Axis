// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shared behaviour for mockups B and C: screen switching, view control, decisions, palette, keyboard, theme.
(function () {
  var P = 'acme-web <i>›</i> ';
  var screens = {
    home: ['<b>acme-web</b>', 'Project home, acme-web'],
    dash: [P + '<b>Workspaces</b>', 'Workspaces'],
    ws: [P + 'Workspaces <i>›</i> <b>Fix proration rounding</b> <i>›</i> <span class="mono">fix/proration-rounding</span>', 'Workspace view, Fix proration rounding'],
    rv: [P + '<b>Fix proration rounding</b> <i>›</i> Review', 'Diff review'],
    agents: [P + 'Agents <i>›</i> <b>Billing squad</b>', 'Agents, Billing squad'],
    thread: [P + 'Threads <i>›</i> <b>Planner ↔ Invoice migrator</b>', 'Thread, Planner and Invoice migrator'],
    code: [P + 'Billing squad <i>›</i> <b>Proration fixer</b> <i>›</i> code panel', 'Workspace with code panel'],
    pages: [P + 'Pages <i>›</i> <b>Billing rounding policy</b>', 'Pages'],
    plugins: [P + 'Plugins <i>›</i> <b>Test reporter</b>', 'Plugins'],
    tasks: [P + 'Tasks <i>›</i> <b>Fix proration rounding</b>', 'Tasks'],
    integ: [P + 'Integrations <i>›</i> <b>GitHub</b>', 'Integrations'],
    ide: ['payments-core <i>›</i> <b>Local checkout</b>', 'IDE view, local checkout']
  };
  var live = document.getElementById('live'), cur = 'home';
  function q(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function say(t) { live.textContent = ''; setTimeout(function () { live.textContent = t; }, 30); }
  function show(n, focus) {
    if (!screens[n]) n = 'home';
    cur = n;
    q('.view').forEach(function (v) { v.hidden = v.id !== 'v-' + n; });
    document.getElementById('crumb').innerHTML = screens[n][0];
    q('.screens button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.go === n)); });
    q('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === (n === 'ide' ? 'ide' : 'agent'))); });
    q('.nav [data-go], .spine [data-go]').forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.go === n || (b.dataset.go === 'dash' && (n === 'ws' || n === 'rv')))); });
    var sb = document.getElementById('sbranch'); if (sb) sb.textContent = n === 'ide' ? 'main' : 'fix/proration-rounding';
    say(screens[n][1]);
    if (focus) {
      var t = n === 'rv' ? document.querySelector('#v-rv .hunk-act button') : document.querySelector('#v-' + n + ' .row, #v-' + n + ' .tr[data-go], #v-' + n + ' .li[aria-current="true"], #v-' + n + ' textarea, #v-' + n + ' .code');
      if (t) t.focus();
    }
    try { history.replaceState(null, '', '#' + n); } catch (e) { /* file: URLs in some browsers */ }
  }
  function pressOne(btn) { q('button', btn.parentNode).forEach(function (x) { x.setAttribute('aria-pressed', String(x === btn)); }); }
  function tally() {
    var hs = q('#v-rv .hunk-act'), d = 0, a = 0, pills = q('#meter i');
    hs.forEach(function (h, k) {
      var p = h.querySelector('[aria-pressed="true"]');
      if (p) { d++; if (p.classList.contains('a')) a++; }
      if (pills[k]) pills[k].className = p ? (p.classList.contains('a') ? 'a' : 'r') : '';
    });
    var dec = document.getElementById('decided'), acc = document.getElementById('accepted');
    if (dec) dec.textContent = d + ' of ' + hs.length + ' hunks decided';
    if (acc) acc.textContent = a + ' of ' + hs.length + ' hunks accepted';
    say(d + ' of ' + hs.length + ' hunks decided, ' + a + ' accepted');
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.dataset.go) { show(t.dataset.go, !t.closest('.screens')); return; }
    if (t.dataset.view) {
      show(t.dataset.view === 'ide' ? 'ide' : (cur === 'ide' ? 'home' : cur));
      if (t.dataset.view === 'split') { pressOne(t); say('Split view is not drawn in this mockup'); }
      return;
    }
    if (t.closest('.hunk-act')) {
      var on = t.getAttribute('aria-pressed') === 'true';
      q('button', t.parentNode).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
      t.setAttribute('aria-pressed', String(!on)); tally(); return;
    }
    if (t.classList.contains('li') && !t.dataset.go) { q('.li', t.parentNode).forEach(function (x) { x.removeAttribute('aria-current'); }); t.setAttribute('aria-current', 'true'); return; }
    if (t.closest('.filters,.chips,.modes,.ttabs,.tabs') && t.hasAttribute('aria-pressed')) { pressOne(t); }
  });
  function decide(ok) {
    var d = document.getElementById('decision'); if (!d) return;
    var ev = document.createElement('div'); ev.className = 'ev new';
    ev.innerHTML = '<span class="node ping">' + (ok ? '✓' : '×') + '</span><span><b>' + (ok ? 'Approved once' : 'Denied') + '</b> by you: <code>npm test -- billing</code>' + (ok ? '. Running in the worktree.' : '. The agent will propose another step.') + '</span><time>14:06</time>';
    d.replaceWith(ev);
    document.getElementById('wsstate').innerHTML = '<span class="g g-run" aria-hidden="true"></span>Running';
    say(ok ? 'Approved once. Agent running.' : 'Denied.'); document.getElementById('ask').focus();
  }
  document.getElementById('approve').addEventListener('click', function () { decide(true); });
  document.getElementById('deny').addEventListener('click', function () { decide(false); });
  var pause = document.getElementById('pause'), stop = document.getElementById('stopthread');
  pause.addEventListener('click', function () {
    var p = pause.getAttribute('aria-pressed') !== 'true';
    pause.setAttribute('aria-pressed', String(p)); pause.textContent = p ? 'Resume relay' : 'Pause relay';
    say(p ? 'Relay paused. Messages are held until you resume.' : 'Relay resumed.');
  });
  stop.addEventListener('click', function () {
    document.getElementById('msgs').insertAdjacentHTML('beforeend', '<div class="sysmsg new"><span class="g g-bad" aria-hidden="true"></span><span><b>Stopped by you.</b> Axis relays no more messages in this thread. Both agents keep running.</span><time class="sub mono">14:15</time></div>');
    stop.disabled = true; pause.disabled = true; say('Thread stopped. Both agents keep running.'); document.getElementById('tmsg').focus();
  });
  var ed = document.getElementById('minied'), dirty = document.getElementById('dirty');
  function setDirty(d) { dirty.innerHTML = '<span class="g g-' + (d ? 'wait' : 'idle') + '" aria-hidden="true"></span><span>' + (d ? 'unsaved' : 'saved') + '</span>'; }
  ed.addEventListener('input', function () { setDirty(true); });
  function save() { setDirty(false); say('Saved src/billing/proration.ts. Listed as changed outside the agent.'); }
  document.getElementById('save').addEventListener('click', save);
  var pal = document.getElementById('palette'), opener = null;
  function openPal() { opener = document.activeElement; pal.showModal(); document.getElementById('q').focus(); }
  document.getElementById('cmdopen').addEventListener('click', openPal);
  pal.addEventListener('close', function () { if (opener) opener.focus(); });
  pal.addEventListener('keydown', function (e) { if (e.key === 'Enter') { pal.close(); show('ws', true); } });
  document.addEventListener('keydown', function (e) {
    var typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName), mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
    if (mod && e.key.toLowerCase() === 's' && document.activeElement === ed) { e.preventDefault(); save(); return; }
    if (cur === 'ws' && mod && e.key === 'Enter' && document.getElementById('decision')) { e.preventDefault(); decide(true); return; }
    if (typing || mod || (cur !== 'dash' && cur !== 'home' && cur !== 'agents')) return;
    if (e.key === 'j' || e.key === 'k') {
      var rows = q('#v-' + cur + ' .row, #v-' + cur + ' button.tr'), i = rows.indexOf(document.activeElement);
      i = e.key === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1); rows[i].focus(); e.preventDefault();
    }
  });
  document.getElementById('theme').addEventListener('click', function () {
    var r = document.documentElement, c = r.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    r.setAttribute('data-theme', c === 'dark' ? 'light' : 'dark'); say((c === 'dark' ? 'Light' : 'Dark') + ' theme');
  });
  show((location.hash || '').slice(1), false);
})();
