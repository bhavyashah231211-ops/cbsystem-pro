// CBSystem Restaurant multi-tenant API. Deploy as an Edge Function named exactly: cbs-rest
// Settings: "Verify JWT with legacy secret" must be OFF. Secret required: ADMIN_KEY (20+ characters).
// Table: cbs_rest_tenants (see setup.sql)
import { createClient } from 'npm:@supabase/supabase-js@2';

const T = 'cbs_rest_tenants';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ADMIN_KEY = Deno.env.get('ADMIN_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-key, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const now = () => new Date().toISOString();

async function sha256(s: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function newKey() {
  const c = [...rand(24)].map((b) => ALPHA[b % ALPHA.length]);
  return [0, 4, 8, 12, 16, 20].map((i) => c.slice(i, i + 4).join('')).join('-');
}
function pin(n: number) {
  let p = '';
  do { p = [...rand(n)].map((b) => b % 10).join(''); }
  while (/^(\d)\1+$/.test(p) || '01234567890'.includes(p) || '98765432109'.includes(p));
  return p;
}

// What a brand-new, empty business starts with (no demo menu).
function seed(name: string, p: Record<string, string>) {
  return {
    staff: [
      { id: 'OWN', name: 'Owner', pin: p.owner, role: 'owner', color: '#ffd700', emoji: '👑', active: true },
      { id: 'MGR', name: 'Manager', pin: p.manager, role: 'manager', color: '#ff6b35', emoji: '👨‍💼', active: true },
      { id: 'ST1', name: 'Waiter', pin: p.waiter, role: 'waiter', color: '#4a9eff', emoji: '🧑‍🍳', active: true },
      { id: 'ST2', name: 'Bar', pin: p.bar, role: 'bar', color: '#9b59b6', emoji: '🍺', active: true },
      { id: 'ST3', name: 'Kitchen', pin: p.kitchen, role: 'kitchen', color: '#2dd4a0', emoji: '👨‍🍳', active: true },
    ],
    menu: [], tOrders: {}, kOrders: [], bOrders: [], txns: [], bkgs: [], voids: [], drawerLog: [], tableApprovals: {}, idc: 0,
    cfg: {
      venueName: name, venueAddr: '', venueTel: '', tableCount: 20, barSeats: 8, vatRate: 20,
      serviceCharge: false, serviceChargeRate: 10, currency: '£', receiptFooter: 'Thank you for visiting!',
      cloudMode: true, supabaseUrl: '', supabaseKey: '', venueCode: '', selfOrderUrl: '', sumupCode: '', syncInterval: 5000, lastSync: null,
    },
  };
}

/* ---------------- ADMIN (you only) ---------------- */
async function admin(req: Request, action: string, b: any) {
  const given = req.headers.get('x-admin-key') ?? '';
  if (ADMIN_KEY.length < 20 || !same(given, ADMIN_KEY)) { await sleep(500); return json({ error: 'Wrong admin key' }, 401); }

  if (action === 'admin_list') {
    const { data, error } = await sb.from(T).select('id,name,active,created_at,updated_at').order('created_at', { ascending: false });
    if (error) throw error;
    return json({ ok: true, businesses: data });
  }
  if (action === 'admin_create') {
    const name = String(b.name ?? '').trim().slice(0, 80);
    const id = String(b.id ?? '').trim().toLowerCase();
    if (!name || !ID_RE.test(id)) return json({ error: 'Enter a business name and an id (a-z, 0-9, dashes; 2-39 characters)' }, 400);
    const key = newKey();
    const pins = { owner: pin(6), manager: pin(4), waiter: pin(4), bar: pin(4), kitchen: pin(4) };
    const { error } = await sb.from(T).insert({ id, name, key_hash: await sha256(norm(key)), key_plain: key, data: seed(name, pins), ts: Date.now() });
    if (error) return json({ error: error.code === '23505' ? 'That id is already taken' : 'Could not create the business' }, error.code === '23505' ? 409 : 500);
    return json({ ok: true, id, name, staffKey: key, ownerPin: pins.owner, managerPin: pins.manager, waiterPin: pins.waiter, barPin: pins.bar, kitchenPin: pins.kitchen });
  }
  const id = String(b.id ?? '').toLowerCase();
  if (!ID_RE.test(id)) return json({ error: 'Bad id' }, 400);
  if (action === 'admin_setActive') {
    const { data, error } = await sb.from(T).update({ active: !!b.active }).eq('id', id).select('id');
    if (error) throw error;
    return json(data?.length ? { ok: true } : { error: 'Business not found' }, data?.length ? 200 : 404);
  }
  if (action === 'admin_resetKey') {
    const key = newKey();
    const { data, error } = await sb.from(T).update({ key_hash: await sha256(norm(key)), key_plain: key }).eq('id', id).select('id');
    if (error) throw error;
    return json(data?.length ? { ok: true, staffKey: key } : { error: 'Business not found' }, data?.length ? 200 : 404);
  }
  if (action === 'admin_details') {
    const { data, error } = await sb.from(T).select('id,name,active,created_at,updated_at,key_plain,data').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: 'Business not found' }, 404);
    const d: any = data.data ?? {};
    return json({
      ok: true, id: data.id, name: data.name, active: data.active,
      created_at: data.created_at, updated_at: data.updated_at, version: 0,
      staffKey: data.key_plain ?? null,
      products: Array.isArray(d.menu) ? d.menu.length : 0,
      staff: (d.staff ?? []).map((s: any) => ({ name: s.name, role: s.role, pin: s.pin })),
    });
  }
  if (action === 'admin_delete') {
    if (String(b.confirm ?? '').toLowerCase() !== id) return json({ error: 'Type the business id to confirm' }, 400);
    const { data, error } = await sb.from(T).delete().eq('id', id).select('id');
    if (error) throw error;
    return json(data?.length ? { ok: true } : { error: 'Business not found' }, data?.length ? 200 : 404);
  }
  return json({ error: 'Unknown action' }, 400);
}

/* ---------------- STAFF APP (needs the staff key) ---------------- */
async function staff(action: string, b: any) {
  const id = String(b.biz ?? '').toLowerCase();
  const key = norm(String(b.key ?? ''));
  const bad = async () => { await sleep(500); return json({ error: 'Invalid business or key' }, 401); };
  if (!ID_RE.test(id) || !key) return bad();
  const { data: row } = await sb.from(T).select('name,key_hash,active,ts').eq('id', id).maybeSingle();
  if (!row || !same(row.key_hash, await sha256(key))) return bad();
  if (!row.active) return json({ error: 'suspended' }, 403);

  if (action === 'pull') {
    if (Number(b.since) === Number(row.ts)) return json({ ok: true, unchanged: true, ts: row.ts, name: row.name });
    const { data, error } = await sb.from(T).select('data,ts').eq('id', id).single();
    if (error) throw error;
    return json({ ok: true, ts: data.ts, data: data.data, name: row.name });
  }
  if (action === 'push') {
    const d = b.data;
    if (!d || typeof d !== 'object' || !Array.isArray(d.staff) || !d.staff.length || !d.tOrders || typeof d.tOrders !== 'object')
      return json({ error: 'Bad save request' }, 400);
    const ts = Math.max(Date.now(), Number(row.ts) + 1);
    const { error } = await sb.from(T).update({ data: d, ts, updated_at: now() }).eq('id', id);
    if (error) throw error;
    return json({ ok: true, ts });
  }
  return json({ error: 'Unknown action' }, 400);
}

/* ---------------- CUSTOMER ORDER PAGE (no key; locked down) ---------------- */
const tableOk = (D: any, t: string) => {
  const m = /^([TB])(\d{1,3})$/.exec(t);
  if (!m) return false;
  const n = Number(m[2]);
  return n >= 1 && n <= (m[1] === 'T' ? (D.cfg?.tableCount || 20) : (D.cfg?.barSeats || 8));
};
const occupied = (D: any) => Object.keys(D.tOrders ?? {}).filter((k) => D.tOrders[k]?.items?.length);

async function getTenant(id: string) {
  const { data: row } = await sb.from(T).select('name,active,data').eq('id', id).maybeSingle();
  return row && row.active ? row : null;
}

// Read-modify-write with compare-and-set so staff saves and customer orders never overwrite each other half-way.
async function mutate(id: string, fn: (D: any) => any) {
  for (let i = 0; i < 5; i++) {
    const { data: row } = await sb.from(T).select('data,ts,active').eq('id', id).maybeSingle();
    if (!row || !row.active) return { error: 'This ordering page is unavailable', code: 404 };
    const out = fn(row.data);
    if (out.error || out.nochange) return out;
    const ts = Math.max(Date.now(), Number(row.ts) + 1);
    const { data } = await sb.from(T).update({ data: row.data, ts, updated_at: now() }).eq('id', id).eq('ts', row.ts).select('ts');
    if (data?.length) return out;
  }
  return { error: 'Busy, please try again', code: 503 };
}
const reply = (o: any) => { const c = o.code; delete o.code; delete o.nochange; return json(o, o.error ? (c || 400) : 200); };

async function customer(action: string, b: any) {
  const id = String(b.biz ?? '').toLowerCase();
  if (!ID_RE.test(id)) return json({ error: 'This ordering page is unavailable' }, 404);
  const t = String(b.table ?? '').toUpperCase();
  const ot = b.orderType === 'takeaway' ? 'takeaway' : 'dineIn';

  if (action === 'so_info' || action === 'so_tables') {
    const row = await getTenant(id);
    if (!row) return json({ error: 'This ordering page is unavailable' }, 404);
    const D: any = row.data;
    if (action === 'so_tables') return json({ occupied: occupied(D) });
    const c = D.cfg ?? {};
    return json({
      name: c.venueName || row.name, currency: c.currency || '£', vatRate: c.vatRate ?? 20,
      svc: !!c.serviceCharge, svcRate: c.serviceChargeRate ?? 10,
      tableCount: c.tableCount || 20, barSeats: c.barSeats || 8, occupied: occupied(D),
      menu: (D.menu ?? []).filter((m: any) => m.available !== false)
        .map((m: any) => ({ id: m.id, name: m.name, price: Number(m.price) || 0, category: m.category, emoji: m.emoji, dest: m.dest === 'bar' ? 'bar' : 'kitchen', img: m.img || null })),
    });
  }
  if (action === 'so_status') {
    const row = await getTenant(id);
    if (!row) return json({ error: 'This ordering page is unavailable' }, 404);
    const a = (row.data as any).tableApprovals?.[t];
    let status = a?.status ?? 'none';
    if (status === 'approved' && Date.now() - (a.respondedAt || 0) > 30 * 60000) status = 'none';
    return json({ status });
  }
  if (action === 'so_request') {
    return reply(await mutate(id, (D) => {
      if (!tableOk(D, t)) return { error: 'Unknown table' };
      D.tableApprovals = D.tableApprovals ?? {};
      if (D.tableApprovals[t]?.status === 'pending') return { ok: true, nochange: true };
      D.tableApprovals[t] = { status: 'pending', orderType: ot, requestedAt: Date.now() };
      return { ok: true };
    }));
  }
  if (action === 'so_clear') {
    return reply(await mutate(id, (D) => {
      const a = D.tableApprovals?.[t];
      if (!a || a.status === 'approved') return { ok: true, nochange: true };
      delete D.tableApprovals[t];
      return { ok: true };
    }));
  }
  if (action === 'so_order') {
    const lines = Array.isArray(b.items) ? b.items.slice(0, 40) : [];
    return reply(await mutate(id, (D) => {
      if (!lines.length) return { error: 'Your order is empty' };
      if (ot === 'takeaway') {
        if (!/^TA-\d{4}$/.test(t)) return { error: 'Bad takeaway reference' };
      } else {
        if (!tableOk(D, t)) return { error: 'Unknown table' };
        const a = D.tableApprovals?.[t];
        if (!a || a.status !== 'approved' || Date.now() - (a.respondedAt || 0) > 30 * 60000)
          return { error: 'Please ask a member of staff to confirm your table first' };
      }
      const menu = new Map((D.menu ?? []).filter((m: any) => m.available !== false).map((m: any) => [m.id, m]));
      const ts = Date.now();
      const items: any[] = [];
      for (const l of lines) {
        const m: any = menu.get(String(l.id));
        const q = Math.floor(Number(l.qty));
        if (!m || !(q >= 1) || q > 20) return { error: 'An item is no longer available. Please refresh the page.' };
        items.push({ id: m.id, name: m.name, price: Number(m.price) || 0, qty: q, dest: m.dest === 'bar' ? 'bar' : 'kitchen', emoji: m.emoji || '🍽', note: '', sent: true, by: 'Self Order', at: ts, paid: false, payMethod: 'till' });
      }
      D.tOrders = D.tOrders ?? {}; D.kOrders = D.kOrders ?? []; D.bOrders = D.bOrders ?? [];
      const o = D.tOrders[t] ?? (D.tOrders[t] = { items: [], covers: 1, note: '', openedAt: ts, openedBy: 'Self Order', orderType: ot });
      if (!Array.isArray(o.items)) o.items = [];
      o.orderType = ot;
      o.note = (o.note ? o.note + ' · ' : '') + '🧾 Pay at till';
      o.items.push(...items.map((i) => ({ ...i })));
      const sfx = Math.random().toString(36).slice(2, 5);
      const k = items.filter((i) => i.dest === 'kitchen');
      if (k.length) D.kOrders.push({ id: 'SO' + ts + sfx, table: t, items: k, status: 'new', time: ts, staff: 'Self Order', covers: o.covers || 1, note: ot === 'takeaway' ? '🥡 TAKEAWAY' : '', orderType: ot });
      const br = items.filter((i) => i.dest === 'bar');
      if (br.length) D.bOrders.push({ id: 'SO' + ts + sfx + 'B', table: t, items: br, status: 'new', time: ts, staff: 'Self Order', orderType: ot });
      if (ot === 'dineIn' && D.tableApprovals) delete D.tableApprovals[t];
      return { ok: true, ref: '#' + String(ts).slice(-5) };
    }));
  }
  return json({ error: 'Unknown action' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (Number(req.headers.get('content-length') ?? 0) > 9_000_000) return json({ error: 'Too large' }, 413);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const action = String(b?.action ?? '');
  try {
    if (action.startsWith('admin_')) return await admin(req, action, b);
    if (action.startsWith('so_')) return await customer(action, b);
    return await staff(action, b);
  } catch (e) {
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
