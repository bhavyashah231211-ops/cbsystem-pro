/* CBSystem Restaurant — cloud adapter.
   Loaded AFTER the POS script. It replaces the old direct-Supabase sync with the secure
   multi-tenant function (staff key per business). The POS code itself is not changed. */
(function () {
  'use strict';
  const API = window.CBS_API;
  const KEYK = 'cbs_rest_key', BIZK = 'cbs_rest_biz';

  const BIZ = (function () {
    let b = (new URLSearchParams(location.search).get('biz') || '').trim().toLowerCase();
    try {
      const old = localStorage.getItem(BIZK) || '';
      if (b) { if (old && old !== b) localStorage.removeItem(KEYK); localStorage.setItem(BIZK, b); }
      else b = old;
    } catch (e) {}
    return b;
  })();
  const getKey = () => { try { return localStorage.getItem(KEYK) || ''; } catch (e) { return ''; } };

  let ts = 0, pollT = null, pushT = null, pushing = false, dirty = false, seq = 0, connected = false, gotFirst = false;

  async function call(action, extra) {
    const r = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, biz: BIZ, key: getKey() }, extra || {}))
    });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  }

  /* ---------- local data belongs to one business only ---------- */
  const origLoad = DB.load;
  DB.load = function () {
    try {
      const raw = localStorage.getItem('cbs2');
      const o = raw ? JSON.parse(raw) : null;
      if (o && o._biz !== BIZ) localStorage.removeItem('cbs2');
      this._fresh = !localStorage.getItem('cbs2');
    } catch (e) { this._fresh = true; }
    origLoad.call(this);
    this.d._biz = BIZ;
    if (this.d.cfg) this.d.cfg.cloudMode = true;
  };

  /* ---------- saving ---------- */
  DB.save = function () {
    try { localStorage.setItem('cbs2', JSON.stringify(this.d)); } catch (e) {}
    this._cbs.forEach(fn => { try { fn(); } catch (e) {} });
    if (!this._applyingRemote && connected && gotFirst) queuePush();
  };
  DB._queuePush = queuePush;

  function queuePush() { dirty = true; seq++; clearTimeout(pushT); pushT = setTimeout(doPush, 250); }

  async function doPush() {
    if (pushing) { pushT = setTimeout(doPush, 300); return; }
    pushing = true; const mine = seq; setSyncDot('syncing');
    try {
      const copy = JSON.parse(JSON.stringify(DB.d)); delete copy._biz;
      const r = await call('push', { data: copy });
      if (r.s === 200 && r.j.ok) { ts = r.j.ts; if (seq === mine) dirty = false; setSyncDot('ok'); }
      else if (r.s === 401 || r.s === 403) authFail(r.j);
      else { setSyncDot('off'); pushT = setTimeout(doPush, 5000); }
    } catch (e) { setSyncDot('off'); pushT = setTimeout(doPush, 5000); }
    pushing = false;
  }

  /* ---------- pulling ---------- */
  DB.initCloud = function () {
    clearInterval(pollT); connected = false;
    if (!API || !BIZ || !getKey()) { setSyncDot('off'); return; }
    connected = true; setSyncDot('syncing');
    pull(); pollT = setInterval(pull, 1500);
  };

  async function pull() {
    if (!connected || pushing || dirty) return;
    try {
      const r = await call('pull', { since: ts });
      if (r.s === 401 || r.s === 403) { authFail(r.j); return; }
      if (r.s !== 200) throw new Error('bad');
      if (r.j.unchanged) { setSyncDot('ok'); first(); return; }
      if (!r.j.data) return;
      if (pushing || dirty) return;
      adopt(r.j.data, r.j.ts);
    } catch (e) { setSyncDot('off'); }
  }

  function adopt(data, t) {
    DB._applyingRemote = true;
    const d = DB._safeRemote(data);
    d._biz = BIZ; d.cfg = d.cfg || {}; d.cfg.cloudMode = true;
    DB.d = d; ts = t;
    try { localStorage.setItem('cbs2', JSON.stringify(d)); } catch (e) {}
    DB._cbs.forEach(fn => { try { fn(); } catch (e) {} });
    DB._applyingRemote = false;
    setSyncDot('ok');
    const el = document.getElementById('sb-sync');
    if (el) el.textContent = 'Synced ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    try { initStationScreen(); } catch (e) {}
    first();
  }

  function first() { if (!gotFirst) { gotFirst = true; hideOverlay(); } }

  // Keep the live screens fresh when another device changes something
  DB.sub(function () {
    if (!S.user) return;
    try {
      if (S.station === 'till' && S.view === 'pos-view') renderTG();
      if (S.station === 'waiter' && S.view === 'wpos-view' && !S.selTable) renderWaiterGrid();
    } catch (e) {}
  });

  function authFail(j) {
    connected = false; clearInterval(pollT);
    if (j && j.error === 'suspended') { showMsg('This account is suspended. Please contact support.'); return; }
    try { localStorage.removeItem(KEYK); } catch (e) {}
    showConnect('The staff key is no longer valid. Enter the new key.');
  }

  /* ---------- connect screen ---------- */
  function overlay() {
    let o = document.getElementById('cbs-conn');
    if (!o) {
      o = document.createElement('div'); o.id = 'cbs-conn';
      o.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0a0a0f;display:flex;align-items:center;justify-content:center;padding:20px;font-family:'DM Sans',system-ui,sans-serif;color:#f0f0f8;overflow:auto";
      document.body.appendChild(o);
    }
    return o;
  }
  function hideOverlay() { const o = document.getElementById('cbs-conn'); if (o) o.remove(); }
  function showMsg(text) {
    const o = overlay(); o.innerHTML = '<div style="text-align:center;max-width:340px"><div style="font-family:\'Bebas Neue\',Impact,sans-serif;font-size:2.6rem;letter-spacing:4px;color:#ff6b35">CBSYSTEM</div><p id="cbs-msg" style="margin-top:10px;color:#9090b0"></p></div>';
    document.getElementById('cbs-msg').textContent = text;
  }
  function showConnect(err) {
    const o = overlay();
    o.innerHTML = '<div style="width:100%;max-width:340px"><div style="font-family:\'Bebas Neue\',Impact,sans-serif;font-size:2.6rem;letter-spacing:4px;color:#ff6b35;text-align:center">CBSYSTEM</div>'
      + '<p style="text-align:center;color:#9090b0;margin:4px 0 16px;font-size:.85rem">Connect this device to your business</p>'
      + '<label style="font-size:.72rem;color:#9090b0">Business id</label><input id="cbs-b" autocomplete="off" style="width:100%;margin:4px 0 12px;padding:10px;border-radius:9px;border:1px solid #2a2a40;background:#12121a;color:#f0f0f8;font:inherit">'
      + '<label style="font-size:.72rem;color:#9090b0">Staff key</label><input id="cbs-k" autocomplete="off" style="width:100%;margin:4px 0 12px;padding:10px;border-radius:9px;border:1px solid #2a2a40;background:#12121a;color:#f0f0f8;font:inherit">'
      + '<button id="cbs-go" style="width:100%;padding:12px;border:0;border-radius:10px;background:#ff6b35;color:#fff;font:700 .95rem inherit;cursor:pointer">Connect</button>'
      + '<p id="cbs-err" style="color:#ff4560;font-size:.8rem;min-height:20px;margin-top:10px;text-align:center"></p></div>';
    document.getElementById('cbs-b').value = BIZ;
    document.getElementById('cbs-err').textContent = err || '';
    const go = document.getElementById('cbs-go');
    go.onclick = connect;
    document.getElementById('cbs-k').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  }
  async function connect() {
    const b = document.getElementById('cbs-b').value.trim().toLowerCase();
    const k = document.getElementById('cbs-k').value.trim();
    const err = document.getElementById('cbs-err');
    if (!b || !k) { err.textContent = 'Enter the business id and the staff key'; return; }
    err.textContent = 'Checking…';
    try {
      const r = await call('pull', { biz: b, key: k, since: -1 });
      if (r.s === 200) {
        try { localStorage.setItem(BIZK, b); localStorage.setItem(KEYK, k); if (b !== BIZ) localStorage.removeItem('cbs2'); } catch (e) {}
        location.href = location.pathname + '?biz=' + encodeURIComponent(b);
      } else if (r.s === 403) err.textContent = 'This account is suspended. Please contact support.';
      else err.textContent = 'Business id or staff key not recognised';
    } catch (e) { err.textContent = 'Cannot reach the server. Check the internet connection.'; }
  }
  window.cbsDisconnect = function () {
    if (!confirm('Disconnect this device? You will need the staff key to connect again.')) return;
    try { localStorage.removeItem(KEYK); localStorage.removeItem('cbs2'); } catch (e) {}
    location.href = location.pathname;
  };

  window.addEventListener('load', function () {
    if (!API || /YOUR-PROJECT/.test(API)) { showMsg('Setup needed: edit config.js in the top folder of the repo and paste your Supabase function address.'); return; }
    if (!BIZ || !getKey()) { showConnect(); return; }
    if (DB._fresh) {
      showMsg('Loading your data…');
      setTimeout(function () { if (!gotFirst) showConnect('Cannot reach the server, or the key is wrong. Check and try again.'); }, 9000);
    }
  });

  /* ---------- customer order page / QR codes ---------- */
  window.orderPageUrl = function () {
    return location.origin + location.pathname.replace(/staff\/(index\.html)?$/, 'order/') + '?biz=' + encodeURIComponent(BIZ);
  };
  window.openSelfOrder = function () {
    window.open(orderPageUrl(), 'CBSSelfOrder', 'width=820,height=740,resizable=yes');
    toast('Self-order kiosk opened', '📲', 't-b');
  };
  window.downloadSelfOrderFile = function () {
    const u = orderPageUrl();
    try { navigator.clipboard.writeText(u); } catch (e) {}
    toast('Order page link copied', '📋', 't-g');
  };

  /* ---------- Settings screen tweaks ---------- */
  const QRGUIDE = '<summary style="cursor:pointer;font-size:0.74rem;font-weight:700;color:var(--gold);letter-spacing:1px;text-transform:uppercase;padding:8px 0">ℹ️ How QR Self-Ordering Works (tap to expand)</summary>'
    + '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:6px;font-size:0.74rem;line-height:1.75;color:var(--text2)">'
    + '<ol style="padding-left:18px"><li>Click <b>Generate Table QRs</b> (and Bar QRs), then <b>Print All</b>. Put one QR on each table.</li>'
    + '<li>The customer scans it. Their phone asks staff to confirm the table.</li>'
    + '<li>A <b>🔔 Requests</b> button appears at the top of the till or owner screen. Tap <b>Approve</b>.</li>'
    + '<li>The customer sees your menu, builds an order and taps <b>Place Order</b>. It goes straight to the Kitchen and Bar screens.</li>'
    + '<li>Customers pay at the till. Card payment on the customer\'s phone is not available.</li></ol>'
    + '<p style="margin-top:8px">Only items marked <b>Avail</b> in the Menu Manager are shown. Prices always come from your menu.</p></div>';

  function patchSettings() {
    const m = document.getElementById('s-mode');
    if (m) {
      const card = m.closest('.set-card'), sf = m.closest('.sf');
      if (sf) sf.style.display = 'none';
      const cf = document.getElementById('cloud-fields'); if (cf) cf.style.display = 'none';
      const btn = card && card.querySelector('button[onclick="saveCloud()"]');
      if (btn) {
        const box = document.createElement('div');
        box.innerHTML = '<div style="font-size:0.78rem;line-height:1.7;margin-bottom:8px">☁️ Connected to <b></b><br><span style="color:var(--text2)">Every device using this staff key shares one live system.</span></div>'
          + '<button class="btn btn-o" style="width:100%;font-size:0.72rem" onclick="cbsDisconnect()">Disconnect this device</button>';
        box.querySelector('b').textContent = BIZ;
        btn.replaceWith(box);
      }
    }
    const d = document.querySelector('#ow-set details'); if (d) d.innerHTML = QRGUIDE;
    const u = document.getElementById('qr-base-url'); if (u) u.value = orderPageUrl();
    document.querySelectorAll('#ow-set button[onclick="downloadSelfOrderFile()"]').forEach(b => { b.textContent = '📋 Copy order page link'; });
  }
  const origRenderSet = window.renderSet;
  window.renderSet = function () { origRenderSet(); try { patchSettings(); } catch (e) {} };
})();
