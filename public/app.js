const socket = io();
const $ = (id) => document.getElementById(id);

// ID acak yang disimpan di browser (prototipe; produksi sebaiknya pakai login)
function makeUid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'u-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
let uid = null;
try { uid = localStorage.getItem('wt_uid'); if (!uid) { uid = makeUid(); localStorage.setItem('wt_uid', uid); } } catch { uid = makeUid(); }

let ctx = null, stream = null, micOk = false;
let source = null, node = null, mute = null;
let channel = null, talking = false, pending = false, pressed = false;
let nextTime = 0;
let state = { speaker: null, members: [] };
let cfg = { price: 100, blockSec: 10 };
let wallet = { free: 0, balance: 0 };

function msg(t) { $('msg').textContent = t || ''; }
const rp = (n) => 'Rp ' + n.toLocaleString('id-ID');
const payable = () => wallet.free > 0 || wallet.balance >= cfg.price;
function fmtFree() {
  const s = wallet.free * cfg.blockSec;
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------- Audio ----------
async function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.audioWorklet.addModule('recorder-worklet.js');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    micOk = true;
  } catch (e) {
    micOk = false;
    msg('Mikrofon tidak tersedia (' + (e.name || 'error') + '). Kamu hanya bisa mendengarkan. Butuh HTTPS atau localhost.');
  }
}
function startCapture() {
  ctx.resume();
  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'recorder');
  mute = ctx.createGain(); mute.gain.value = 0;
  node.port.onmessage = (e) => { if (talking) socket.emit('audio', e.data); };
  source.connect(node); node.connect(mute); mute.connect(ctx.destination);
  talking = true; render();
}
function stopCapture() {
  if (source) source.disconnect();
  if (node) { node.port.onmessage = null; node.disconnect(); }
  if (mute) mute.disconnect();
  source = node = mute = null;
  if (talking) { talking = false; socket.emit('ptt:release'); }
  render();
}
function playChunk(arrayBuf) {
  if (!ctx || talking) return;
  const len = arrayBuf.byteLength >> 1;
  if (!len) return;
  const pcm = new Int16Array(arrayBuf, 0, len);
  const buf = ctx.createBuffer(1, len, 16000);
  const out = buf.getChannelData(0);
  for (let i = 0; i < len; i++) out[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination);
  if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.12;
  src.start(nextTime);
  nextTime += buf.duration;
}

// ---------- UI ----------
function render() {
  const sp = state.speaker;
  const me = sp && sp.id === socket.id;
  const st = $('status');
  st.className = '';
  if (!channel) st.textContent = 'Belum masuk channel';
  else if (talking || me) { st.textContent = '🔴 Kamu sedang bicara…'; st.className = 'talk'; }
  else if (sp) { st.textContent = '🟢 ' + sp.name + ' sedang bicara…'; st.className = 'rx'; }
  else st.textContent = 'Channel #' + channel + ' kosong, siap dipakai';

  const ul = $('members'); ul.textContent = '';
  state.members.forEach((m) => {
    const li = document.createElement('li');
    if (sp && sp.id === m.id) li.className = 'speaking';
    const a = document.createElement('span'); a.textContent = m.name + (m.id === socket.id ? ' (kamu)' : '');
    const b = document.createElement('span'); b.textContent = sp && sp.id === m.id ? '🎙️' : '';
    li.append(a, b); ul.append(li);
  });

  $('wallet').textContent = '💰 ' + rp(wallet.balance) + '  ·  Gratis: ' + fmtFree();
  $('rate').textContent = 'Rp' + cfg.price + ' / ' + cfg.blockSec + ' dtk';

  const btn = $('ptt');
  const broke = !talking && !payable();
  btn.disabled = !channel || !micOk || (!!sp && !me) || broke;
  btn.classList.toggle('on', talking);
  btn.textContent = talking ? 'MEMANCAR…' : (broke ? 'ISI KOIN DULU' : (sp && !me ? 'SALURAN SIBUK' : 'TAHAN UNTUK BICARA'));
}

// ---------- Socket ----------
function hello() {
  socket.emit('hello', { uid }, (res) => {
    if (!res || !res.ok) return msg('Gagal terhubung, muat ulang halaman');
    wallet = res.wallet; cfg = { price: res.price, blockSec: res.blockSec }; render();
  });
}
socket.on('connect', hello);
socket.on('wallet', (w) => { wallet = w; render(); });
socket.on('channel:state', (s) => { state = s; render(); });
socket.on('audio', playChunk);
socket.on('ptt:revoked', (r) => { msg(r.reason); pressed = false; stopCapture(); });
socket.on('disconnect', () => { channel = null; state = { speaker: null, members: [] }; pressed = false; stopCapture(); msg('Terputus dari server'); render(); });

$('join').onclick = async () => {
  const name = $('name').value.trim() || 'Anonim';
  const ch = $('channel').value.trim();
  if (!ch) return msg('Isi nama channel');
  await initAudio();
  socket.emit('join', { name, channel: ch }, (res) => {
    if (!res || !res.ok) return msg((res && res.error) || 'Gagal masuk');
    channel = res.channel; msg('Masuk ke #' + channel); render();
  });
};

$('redeem').onclick = () => {
  const code = $('voucher').value.trim();
  if (!code) return msg('Masukkan kode voucher');
  socket.emit('redeem', { code }, (res) => {
    if (res && res.ok) { $('voucher').value = ''; msg('Berhasil! Saldo bertambah ' + rp(res.amount)); }
    else msg((res && res.error) || 'Gagal memakai voucher');
  });
};

// ---------- Push-to-Talk ----------
function pttDown() {
  pressed = true;
  if (talking || pending || !micOk || !channel) return;
  pending = true;
  socket.emit('ptt:request', (res) => {
    pending = false;
    if (!res.ok) {
      if (res.error === 'busy') return msg(res.speaker + ' sedang bicara');
      if (res.error === 'nofunds') return msg('Saldo dan jatah gratis habis. Isi koin dengan kode voucher.');
      return msg(res.error);
    }
    if (!pressed) return socket.emit('ptt:release');
    msg(''); startCapture();
  });
}
function pttUp() { pressed = false; if (talking) stopCapture(); }

const btn = $('ptt');
btn.addEventListener('pointerdown', (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch {} pttDown(); });
btn.addEventListener('pointerup', pttUp);
btn.addEventListener('pointercancel', pttUp);
btn.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); pttDown(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') pttUp(); });
