'use strict';

/* ============================================================
   PENGATURAN (boleh diubah)
   ============================================================ */
const CHUNK = 64 * 1024;            // ukuran satu pesan data (64 KB)
const READ_SIZE = 1024 * 1024;      // pengirim membaca file 1 MB sekali baca
const WINDOW = 8 * 1024 * 1024;     // maks data yang boleh "menggantung" belum ditulis penerima
const RAM_LIMIT = 200 * 1024 * 1024; // batas kalau browser penerima terpaksa pakai RAM
const ROOM_PREFIX = 'p2pshare-';    // supaya ID tidak bentrok di server PeerJS publik

const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // TURN (cadangan kalau koneksi langsung gagal). Isi di README langkah 8, lalu hapus tanda //
      // { urls: 'turn:NAMA-SERVER-TURN:80', username: 'USERNAME', credential: 'PASSWORD' },
    ],
  },
};

// Penerima menulis ke disk lewat OPFS kalau browsernya mendukung, kalau tidak pakai RAM
const HAS_OPFS = !!(navigator.storage && navigator.storage.getDirectory && window.Worker);

/* ============================================================
   HELPER
   ============================================================ */
const $ = (id) => document.getElementById(id);

// Tanpa huruf/angka yang mirip (0/O, 1/I) supaya kode mudah dibaca
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

function fmtSize(b) {
  const n = (v, d) => String(+v.toFixed(d)); // buang nol di belakang koma (200.0 -> 200)
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return n(b / 1024, 1) + ' KB';
  if (b < 1024 ** 3) return n(b / 1024 ** 2, 1) + ' MB';
  return n(b / 1024 ** 3, 2) + ' GB';
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Tersalin';
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    prompt('Salin manual:', text);
  }
}

// Pengirim menunggu EVENT (ack dari penerima / antrean kirim kosong), bukan timer polling.
// Timer di tab yang tidak aktif dibatasi browser (bisa 1x per detik), event tidak.
let wakeSender = null;
function wakeUp() {
  if (wakeSender) wakeSender();
}
function waitWake() {
  return new Promise((resolve) => {
    const t = setTimeout(done, 1000); // jaring pengaman saja
    function done() {
      clearTimeout(t);
      if (wakeSender === done) wakeSender = null;
      resolve();
    }
    wakeSender = done;
  });
}

// Pesan kontrol dikirim sebagai teks JSON, potongan file dikirim sebagai data biner mentah
function sendCtl(c, msg) {
  if (c && c.open) c.send(JSON.stringify(msg));
}

// Cegah layar HP mati selama transfer
let wakeLock = null;
async function updateAwake() {
  const need = sending || !!incoming;
  try {
    if (need && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!need && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// Hapus sisa file sementara dari kunjungan sebelumnya
async function cleanupStorage() {
  if (!HAS_OPFS) return;
  try {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) names.push(name);
    for (const name of names) { try { await root.removeEntry(name); } catch {} }
  } catch {}
}

/* ============================================================
   STATE
   ============================================================ */
let peer = null;           // koneksi ke server signaling PeerJS
let conn = null;           // koneksi P2P ke teman
let isHost = false;        // true = yang membuat room
let sending = false;       // sedang mengirim file?
let answerResolver = null; // menunggu jawaban Terima/Tolak dari penerima
let pendingOffer = null;   // kartu tawaran file yang belum dijawab
let incoming = null;       // file yang sedang diterima
let acked = 0;             // jumlah byte yang sudah dikonfirmasi ditulis oleh penerima
let abortReason = '';      // alasan kalau penerima membatalkan di tengah jalan

/* ============================================================
   TAMPILAN
   ============================================================ */
function show(view) {
  $('home').hidden = view !== 'home';
  $('room').hidden = view !== 'room';
}

function setStatus(text, kind) {
  const s = $('status');
  s.textContent = text;
  s.className = 'status ' + kind;
}

function homeMessage(text) {
  const m = $('homeMsg');
  m.textContent = text;
  m.hidden = !text;
}

// Kartu transfer (satu kartu = satu file). Pakai textContent supaya aman dari XSS.
function makeCard(title, sub) {
  const el = document.createElement('div');
  el.className = 'card glass transfer';
  const t = document.createElement('div');
  t.className = 't-title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 't-sub';
  s.textContent = sub;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  bar.appendChild(fill);
  const actions = document.createElement('div');
  actions.className = 'row';
  el.append(t, s, bar, actions);
  $('transfers').prepend(el);

  let lastPct = -1;
  return {
    sub: (text) => (s.textContent = text),
    progress: (p) => (fill.style.width = Math.round(p * 100) + '%'),
    // Update tampilan hanya kalau persennya berubah (hemat CPU), sekalian tampilkan kecepatan
    report(label, done, total, t0) {
      const pct = Math.floor((done / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      fill.style.width = pct + '%';
      const speed = done / Math.max((performance.now() - t0) / 1000, 0.001);
      s.textContent = `${label}… ${pct}% · ${fmtSize(speed)}/s`;
    },
    hideBar: () => (bar.hidden = true),
    clearButtons: () => actions.replaceChildren(),
    button(label, onClick, cls = '') {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = onClick;
      actions.appendChild(b);
    },
    link(label, href, filename) {
      const a = document.createElement('a');
      a.textContent = label;
      a.href = href;
      a.download = filename;
      a.className = 'btn primary';
      actions.appendChild(a);
    },
  };
}

/* ============================================================
   ROOM: BUAT & GABUNG
   ============================================================ */
function openRoomView(code) {
  $('roomCode').textContent = code;
  $('sendBox').hidden = true;
  $('transfers').replaceChildren();
  show('room');
}

function roomLink(code) {
  return location.origin + location.pathname + '?room=' + code;
}

function createRoom() {
  const code = makeCode();
  isHost = true;
  openRoomView(code);
  setStatus('Menunggu teman gabung…', 'wait');

  const p = new Peer(ROOM_PREFIX + code, PEER_OPTIONS);
  peer = p;
  p.on('connection', (c) => {
    if (conn && conn.open) { c.close(); return; } // room hanya untuk 1 teman
    setupConn(c);
  });
  p.on('error', handlePeerError);
}

function joinRoom(raw) {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    homeMessage('Kode room harus 6 karakter.');
    return;
  }
  homeMessage('');
  isHost = false;
  openRoomView(code);
  setStatus('Menghubungkan…', 'wait');

  const p = new Peer(undefined, PEER_OPTIONS);
  peer = p;
  p.on('open', () => {
    if (p !== peer) return;
    // serialization 'raw' = data biner dikirim apa adanya, tanpa dibungkus (hemat CPU)
    setupConn(p.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'raw' }));
  });
  p.on('error', handlePeerError);
}

function leave() {
  if (answerResolver) { answerResolver({ ok: false, reason: 'koneksi ditutup' }); answerResolver = null; }
  if (incoming) incoming.sink.abort();
  const c = conn, p = peer;
  conn = null; peer = null; incoming = null; pendingOffer = null; sending = false;
  wakeUp();
  try { c && c.close(); } catch {}
  try { p && p.destroy(); } catch {}
  history.replaceState(null, '', location.pathname);
  updateAwake();
  show('home');
}

function handlePeerError(err) {
  console.error(err);
  if (err.type === 'peer-unavailable') {
    leave();
    homeMessage('Room tidak ditemukan. Cek kodenya, atau minta teman membuat room baru.');
  } else if (err.type === 'unavailable-id') {
    leave();      // kode kebetulan sudah dipakai orang lain, buat ulang dengan kode baru
    createRoom();
  } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
    setStatus('Gagal menghubungi server signaling', 'err');
  } else {
    setStatus('Error: ' + (err.type || err.message), 'err');
  }
}

/* ============================================================
   KONEKSI P2P
   ============================================================ */
function setupConn(c) {
  conn = c;

  const opened = () => {
    if (c !== conn) return;
    setStatus('Terhubung langsung (P2P)', 'ok');
    $('sendBox').hidden = false;
  };
  if (c.open) opened(); else c.on('open', opened);

  c.on('data', (data) => { if (c === conn) onData(data); });
  c.on('close', () => { if (c === conn) onDisconnect(); });
  c.on('error', handlePeerError);
}

function onDisconnect() {
  $('sendBox').hidden = true;
  if (answerResolver) { answerResolver({ ok: false, reason: 'koneksi terputus' }); answerResolver = null; }
  if (pendingOffer) { pendingOffer.clearButtons(); pendingOffer.hideBar(); pendingOffer.sub('Dibatalkan: koneksi terputus'); pendingOffer = null; }
  if (incoming) {
    incoming.sink.abort();
    incoming.card.hideBar();
    incoming.card.sub('Gagal: koneksi terputus sebelum selesai');
    incoming = null;
  }
  sending = false;
  conn = null;
  wakeUp();
  updateAwake();

  if (isHost) setStatus('Teman keluar. Menunggu gabung lagi…', 'wait');
  else setStatus('Koneksi terputus', 'err');
}

/* ============================================================
   PENYIMPANAN PENERIMA (sink)
   Disk (OPFS) = tidak memakai RAM. RAM = cadangan untuk browser lama.
   ============================================================ */
function openDiskSink() {
  return new Promise((resolve, reject) => {
    const name = crypto.randomUUID();
    const w = new Worker('writer.js');
    let opened = false;
    let closing = null;

    const sink = {
      onWritten() {},
      onError() {},
      write: (buf) => w.postMessage({ cmd: 'write', buf }, [buf]),
      finish: () => new Promise((res, rej) => { closing = { res, rej }; w.postMessage({ cmd: 'close' }); }),
      abort() { w.postMessage({ cmd: 'abort' }); setTimeout(() => w.terminate(), 1500); },
    };

    const fail = (message) => {
      if (!opened) reject(new Error(message));
      else sink.onError(message);
      if (closing) closing.rej(new Error(message));
    };

    w.onerror = () => fail('Worker penyimpanan gagal dimuat');
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'opened') { opened = true; resolve(sink); }
      else if (m.type === 'written') sink.onWritten(m.total);
      else if (m.type === 'error') fail(m.message);
      else if (m.type === 'closed') {
        try {
          const root = await navigator.storage.getDirectory();
          const file = await (await root.getFileHandle(name)).getFile(); // File berbasis disk, bukan RAM
          w.terminate();
          closing.res(file);
        } catch (err) { closing.rej(err); }
      }
    };
    w.postMessage({ cmd: 'open', name });
  });
}

function openMemorySink(mime) {
  let chunks = [];
  let total = 0;
  const sink = {
    onWritten() {},
    onError() {},
    write(buf) { chunks.push(buf); total += buf.byteLength; sink.onWritten(total); },
    finish: () => Promise.resolve(new Blob(chunks, { type: mime || 'application/octet-stream' })),
    abort() { chunks = []; },
  };
  return sink;
}

// Cek apakah ada ruang untuk file ini. Mengembalikan alasan penolakan, atau '' kalau aman.
async function checkSpace(size) {
  if (!HAS_OPFS) {
    return size > RAM_LIMIT ? 'browser penerima hanya mendukung file sampai ' + fmtSize(RAM_LIMIT) : '';
  }
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota && size > (quota - usage) * 0.95) return 'ruang penyimpanan browser penerima tidak cukup';
  } catch {}
  return '';
}

/* ============================================================
   KIRIM FILE
   Urutan: meta -> (penerima jawab accept/reject) -> potongan biner x N -> done
   Selama mengirim, penerima rutin mengirim 'ack' (jumlah byte yang sudah ditulis ke disk).
   Pengirim berhenti sebentar kalau data yang belum dikonfirmasi sudah > WINDOW.
   ============================================================ */
async function sendFiles(files) {
  if (sending) { alert('Masih ada file yang sedang dikirim.'); return; }
  sending = true;
  updateAwake();
  try {
    for (const file of files) {
      if (!conn || !conn.open) break;
      await sendOne(file);
    }
  } finally {
    sending = false;
    updateAwake();
  }
}

async function sendOne(file) {
  const c = conn;
  const card = makeCard(file.name, fmtSize(file.size));
  const fail = (why) => { card.hideBar(); card.sub('Gagal: ' + why); };

  card.sub('Menunggu teman menerima…');
  sendCtl(c, { type: 'meta', name: file.name, size: file.size, mime: file.type });

  const answer = await new Promise((resolve) => (answerResolver = resolve));
  answerResolver = null;
  if (!answer.ok) { card.hideBar(); card.sub('Ditolak: ' + (answer.reason || 'teman menolak file ini')); return; }

  acked = 0;
  abortReason = '';
  if (c.dataChannel) {
    c.dataChannel.bufferedAmountLowThreshold = 1024 * 1024;
    c.dataChannel.onbufferedamountlow = wakeUp;
  }
  const t0 = performance.now();
  let offset = 0;

  while (offset < file.size) {
    const buf = await file.slice(offset, offset + READ_SIZE).arrayBuffer();

    for (let i = 0; i < buf.byteLength; i += CHUNK) {
      // Tunggu kalau penerima belum sempat menulis, atau antrean kirim browser penuh
      while (c.open && !abortReason &&
             (offset + i - acked > WINDOW || (c.dataChannel && c.dataChannel.bufferedAmount > 4 * 1024 * 1024))) {
        await waitWake();
      }
      if (abortReason) return fail('dibatalkan teman (' + abortReason + ')');
      if (!c.open) return fail('koneksi terputus');
      c.send(new Uint8Array(buf, i, Math.min(CHUNK, buf.byteLength - i)));
    }

    offset += buf.byteLength;
    card.report('Mengirim', offset, file.size, t0);
  }

  sendCtl(c, { type: 'done' });

  // Anggap selesai setelah penerima mengonfirmasi semua byte sudah tersimpan
  card.sub('Menunggu penerima menyimpan…');
  while (c.open && !abortReason && acked < file.size) await waitWake();
  if (abortReason) return fail('dibatalkan teman (' + abortReason + ')');
  if (acked < file.size) return fail('koneksi terputus sebelum penerima selesai');

  card.progress(1);
  card.sub('Terkirim · ' + fmtSize(file.size));
}

/* ============================================================
   TERIMA FILE
   ============================================================ */
function onData(data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg === 'object') onControl(msg);
  } else if (data instanceof ArrayBuffer) {
    onChunk(data);
  }
}

async function onControl(msg) {
  switch (msg.type) {
    case 'meta':   return onOffer(msg);
    case 'accept': if (answerResolver) answerResolver({ ok: true }); return;
    case 'reject': if (answerResolver) answerResolver({ ok: false, reason: String(msg.reason || '') }); return;
    case 'ack':    if (Number.isFinite(msg.n)) { acked = Math.max(acked, msg.n); wakeUp(); } return;
    case 'abort':  abortReason = String(msg.reason || 'tanpa alasan'); wakeUp(); return;
    case 'done':   return onDone();
  }
}

function onChunk(buf) {
  const inc = incoming;
  if (!inc) return;
  inc.got += buf.byteLength;
  if (inc.got > inc.size) return failIncoming(inc, 'data melebihi ukuran file');
  inc.sink.write(buf);
  inc.card.report('Menerima', inc.got, inc.size, inc.t0);
}

async function onDone() {
  const inc = incoming;
  if (!inc) return;
  incoming = null;
  updateAwake();

  if (inc.got !== inc.size) { incoming = inc; return failIncoming(inc, 'file tidak lengkap'); }

  inc.card.sub('Menyimpan…');
  try {
    const file = await inc.sink.finish();
    inc.card.progress(1);
    inc.card.sub('Selesai · ' + fmtSize(inc.size));
    inc.card.link('Unduh', URL.createObjectURL(file), inc.name);
  } catch (err) {
    inc.card.hideBar();
    inc.card.sub('Gagal menyimpan: ' + (err.message || err));
    sendCtl(conn, { type: 'abort', reason: 'gagal menyimpan' });
  }
}

function failIncoming(inc, why) {
  if (incoming === inc) incoming = null;
  inc.sink.abort();
  inc.card.hideBar();
  inc.card.sub('Gagal: ' + why);
  sendCtl(conn, { type: 'abort', reason: why });
  updateAwake();
}

async function onOffer(m) {
  const c = conn;
  const valid = typeof m.name === 'string' && Number.isFinite(m.size) && m.size >= 0;
  if (!valid) return sendCtl(c, { type: 'reject', reason: 'permintaan tidak valid' });
  if (incoming || pendingOffer) return sendCtl(c, { type: 'reject', reason: 'teman sedang menerima file lain' });

  const card = makeCard(m.name, 'Teman ingin mengirim file · ' + fmtSize(m.size));
  pendingOffer = card; // tandai dulu supaya tawaran lain tidak menyelip selama pengecekan

  const reason = await checkSpace(m.size);
  if (c !== conn) return; // koneksi sudah putus selama pengecekan
  if (reason) {
    pendingOffer = null;
    card.hideBar();
    card.sub('Ditolak otomatis: ' + reason);
    return sendCtl(c, { type: 'reject', reason });
  }

  card.button('Terima', async () => {
    if (!c.open || pendingOffer !== card) return;
    card.clearButtons();
    card.sub('Menyiapkan penyimpanan…');

    let sink = null;
    if (HAS_OPFS) {
      try { sink = await openDiskSink(); } catch (err) { console.warn('OPFS tidak bisa dipakai:', err); }
    }
    if (!sink) {
      if (m.size > RAM_LIMIT) {
        pendingOffer = null;
        card.hideBar();
        card.sub('Gagal: penyimpanan browser tidak bisa dipakai untuk file sebesar ini');
        return sendCtl(c, { type: 'reject', reason: 'penyimpanan browser penerima tidak bisa dipakai' });
      }
      sink = openMemorySink(m.mime);
    }
    if (c !== conn || !c.open) { sink.abort(); return; } // putus selama menyiapkan

    pendingOffer = null;
    const inc = { name: m.name, size: m.size, got: 0, lastAck: 0, sink, card, t0: performance.now() };
    incoming = inc;
    sink.onError = (why) => failIncoming(inc, why);
    sink.onWritten = (total) => {
      // Kabari pengirim tiap ~1 MB tertulis (dan di akhir)
      if (total - inc.lastAck >= 1024 * 1024 || total === inc.size) {
        inc.lastAck = total;
        sendCtl(conn, { type: 'ack', n: total });
      }
    };
    card.sub('Menerima… 0%');
    sendCtl(c, { type: 'accept' });
    updateAwake();
  }, 'primary');

  card.button('Tolak', () => {
    pendingOffer = null;
    card.clearButtons();
    card.hideBar();
    card.sub('Kamu menolak file ini');
    sendCtl(c, { type: 'reject', reason: 'ditolak oleh penerima' });
  }, 'ghost');
}

/* ============================================================
   EVENT TOMBOL
   ============================================================ */
$('limitInfo').textContent = HAS_OPFS
  ? 'File besar didukung (GB pun bisa), selama ruang kosong di perangkat penerima cukup.'
  : 'Browser ini hanya bisa menerima file sampai ' + fmtSize(RAM_LIMIT) + '.';

$('btnCreate').onclick = createRoom;
$('joinForm').onsubmit = (e) => { e.preventDefault(); joinRoom($('joinCode').value); };
$('btnLeave').onclick = leave;
$('btnCopyCode').onclick = (e) => copyText($('roomCode').textContent, e.target);
$('btnCopyLink').onclick = (e) => copyText(roomLink($('roomCode').textContent), e.target);

const fileInput = $('fileInput');
fileInput.onchange = () => {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  if (files.length) sendFiles(files);
};

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const files = Array.from(e.dataTransfer.files);
  if (files.length) sendFiles(files);
});

cleanupStorage();

// Buka link ...?room=KODE -> langsung gabung
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) joinRoom(roomParam);

/* ============================================================
   THEME TOGGLE (DARK/LIGHT MODE)
   ============================================================ */
const themeToggleBtn = document.getElementById('themeToggle');
const iconSun = document.getElementById('icon-sun');
const iconMoon = document.getElementById('icon-moon');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  if (theme === 'dark') {
    iconSun.hidden = false;
    iconMoon.hidden = true;
  } else {
    iconSun.hidden = true;
    iconMoon.hidden = false;
  }
}

// Cek preferensi tema saat halaman dimuat (dari local storage atau settingan OS sistem)
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
setTheme(savedTheme);

if (themeToggleBtn) {
  themeToggleBtn.onclick = () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  };
}