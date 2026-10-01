const express = require('express'), http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const E = process.env, PORT = E.PORT || 3000, TRACK = 2200;
let USER, FOLLOW_REQ, MAX, MIN, LAPS, LOBBY;

const DATA = E.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const LB_FILE = path.join(DATA, 'leaderboard.json');
let lb = {};
try { lb = JSON.parse(fs.readFileSync(LB_FILE)); } catch {}
const saveLB = () => fs.writeFile(LB_FILE, JSON.stringify(lb), () => {});
const topLB = () => Object.values(lb).sort((a, b) => b.p - a.p).slice(0, 8);

const CF = path.join(DATA, 'config.json');
const def = { username: (E.TIKTOK_USERNAME || '').replace('@', ''), followRequired: E.FOLLOW_REQUIRED !== 'false',
  maxPlayers: +E.MAX_PLAYERS || 20, minPlayers: +E.MIN_PLAYERS || 2, laps: +E.LAPS || 3, lobbySeconds: +E.LOBBY_SECONDS || 30,
  joinKeywords: 'join,1', nitroGifts: 'rose,heart me', nitroSeconds: 3, rocketGifts: 'coffee,gg', rocketTargets: 2,
  stunSeconds: 4, likeNitro: true, baseSpeed: 100, camMode: 'auto', camTarget: 'leader', camAutoSeconds: 6 };
const cfg = { ...def };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CF))); } catch {}
const list = s => String(s).toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
function apply() { USER = cfg.username.replace('@', ''); FOLLOW_REQ = !!cfg.followRequired; MAX = cfg.maxPlayers; MIN = cfg.minPlayers; LAPS = cfg.laps; LOBBY = cfg.lobbySeconds; }
apply();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (q, r) => r.send('ok'));
const server = http.createServer(app), wss = new WebSocketServer({ server });
const send = o => { const m = JSON.stringify(o); wss.clients.forEach(c => c.readyState === 1 && c.send(m)); };
const feed = (t, k = 'info') => send({ type: 'feed', t, k });
const sendLB = () => send({ type: 'lb', list: topLB() });
wss.on('connection', ws => ws.send(JSON.stringify({ type: 'lb', list: topLB() })));

// ---------- GAME ----------
let phase = 'lobby', timer = LOBBY, raceT = 0, karts = new Map(), queue = new Map(), finished = [];
const followers = new Set(), warned = new Map();
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = u => { const p = u.profilePicture; return (Array.isArray(p?.url) ? p.url[0] : p?.url) || p?.urls?.[0] || ''; };
const isF = (u, d) => followers.has(u.uniqueId) || d.followRole > 0 || u.followRole > 0 ||
  u.followInfo?.followStatus > 0 || u.isFollower === true || d.isFollower === true;

function spawn(u) {
  const id = u.uniqueId, i = karts.size;
  karts.set(id, { id, n: u.nickname || id, av: avatar(u), c: hue(id), d: -Math.floor(i / 5) * 30, s: 0,
    base: cfg.baseSpeed + Math.random() * 10, nz: 0, nitro: 0, turbo: 0, boom: 0, fin: 0, lane: i % 5 });
}

function join(u, d) {
  const id = u.uniqueId;
  if (!id || karts.has(id) || queue.has(id)) return;
  if (FOLLOW_REQ && !isF(u, d)) {
    if (Date.now() - (warned.get(id) || 0) > 20000) { warned.set(id, Date.now()); feed(`@${id} follow dulu baru bisa join! 🔒`, 'warn'); }
    return;
  }
  if (karts.size + queue.size >= MAX) return feed('Grid penuh!', 'warn');
  if (phase === 'lobby') { spawn(u); feed(`🏎️ ${u.nickname || id} masuk grid!`, 'join'); }
  else { queue.set(id, u); feed(`⏳ ${u.nickname || id} masuk antrian race berikutnya`); }
}

function endRace() {
  [...karts.values()].filter(k => !k.fin).sort((a, b) => b.d - a.d).forEach(k => { k.fin = finished.length + 1; k.t = raceT; finished.push(k); });
  const pts = [10, 7, 5, 3];
  finished.forEach((k, i) => {
    const e = lb[k.id] || (lb[k.id] = { n: k.n, av: k.av, w: 0, p: 0, r: 0 });
    e.n = k.n; e.av = k.av; e.r++; e.p += pts[i] || 1; if (i === 0) e.w++;
  });
  saveLB(); phase = 'finished'; timer = 12;
  send({ type: 'results', list: finished.slice(0, 5).map(k => ({ n: k.n, av: k.av, t: +k.t.toFixed(1) })) });
  sendLB();
}

function reset() {
  karts = new Map(); finished = []; phase = 'lobby'; timer = LOBBY;
  for (const u of queue.values()) spawn(u);
  queue = new Map();
}

setInterval(() => {
  const dt = 1 / 30;
  if (phase === 'lobby') { if (karts.size < MIN) timer = LOBBY; else if ((timer -= dt) <= 0) { phase = 'countdown'; timer = 5; } }
  else if (phase === 'countdown') { if ((timer -= dt) <= 0) { phase = 'racing'; raceT = 0; } }
  else if (phase === 'racing') {
    raceT += dt; let run = 0;
    for (const k of karts.values()) {
      if (k.fin) continue; run++;
      k.nz = Math.max(-8, Math.min(8, (k.nz + (Math.random() - .5) * dt * 40) * .98));
      if (k.boom > 0) { k.boom -= dt; k.s *= .8; k.nitro = 0; k.turbo = 0; continue; }
      let m = 1;
      if (k.nitro > 0) { m += .25; k.nitro = Math.max(0, k.nitro - 15 * dt); }
      if (k.turbo > 0) { m += .9; k.turbo -= dt; }
      k.s += ((k.base + k.nz) * m - k.s) * Math.min(1, dt * 3);
      k.d += k.s * dt;
      if (k.d >= TRACK * LAPS) { k.fin = finished.length + 1; k.t = raceT; finished.push(k); }
    }
    if (!run || raceT > 150) endRace();
  } else if (phase === 'finished' && (timer -= dt) <= 0) reset();
}, 1000 / 30);

setInterval(() => send({
  type: 'state', phase, timer: Math.ceil(timer), laps: LAPS, track: TRACK, q: queue.size,
  cam: { m: cfg.camMode, t: cfg.camTarget, a: cfg.camAutoSeconds }, jk: cfg.joinKeywords, ng: cfg.nitroGifts, rg: cfg.rocketGifts,
  karts: [...karts.values()].map(k => ({ id: k.id, n: k.n, av: k.av, c: k.c, d: +k.d.toFixed(1), s: Math.round(k.s),
    nitro: Math.round(k.nitro), turbo: k.turbo > 0, boom: k.boom > 0, fin: k.fin, lane: k.lane }))
}), 100);

// ---------- TIKTOK ----------
const U = d => (d.user?.uniqueId ? d.user : d);
let tt;

function onGift(d) {
  if (d.giftType === 1 && !d.repeatEnd) return;
  const u = U(d), id = u.uniqueId, nm = u.nickname || id, n = Math.min(d.repeatCount || 1, 10);
  const g = String(d.giftName || d.giftDetails?.giftName || '').toLowerCase();
  if (list(cfg.nitroGifts).includes(g)) {
    const k = karts.get(id);
    if (!k) return feed(`🌹 ${nm} kirim ${g}, tapi belum join (komen join / 1)`, 'warn');
    k.turbo = Math.min(15, k.turbo + cfg.nitroSeconds * n);
    feed(`🔥 ${nm} aktifkan NOS x${n}!`, 'gift');
  } else if (list(cfg.rocketGifts).includes(g)) {
    if (phase !== 'racing') return feed(`🚀 ${nm} kirim ${g}, tapi roket hanya aktif saat race`, 'warn');
    for (let i = 0; i < Math.min(n * cfg.rocketTargets, 8); i++) setTimeout(() => fire(id, nm), i * 400);
  }
}

function fire(by, nm) {
  if (phase !== 'racing') return;
  let c = [...karts.values()].filter(k => !k.fin && k.id !== by && k.boom <= 0);
  if (!c.length) c = [...karts.values()].filter(k => !k.fin && k.boom <= 0);
  if (!c.length) return;
  const t = c[Math.floor(Math.random() * c.length)];
  send({ type: 'boom', id: t.id });
  feed(`🚀 ${nm} meledakkan ${t.n}! 💥`, 'gift');
  setTimeout(() => { t.boom = cfg.stunSeconds; t.s = 0; t.d = Math.max(0, t.d - 30); }, 700);
}
function connectTT() {
  if (!USER) return console.log('Isi env TIKTOK_USERNAME (tanpa @)');
  try { tt && tt.disconnect(); } catch {}
  const c = tt = new TikTokLiveConnection(USER);
  c.on(WebcastEvent.CHAT, d => { const t = (d.comment || '').trim().toLowerCase(); if (list(cfg.joinKeywords).includes(t)) join(U(d), d); });
  c.on(WebcastEvent.FOLLOW, d => { const u = U(d); followers.add(u.uniqueId); feed(`➕ ${u.nickname || u.uniqueId} follow! Komen "join" / "1"`, 'follow'); });
  c.on(WebcastEvent.LIKE, d => { const k = karts.get(U(d).uniqueId); if (k && cfg.likeNitro) k.nitro = Math.min(100, k.nitro + (d.likeCount || 1) * 3); });
  c.on(WebcastEvent.GIFT, onGift);
  c.on(ControlEvent.CONNECTED, s => { console.log('Terhubung, room', s.roomId); feed('✅ Terhubung ke TikTok Live'); });
  c.on(ControlEvent.DISCONNECTED, () => { if (tt !== c) return; feed('⚠️ Terputus, mencoba lagi...', 'warn'); setTimeout(connectTT, 10000); });
  c.on(ControlEvent.ERROR, e => console.error('TT error:', e?.message || e));
  c.connect().catch(e => { if (tt !== c) return; console.error('Gagal connect:', e?.message || e); setTimeout(connectTT, 15000); });
}

// Tes tanpa live: /api/sim?key=ADMIN_KEY&n=8
app.get('/api/sim', (q, r) => {
  if (!E.ADMIN_KEY || q.query.key !== E.ADMIN_KEY) return r.sendStatus(403);
  for (let i = 0; i < (+q.query.n || 5); i++) { const id = 'bot' + Math.random().toString(36).slice(2, 6); join({ uniqueId: id, nickname: 'Bot ' + id.slice(3) }, { followRole: 1 }); }
  r.send('ok');
});

// ---------- ADMIN ----------
app.use(express.json());
const auth = (q, r, n) => (E.ADMIN_KEY && q.query.key === E.ADMIN_KEY ? n() : r.status(403).json({ error: 'ADMIN_KEY salah / belum diset' }));
app.get('/api/config', auth, (q, r) => r.json(cfg));
app.post('/api/config', auth, (q, r) => {
  for (const k in def) {
    if (!(k in q.body)) continue;
    const v = q.body[k], t = typeof def[k];
    cfg[k] = t === 'number' ? (+v || def[k]) : t === 'boolean' ? (v === true || v === 'true') : String(v);
  }
  const old = USER; apply();
  fs.writeFile(CF, JSON.stringify(cfg), () => {});
  if (USER !== old) connectTT();
  r.json(cfg);
});
app.post('/api/action', auth, (q, r) => {
  const a = q.body.do;
  if (a === 'sim') for (let i = 0; i < (+q.body.n || 5); i++) { const id = 'bot' + Math.random().toString(36).slice(2, 6); join({ uniqueId: id, nickname: 'Bot ' + id.slice(3) }, { followRole: 1 }); }
  if (a === 'start' && phase === 'lobby' && karts.size) { phase = 'countdown'; timer = 5; }
  if (a === 'reset') reset();
  r.json({ ok: 1 });
});

server.listen(PORT, () => { console.log('Server jalan di port', PORT); connectTT(); });
