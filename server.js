// Walkie-talkie + koin: Express (statis) + Socket.io (channel, kunci bicara, relay audio, penagihan)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_TALK_MS = 60_000;     // batas satu kali bicara
const MAX_CHUNK_BYTES = 8_192;  // batas ukuran satu potongan audio

// ---- Tarif (bisa diubah lewat environment variable) ----
const PRICE = Number(process.env.PRICE) || 100;            // Rp per blok
const BLOCK_SEC = Number(process.env.BLOCK_SEC) || 10;     // detik per blok
const FREE_BLOCKS = process.env.FREE_BLOCKS !== undefined ? Number(process.env.FREE_BLOCKS) : 18; // 18 x 10 dtk = 3 menit gratis

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const VOUCHER_FILE = process.env.VOUCHER_FILE || path.join(__dirname, 'vouchers.json');

// ---- Penyimpanan saldo (file JSON sederhana) ----
for (const f of [DATA_FILE, VOUCHER_FILE]) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch {} }
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
db.users = db.users || {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('Gagal menyimpan data:', e.message); }
  }, 300);
}
function getUser(uid) {
  if (!db.users[uid]) { db.users[uid] = { free: FREE_BLOCKS, balance: 0 }; save(); }
  return db.users[uid];
}
const canPay = (u) => u.free > 0 || u.balance >= PRICE;
const wallet = (uid) => { const u = getUser(uid); return { free: u.free, balance: u.balance }; };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100_000 });

function pushWallet(uid) { io.to('u:' + uid).emit('wallet', wallet(uid)); }

// Tagih satu blok: pakai jatah gratis dulu, lalu saldo. Mengembalikan false jika tidak mampu.
function charge(uid) {
  const u = getUser(uid);
  if (u.free > 0) u.free--;
  else if (u.balance >= PRICE) u.balance -= PRICE;
  else return false;
  save(); pushWallet(uid);
  return true;
}

// ---- Voucher ----
const readVouchers = () => { try { return JSON.parse(fs.readFileSync(VOUCHER_FILE, 'utf8')); } catch { return {}; } };
const fails = new Map(); // uid -> { n, until }

// ---- Health check & admin voucher (aktif hanya jika ADMIN_KEY diisi, minimal 12 karakter) ----
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const sameKey = (k) => {
  const a = Buffer.from(String(k || '')), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
// Contoh: /admin/voucher?key=KUNCI_ADMIN&amount=5000&count=3
app.get('/admin/voucher', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (ADMIN_KEY.length < 12 || !sameKey(req.query.key)) return res.status(404).send('Not found');
  const amount = parseInt(req.query.amount, 10);
  const count = Math.min(parseInt(req.query.count || '1', 10) || 1, 100);
  if (!amount || amount < 100) return res.status(400).type('text/plain').send('amount minimal 100');
  const v = readVouchers();
  const made = [];
  while (made.length < count) {
    const code = 'KOIN-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    if (v[code]) continue;
    v[code] = { amount, used: false, created: Date.now() };
    made.push(code);
  }
  try { fs.writeFileSync(VOUCHER_FILE, JSON.stringify(v, null, 2)); }
  catch { return res.status(500).type('text/plain').send('Gagal menyimpan voucher'); }
  res.type('text/plain').send('Voucher Rp' + amount.toLocaleString('id-ID') + ':\n' + made.join('\n'));
});

// ---- Channel ----
const channels = new Map(); // nama -> { speaker: {id, uid, timer, bill} | null, members: Map(socketId -> nama) }
const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, max) : '';

function broadcastState(name) {
  const c = channels.get(name);
  if (!c) return;
  io.to(name).emit('channel:state', {
    channel: name,
    speaker: c.speaker ? { id: c.speaker.id, name: c.members.get(c.speaker.id) } : null,
    members: [...c.members].map(([id, n]) => ({ id, name: n })),
  });
}
function releaseLock(name, id) {
  const c = channels.get(name);
  if (!c || !c.speaker || c.speaker.id !== id) return false;
  clearTimeout(c.speaker.timer);
  clearInterval(c.speaker.bill);
  c.speaker = null;
  return true;
}
function leaveChannel(socket) {
  const name = socket.data.channel;
  if (!name) return;
  socket.data.channel = null;
  socket.leave(name);
  const c = channels.get(name);
  if (!c) return;
  releaseLock(name, socket.id);
  c.members.delete(socket.id);
  if (c.members.size === 0) channels.delete(name);
  else broadcastState(name);
}

io.on('connection', (socket) => {
  // Identitas pengguna (prototipe: ID acak dari browser; versi produksi sebaiknya pakai login)
  socket.on('hello', (payload, ack) => {
    const uid = payload && payload.uid;
    if (typeof uid !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(uid)) return ack && ack({ ok: false });
    socket.data.uid = uid;
    socket.join('u:' + uid);
    ack && ack({ ok: true, wallet: wallet(uid), price: PRICE, blockSec: BLOCK_SEC });
  });

  socket.on('redeem', (payload, ack) => {
    const uid = socket.data.uid;
    if (!uid) return ack && ack({ ok: false, error: 'Belum terhubung' });
    const f = fails.get(uid) || { n: 0, until: 0 };
    if (f.until > Date.now()) return ack && ack({ ok: false, error: 'Terlalu banyak kode salah. Coba lagi 10 menit lagi.' });
    const code = String((payload && payload.code) || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
    const vouchers = readVouchers();
    const v = vouchers[code];
    if (!code || !v || v.used) {
      f.n++;
      if (f.n >= 5) { f.until = Date.now() + 10 * 60_000; f.n = 0; }
      fails.set(uid, f);
      return ack && ack({ ok: false, error: 'Kode tidak valid atau sudah dipakai' });
    }
    v.used = true; v.usedAt = Date.now();
    try { fs.writeFileSync(VOUCHER_FILE, JSON.stringify(vouchers, null, 2)); }
    catch { return ack && ack({ ok: false, error: 'Server gagal memproses voucher' }); }
    getUser(uid).balance += v.amount;
    save(); pushWallet(uid);
    ack && ack({ ok: true, amount: v.amount });
  });

  socket.on('join', (payload, ack) => {
    if (!socket.data.uid) return ack && ack({ ok: false, error: 'Belum terhubung, muat ulang halaman' });
    const name = clean(payload && payload.name, 20) || 'Anonim';
    const channel = clean(payload && payload.channel, 30).toLowerCase();
    if (!channel) return ack && ack({ ok: false, error: 'Nama channel kosong' });
    leaveChannel(socket);
    if (!channels.has(channel)) channels.set(channel, { speaker: null, members: new Map() });
    channels.get(channel).members.set(socket.id, name);
    socket.data.channel = channel;
    socket.join(channel);
    broadcastState(channel);
    ack && ack({ ok: true, id: socket.id, channel });
  });

  socket.on('leave', () => leaveChannel(socket));

  // Minta kunci bicara. Blok pertama langsung ditagih, blok berikutnya tiap BLOCK_SEC detik.
  socket.on('ptt:request', (ack) => {
    const name = socket.data.channel;
    const uid = socket.data.uid;
    const c = name && channels.get(name);
    if (!c || !uid) return ack && ack({ ok: false, error: 'Belum masuk channel' });
    if (c.speaker) return ack && ack({ ok: false, error: 'busy', speaker: c.members.get(c.speaker.id) });
    if (!canPay(getUser(uid))) return ack && ack({ ok: false, error: 'nofunds' });
    charge(uid); // aman: canPay sudah dicek, dan Node memproses satu event pada satu waktu

    const stop = (reason) => {
      if (releaseLock(name, socket.id)) {
        socket.emit('ptt:revoked', { reason });
        broadcastState(name);
      }
    };
    c.speaker = {
      id: socket.id,
      uid,
      timer: setTimeout(() => stop('Batas waktu bicara habis'), MAX_TALK_MS),
      bill: setInterval(() => { if (!charge(uid)) stop('Saldo habis. Isi koin untuk lanjut bicara'); }, BLOCK_SEC * 1000),
    };
    broadcastState(name);
    ack && ack({ ok: true });
  });

  socket.on('ptt:release', () => {
    const name = socket.data.channel;
    if (name && releaseLock(name, socket.id)) broadcastState(name);
  });

  socket.on('audio', (data) => {
    const name = socket.data.channel;
    const c = name && channels.get(name);
    if (!c || !c.speaker || c.speaker.id !== socket.id) return;
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_CHUNK_BYTES) return;
    socket.to(name).emit('audio', data);
  });

  socket.on('disconnect', () => leaveChannel(socket));
});

server.listen(PORT, () => console.log(`Walkie-talkie berjalan di http://localhost:${PORT}  (Rp${PRICE}/${BLOCK_SEC} detik, gratis ${FREE_BLOCKS * BLOCK_SEC} detik)`));
