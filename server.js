'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { AccessToken } = require('livekit-server-sdk');

const { PORT = 3000, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, ADMIN_KEY, ACCESS_CODE, BANNED = '' } = process.env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Faltam as variáveis LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET.');
  process.exit(1);
}

const CHANNELS = [0, 1, 2, 3, 4];
const MAX_TALK_MS = 45000;
const TTL = { blitz: 60 * 60e3, chuva: 30 * 60e3, acidente: 45 * 60e3 };
const KINDS = Object.keys(TTL);

// ---------- estado (em memória: reiniciar o servidor apaga alertas e sessões) ----------
const BAN_FILE = path.join(__dirname, 'bans.json');
let bans = new Set(BANNED.split(',').map(s => s.replace(/\D/g, '')).filter(Boolean));
try { JSON.parse(fs.readFileSync(BAN_FILE, 'utf8')).forEach(w => bans.add(w)); } catch {}
const saveBans = () => { try { fs.writeFileSync(BAN_FILE, JSON.stringify([...bans])); } catch (e) { console.error(e.message); } };

const sessions = new Map(); // sid (segredo) -> sessão
const floor = {};           // canal -> quem está com a palavra
const alerts = new Map();   // id -> alerta
const reports = [];

// ---------- utilidades ----------
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const num = (v, min, max) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;
const cleanLoc = l => (l && num(l.lat, -90, 90) && num(l.lng, -180, 180))
  ? { lat: l.lat, lng: l.lng, acc: num(l.acc, 0, 1e5) ? Math.round(l.acc) : null } : null;
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const online = () => [...sessions.values()].filter(s => s.ws);
const members = ch => online().filter(s => s.ch === ch);
const toChannel = (ch, m) => members(ch).forEach(s => send(s.ws, m));
const visibleTo = (s, a) => s.ch !== null && (s.ch === a.ch || s.ch === 0 || a.ch === 0);
const toAudience = (a, m) => online().forEach(s => visibleTo(s, a) && send(s.ws, m));
const pub = a => ({ id: a.id, kind: a.kind, ch: a.ch, by: a.by, uid: a.uid, ts: a.ts, upd: a.upd, loc: a.loc });
const visibleAlerts = s => [...alerts.values()].filter(a => visibleTo(s, a)).map(pub);
const sendCounts = () => {
  const counts = {};
  CHANNELS.forEach(c => (counts[c] = members(c).length));
  online().forEach(s => send(s.ws, { t: 'counts', counts }));
};
const delAlert = a => { alerts.delete(a.id); toAudience(a, { t: 'alert_del', id: a.id }); };

function releaseFloor(s) {
  for (const ch of CHANNELS) {
    const f = floor[ch];
    if (f && f.uid === s.uid) {
      clearTimeout(f.timer);
      delete floor[ch];
      toChannel(ch, { t: 'floor', uid: null, name: null });
    }
  }
}
function leave(s) { releaseFloor(s); s.ch = null; }
function kick(wa, why) {
  for (const [sid, s] of sessions) {
    if (s.wa !== wa) continue;
    send(s.ws, { t: 'kicked', why });
    leave(s);
    try { s.ws && s.ws.close(); } catch {}
    sessions.delete(sid);
  }
  sendCounts();
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.get('/vendor/livekit-client.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/livekit-client/dist/livekit-client.umd.js')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const hits = new Map();
app.post('/api/login', (req, res) => {
  const now = Date.now();
  const h = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(req.ip, h);
  if (h.length > 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });

  const { name, whatsapp, code, consent } = req.body || {};
  const nm = String(name || '').trim().slice(0, 24);
  const wa = String(whatsapp || '').replace(/\D/g, '');
  if (!consent) return res.status(400).json({ error: 'É preciso aceitar os termos para continuar.' });
  if (nm.length < 2) return res.status(400).json({ error: 'Digite seu nome.' });
  if (wa.length < 10 || wa.length > 13) return res.status(400).json({ error: 'WhatsApp inválido (use DDD + número).' });
  if (ACCESS_CODE && !safeEq(code, ACCESS_CODE)) return res.status(403).json({ error: 'Código do piloto inválido.' });
  if (bans.has(wa)) return res.status(403).json({ error: 'Acesso bloqueado.' });

  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { sid, uid: crypto.randomBytes(6).toString('hex'), name: nm, wa, ch: null, ws: null, lastAlert: 0, lastLoc: 0, seen: now });
  res.json({ sid });
});

// ---------- admin ----------
const admin = (req, res, next) =>
  (ADMIN_KEY && safeEq(req.get('x-admin-key'), ADMIN_KEY)) ? next() : res.status(401).json({ error: 'unauthorized' });
app.get('/admin/online', admin, (req, res) =>
  res.json(online().map(s => ({ name: s.name, whatsapp: s.wa, channel: s.ch }))));
app.get('/admin/reports', admin, (req, res) => res.json(reports));
app.post('/admin/ban', admin, (req, res) => {
  const wa = String((req.body || {}).whatsapp || '').replace(/\D/g, '');
  if (!wa) return res.status(400).json({ error: 'whatsapp obrigatório' });
  bans.add(wa); saveBans(); kick(wa, 'Você foi removido do canal.');
  res.json({ banned: wa });
});
app.post('/admin/unban', admin, (req, res) => {
  const wa = String((req.body || {}).whatsapp || '').replace(/\D/g, '');
  bans.delete(wa); saveBans(); res.json({ unbanned: wa });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  const sid = new URL(req.url, 'http://x').searchParams.get('sid');
  const s = sessions.get(sid);
  if (!s || bans.has(s.wa)) { ws.close(4001, 'auth'); return; }

  // um aparelho por WhatsApp
  for (const o of sessions.values()) {
    if (o !== s && o.wa === s.wa && o.ws) {
      send(o.ws, { t: 'kicked', why: 'Sua conta foi aberta em outro aparelho.' });
      try { o.ws.close(); } catch {}
    }
  }
  if (s.ws && s.ws !== ws) { try { s.ws.close(); } catch {} }
  s.ws = ws; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', uid: s.uid });

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();

    switch (m.t) {
      case 'join': {
        const ch = Number(m.ch);
        if (!CHANNELS.includes(ch)) return;
        leave(s); s.ch = ch;
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: s.uid, name: s.name, ttl: '2h' });
        at.addGrant({ roomJoin: true, room: 'bh-ch' + ch, canPublish: true, canSubscribe: true, canPublishData: false });
        const token = await at.toJwt();
        const f = floor[ch];
        send(ws, { t: 'joined', ch, url: LIVEKIT_URL, token, floor: f ? { uid: f.uid, name: f.name } : null, alerts: visibleAlerts(s) });
        sendCounts();
        break;
      }
      case 'ptt_down': {
        const ch = s.ch; if (ch === null) return;
        const f = floor[ch];
        if (f && f.uid !== s.uid) return send(ws, { t: 'ptt_busy', name: f.name });
        if (f) clearTimeout(f.timer);
        const timer = setTimeout(() => {
          if (floor[ch] && floor[ch].uid === s.uid) {
            delete floor[ch];
            send(s.ws, { t: 'ptt_timeout' });
            toChannel(ch, { t: 'floor', uid: null, name: null });
          }
        }, MAX_TALK_MS);
        floor[ch] = { uid: s.uid, name: s.name, wa: s.wa, timer };
        send(ws, { t: 'ptt_ok' });
        toChannel(ch, { t: 'floor', uid: s.uid, name: s.name });
        break;
      }
      case 'ptt_up': releaseFloor(s); break;

      case 'alert': {
        if (s.ch === null || !KINDS.includes(m.kind)) return;
        if (now - s.lastAlert < 15000) return send(ws, { t: 'toast', msg: 'Aguarde alguns segundos para enviar outro alerta.' });
        s.lastAlert = now;
        const a = { id: crypto.randomUUID(), kind: m.kind, ch: s.ch, by: s.name, uid: s.uid, ts: now, upd: now, gone: [],
                    loc: m.kind === 'blitz' ? cleanLoc(m.loc) : null };
        alerts.set(a.id, a);
        toAudience(a, { t: 'alert', alert: pub(a) });
        break;
      }
      case 'alert_loc': {
        const a = alerts.get(m.id); const loc = cleanLoc(m.loc);
        if (!a || a.uid !== s.uid || !loc || now - s.lastLoc < 2000) return;
        s.lastLoc = now; a.loc = loc; a.upd = now;
        toAudience(a, { t: 'alert_upd', id: a.id, loc, upd: now });
        break;
      }
      case 'alert_end': {
        const a = alerts.get(m.id);
        if (a && a.uid === s.uid) delAlert(a);
        break;
      }
      case 'alert_gone': {
        const a = alerts.get(m.id);
        if (!a || a.uid === s.uid || !visibleTo(s, a) || a.gone.includes(s.uid)) return;
        a.gone.push(s.uid);
        if (a.gone.length >= 2) delAlert(a);
        else send(ws, { t: 'toast', msg: 'Obrigado! Com mais uma confirmação o alerta sai da lista.' });
        break;
      }
      case 'report': {
        const f = s.ch !== null && floor[s.ch];
        if (!f || f.uid === s.uid) return;
        const r = { ts: new Date().toISOString(), by: s.name, byWa: s.wa, target: f.name, targetWa: f.wa, ch: s.ch };
        reports.push(r); if (reports.length > 500) reports.shift();
        console.log('[DENÚNCIA]', JSON.stringify(r));
        send(ws, { t: 'toast', msg: 'Denúncia registrada. Obrigado.' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (s.ws !== ws) return;
    s.ws = null; s.seen = Date.now(); leave(s); sendCounts();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const a of [...alerts.values()]) if (now - a.ts > TTL[a.kind]) delAlert(a);
  for (const [sid, s] of sessions) if (!s.ws && now - s.seen > 10 * 60e3) sessions.delete(sid);
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000);

server.listen(PORT, () => console.log('BH Rádio no ar na porta ' + PORT));
