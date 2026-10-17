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
// Chrome/Edge desktop: bisa menyimpan langsung ke folder pilihan pengguna (tanpa batas kuota browser)
const HAS_PICKER = typeof window.showSaveFilePicker === 'function';
// File sebesar ini ke atas disimpan lewat jendela "Simpan sebagai" kalau tersedia,
// supaya tidak butuh ruang dua kali lipat (salinan sementara + file unduhan)
const PICKER_MIN = 1024 * 1024 * 1024;

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
// Tiap peserta (link) punya "bangunan" sendiri supaya beberapa pengiriman paralel tidak saling ganggu.
function wakeUp(link) {
  if (link && link.wake) link.wake();
}
function waitWake(link) {
  return new Promise((resolve) => {
    const t = setTimeout(done, 1000); // jaring pengaman saja
    function done() {
      clearTimeout(t);
      if (link.wake === done) link.wake = null;
      resolve();
    }
    link.wake = done;
  });
}

// Pesan kontrol dikirim sebagai teks JSON, potongan file dikirim sebagai data biner mentah
function sendCtl(c, msg) {
  if (c && c.open) c.send(JSON.stringify(msg));
}

// Cegah layar HP mati selama transfer
let wakeLock = null;
async function updateAwake() {
  const need = [...links.values()].some((l) => l.active > 0 || l.incoming);
  document.body.classList.toggle('busy', need); // CSS: mode hemat (tanpa blur) saat transfer
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
const MAX_PEERS = 6;       // total orang di satu room, termasuk pembuat room
const links = new Map();   // id peserta -> status koneksi ke peserta itu (satu room banyak peserta)
let peer = null;           // koneksi ke server signaling PeerJS
let isHost = false;        // true = yang membuat room
let hostId = '';           // ID PeerJS milik pembuat room
let everConnected = false; // sudah pernah tersambung ke seseorang di room ini?
let oldHost = false;       // pembuat room memakai versi lama (tanpa fitur banyak peserta)?
const myName = 'Peserta-' + makeCode().slice(0, 3); // nama acak, ditampilkan ke peserta lain

function newLink(c) {
  return {
    id: c.peer, conn: c, name: '',
    answerResolver: null,  // menunggu jawaban Terima/Tolak dari penerima
    pendingOffer: null,    // kartu tawaran file yang belum dijawab
    incoming: null,        // file yang sedang diterima dari peserta ini
    acked: 0,              // byte yang sudah dikonfirmasi ditulis oleh penerima
    abortReason: '',       // alasan kalau penerima membatalkan di tengah jalan
    queue: Promise.resolve(), // antrean file yang dikirim ke peserta ini
    active: 0,             // jumlah file yang sedang/akan dikirim ke peserta ini
    wake: null,
  };
}
const openLinks = () => [...links.values()].filter((l) => l.conn.open);
const nameOf = (l) => l.name || 'teman';

/* ============================================================
   TAMPILAN
   ============================================================ */
function show(view) {
  $('home').hidden = view !== 'home';
  $('room').hidden = view !== 'room';
  document.body.dataset.view = view; // dipakai CSS untuk mengatur tampilan per halaman
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

// Ikon kartu transfer: dokumen (berjalan/menunggu), centang (selesai), silang (gagal/ditolak).
// String konstan buatan sendiri, bukan dari data pengguna, jadi aman dipakai di innerHTML.
const CARD_ICONS =
  '<svg class="ic-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' +
  '<svg class="ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' +
  '<svg class="ic-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// Kartu transfer (satu kartu = satu file). Pakai textContent supaya aman dari XSS.
// Status kartu (data-state): send = berjalan, offer = menunggu dijawab, done = selesai, fail = gagal/ditolak.
function makeCard(title, sub) {
  const el = document.createElement('div');
  el.className = 'card transfer';
  el.dataset.state = 'send';

  const icon = document.createElement('div');
  icon.className = 't-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = CARD_ICONS;
  const t = document.createElement('div');
  t.className = 't-title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 't-sub';
  s.textContent = sub;
  const text = document.createElement('div');
  text.className = 't-text';
  text.append(t, s);
  const head = document.createElement('div');
  head.className = 't-head';
  head.append(icon, text);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Progres ' + title);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  const fill = document.createElement('div');
  bar.appendChild(fill);
  const actions = document.createElement('div');
  actions.className = 'row actions';
  el.append(head, bar, actions);

  $('transferWrap').hidden = false;
  $('room').classList.add('has-transfers');
  $('transfers').prepend(el);

  let lastPct = -1;
  let lastPaint = 0;
  const setPct = (pct) => {
    fill.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  };
  return {
    sub: (text) => (s.textContent = text),
    state: (name) => (el.dataset.state = name),
    progress: (p) => setPct(Math.round(p * 100)),
    // Update tampilan hanya kalau persennya berubah (hemat CPU), sekalian tampilkan kecepatan
    report(label, done, total, t0) {
      const pct = Math.floor((done / total) * 100);
      if (pct === lastPct) return;
      const now = performance.now();
      if (pct < 100 && now - lastPaint < 200) return; // maksimal ~5 kali update per detik
      lastPct = pct;
      lastPaint = now;
      setPct(pct);
      const speed = done / Math.max((performance.now() - t0) / 1000, 0.001);
      s.textContent = `${label}… ${pct}% · ${fmtSize(speed)}/s`;
    },
    hideBar() { bar.hidden = true; el.dataset.state = 'fail'; },
    done() { el.dataset.state = 'done'; },
    clearButtons: () => actions.replaceChildren(),
    button(label, onClick, cls = '') {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = onClick;
      actions.appendChild(b);
    },
    link(label, href, filename) {
      el.dataset.state = 'done';
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
  $('transfers').replaceChildren();
  $('transferWrap').hidden = true;
  $('room').classList.remove('has-transfers');
  everConnected = false;
  oldHost = false;
  show('room');
  refreshRoom();
}

// Satu fungsi yang menyegarkan semua tampilan room dari daftar peserta saat ini
function refreshRoom() {
  const others = openLinks();
  const total = others.length + 1;
  if (others.length) everConnected = true;

  if (!isHost && oldHost && others.length) setStatus('Host memakai versi lama · hanya 2 orang', 'wait');
  else if (others.length) setStatus('Terhubung · ' + total + ' orang', 'ok');
  else if (isHost) setStatus('Menunggu teman gabung…', 'wait');
  else if (everConnected) setStatus('Koneksi terputus', 'err');
  else setStatus('Menghubungkan…', 'wait');

  $('sendBox').hidden = others.length === 0;

  $('peersBox').hidden = others.length === 0;
  $('peersTitle').textContent = 'Peserta (' + total + '/' + MAX_PEERS + ')';
  const ul = $('peers');
  ul.replaceChildren();
  const add = (text, cls) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    ul.appendChild(li);
  };
  add('Kamu · ' + myName + (isHost ? ' · Host' : ''), 'me');
  for (const l of others) add(nameOf(l) + (!isHost && l.id === hostId ? ' · Host' : ''));

  // Kode dan QR tetap tampil di pembuat room selama masih ada tempat
  const full = total >= MAX_PEERS;
  showQr(isHost && !full);
  $('qrBox').classList.toggle('compact', others.length > 0);
  $('roomFull').hidden = !(isHost && full);
  $('roomFull').textContent = 'Room penuh (maksimal ' + MAX_PEERS + ' orang).';
}

function showQr(on) {
  const box = $('qrBox');
  box.hidden = !on;
  if (!on) return;
  const link = roomLink($('roomCode').textContent);
  const holder = $('qr');
  if (holder.dataset.for !== link) {
    try {
      const qr = qrcode(0, 'M');   // 0 = ukuran otomatis
      qr.addData(link);
      qr.make();
      holder.innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
      holder.dataset.for = link;
    } catch (e) {
      console.error(e);
      box.hidden = true;
      return;
    }
  }
  // localhost / IP lokal tidak bisa dibuka dari HP lain
  $('qrWarn').hidden = !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
}

function roomLink(code) {
  return location.origin + location.pathname + '?room=' + code;
}

function createRoom() {
  const code = makeCode();
  isHost = true;
  hostId = ROOM_PREFIX + code;
  openRoomView(code);

  const p = new Peer(hostId, PEER_OPTIONS);
  peer = p;
  p.on('connection', (c) => {
    if (links.size >= MAX_PEERS - 1) {          // room penuh: kasih tahu lalu tutup
      const full = () => { sendCtl(c, { type: 'full' }); setTimeout(() => { try { c.close(); } catch {} }, 800); };
      if (c.open) full(); else c.on('open', full);
      return;
    }
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
  hostId = ROOM_PREFIX + code;
  openRoomView(code);

  const p = new Peer(undefined, PEER_OPTIONS);
  peer = p;
  p.on('open', () => {
    if (p !== peer) return;
    // serialization 'raw' = data biner dikirim apa adanya, tanpa dibungkus (hemat CPU)
    const hc = p.connect(hostId, { reliable: true, serialization: 'raw' });
    setupConn(hc);
    const hl = links.get(hostId);
    // Host versi lama tidak mengirim 'hello': beri tahu, jangan diam saja
    setTimeout(() => {
      if (hl && links.get(hostId) === hl && hl.conn.open && !hl.gotHello) { oldHost = true; refreshRoom(); }
    }, 4000);
    // Belum tersambung: beri petunjuk dulu, lalu menyerah dengan penjelasan
    setTimeout(() => {
      if (p === peer && !everConnected && hl === links.get(hostId)) setStatus('Masih menghubungkan… (room penuh atau host versi lama?)', 'wait');
    }, 8000);
    setTimeout(() => {
      if (p !== peer || everConnected || hl !== links.get(hostId)) return;
      leave();
      homeMessage('Tidak bisa tersambung ke room. Kemungkinan: room penuh, pembuat room memakai versi lama (minta dia memuat ulang halaman dan membuat room baru), atau jaringan memblokir koneksi langsung.');
    }, 25000);
  });
  // Peserta yang gabung belakangan akan menyambung ke kita (semua saling terhubung langsung)
  p.on('connection', (c) => {
    if (links.size >= MAX_PEERS - 1) { try { c.close(); } catch {} return; }
    setupConn(c);
  });
  p.on('error', handlePeerError);
}

function leave() {
  const p = peer;
  const all = [...links.values()];
  links.clear();
  peer = null;
  hostId = '';
  for (const l of all) {
    if (l.answerResolver) { l.answerResolver({ ok: false, reason: 'koneksi ditutup' }); l.answerResolver = null; }
    if (l.incoming) l.incoming.sink.abort();
    l.incoming = null; l.pendingOffer = null;
    try { l.conn.close(); } catch {}
    wakeUp(l);
  }
  try { p && p.destroy(); } catch {}
  history.replaceState(null, '', location.pathname);
  updateAwake();
  show('home');
}

function handlePeerError(err) {
  console.error(err);
  if (err.type === 'peer-unavailable') {
    // Gagal menyambung ke pembuat room = room tidak ada.
    // Gagal menyambung ke peserta lain (dia keburu keluar) cukup diabaikan.
    if (!isHost && hostId && String(err.message || '').includes(hostId)) {
      leave();
      homeMessage('Room tidak ditemukan. Cek kodenya, atau minta teman membuat room baru.');
    }
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
   KONEKSI P2P (satu room = banyak peserta, semua saling tersambung)
   Pembuat room menjadi pintu masuk: peserta baru menyambung ke pembuat room,
   lalu pembuat room memberi daftar peserta lain, dan peserta baru menyambung ke mereka juga.
   ============================================================ */
function setupConn(c) {
  const id = c.peer;
  if (links.has(id)) { try { c.close(); } catch {} return; }
  const link = newLink(c);
  links.set(id, link);

  const opened = () => {
    if (links.get(id) !== link) return;
    sendCtl(c, { type: 'hello', name: myName });
    if (isHost) sendCtl(c, { type: 'peers', list: openLinks().filter((l) => l !== link).map((l) => l.id) });
    refreshRoom();
  };
  if (c.open) opened(); else c.on('open', opened);

  c.on('data', (data) => { if (links.get(id) === link) onData(link, data); });
  c.on('close', () => { if (links.get(id) === link) onDisconnect(link); });
  c.on('error', (err) => {
    if (id === hostId && !everConnected) handlePeerError(err); // gagal sambung ke pembuat room
    else console.warn('Koneksi ke ' + id + ' bermasalah:', err);
  });
}

// Sambung ke sesama peserta. Kalau negosiasi macet (jaringan ketat), ulangi sampai 3 kali.
function connectToPeer(id, attempt) {
  if (!peer || links.has(id)) return;
  const c = peer.connect(id, { reliable: true, serialization: 'raw' });
  setupConn(c);
  const link = links.get(id);
  setTimeout(() => {
    if (!link || links.get(id) !== link || link.conn.open) return;
    links.delete(id);
    try { c.close(); } catch {}
    if (attempt < 3) connectToPeer(id, attempt + 1);
    else console.warn('Gagal menyambung ke', id);
  }, 12000);
}

function onDisconnect(link) {
  if (link.answerResolver) { link.answerResolver({ ok: false, reason: 'koneksi terputus' }); link.answerResolver = null; }
  if (link.pendingOffer) { link.pendingOffer.clearButtons(); link.pendingOffer.hideBar(); link.pendingOffer.sub('Dibatalkan: koneksi dengan ' + nameOf(link) + ' terputus'); link.pendingOffer = null; }
  if (link.incoming) {
    link.incoming.sink.abort();
    link.incoming.card.hideBar();
    link.incoming.card.sub('Gagal: koneksi dengan ' + nameOf(link) + ' terputus sebelum selesai');
    link.incoming = null;
  }
  links.delete(link.id);
  wakeUp(link);
  updateAwake();
  if (!isHost && link.id === hostId && !everConnected) {
    // Pembuat room menutup koneksi sebelum kita sempat masuk
    leave();
    homeMessage('Room tidak bisa dimasuki. Room mungkin penuh, atau pembuat room memakai versi lama: minta dia memuat ulang halaman lalu membuat room baru.');
    return;
  }
  refreshRoom();
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

// Simpan langsung ke file pilihan pengguna (File System Access API). Tidak lewat kuota browser.
async function openPickerSink(handle) {
  const w = await handle.createWritable();
  let total = 0, dead = null;
  let chain = Promise.resolve();
  const sink = {
    onWritten() {},
    onError() {},
    write(buf) {
      chain = chain.then(async () => {
        if (dead) return;
        await w.write(buf);
        total += buf.byteLength;
        sink.onWritten(total);
      }).catch((err) => {
        if (dead) return;
        dead = err;
        sink.onError((err && err.name ? err.name + ': ' : '') + (err && err.message || err));
      });
    },
    async finish() {
      await chain;
      if (dead) throw dead;
      await w.close();
      return null; // sudah tersimpan di disk, tidak ada file untuk diunduh lagi
    },
    abort() { chain.then(() => w.abort()).catch(() => {}); },
  };
  return sink;
}

// Perkiraan ruang kosong. Hanya perkiraan: beberapa browser (mode privat, Brave, Firefox) melaporkan angka kecil.
async function freeSpace() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota > 0) return Math.max(quota - (usage || 0), 0);
  } catch {}
  return null; // tidak diketahui
}

// Tentukan jalur penyimpanan yang mungkin untuk file ini.
// Penerima baru menolak kalau TIDAK ADA jalur sama sekali, bukan cuma karena perkiraan kuota kecil.
async function planStorage(size) {
  const free = HAS_OPFS ? await freeSpace() : null;
  const diskOk = HAS_OPFS && (free === null || size <= free * 0.95);
  const canRam = size <= RAM_LIMIT;
  let reason = '';
  let warn = '';
  if (!diskOk && !HAS_PICKER && !canRam) {
    if (HAS_OPFS) {
      // Perkiraan kuota bisa salah, jadi jangan menutup pintu: biarkan pengguna memutuskan.
      warn = 'Perkiraan ruang kosong browser ' + fmtSize(free) + ', mungkin tidak cukup untuk ' + fmtSize(size) + '. Transfer bisa gagal di tengah jalan.';
    } else {
      reason = 'browser penerima hanya mendukung file sampai ' + fmtSize(RAM_LIMIT);
    }
  }
  console.log('[storage] file', size, 'free', free, { diskOk, HAS_PICKER, canRam });
  return { free, diskOk, canRam, reason, warn };
}

/* ============================================================
   KIRIM FILE
   Urutan: meta -> (penerima jawab accept/reject) -> potongan biner x N -> done
   Selama mengirim, penerima rutin mengirim 'ack' (jumlah byte yang sudah ditulis ke disk).
   Pengirim berhenti sebentar kalau data yang belum dikonfirmasi sudah > WINDOW.
   ============================================================ */
// File dikirim ke SEMUA peserta lain. Tiap peserta punya antrean sendiri, jadi pengiriman
// ke beberapa orang berjalan paralel dan satu penerima yang lambat tidak menahan yang lain.
function sendFiles(files) {
  const targets = openLinks();
  if (!targets.length) return;
  for (const link of targets) {
    for (const file of files) {
      link.active++;
      link.queue = link.queue
        .then(() => sendOne(link, file))
        .catch((err) => console.error(err))
        .finally(() => { link.active--; updateAwake(); });
    }
  }
  updateAwake();
}

async function sendOne(link, file) {
  const c = link.conn;
  if (!c.open) return;
  const who = nameOf(link);
  const card = makeCard(file.name, fmtSize(file.size));
  const fail = (why) => { card.hideBar(); card.sub('Gagal ke ' + who + ': ' + why); };

  card.state('offer');
  card.sub('Menunggu ' + who + ' menerima…');
  sendCtl(c, { type: 'meta', name: file.name, size: file.size, mime: file.type });

  const answer = await new Promise((resolve) => (link.answerResolver = resolve));
  link.answerResolver = null;
  if (!answer.ok) { card.hideBar(); card.sub('Ditolak ' + who + ': ' + (answer.reason || 'menolak file ini')); return; }

  card.state('send');
  link.acked = 0;
  link.abortReason = '';
  if (c.dataChannel) {
    c.dataChannel.bufferedAmountLowThreshold = 1024 * 1024;
    c.dataChannel.onbufferedamountlow = () => wakeUp(link);
  }
  const t0 = performance.now();
  let offset = 0;

  while (offset < file.size) {
    const buf = await file.slice(offset, offset + READ_SIZE).arrayBuffer();

    for (let i = 0; i < buf.byteLength; i += CHUNK) {
      // Tunggu kalau penerima belum sempat menulis, atau antrean kirim browser penuh
      while (c.open && !link.abortReason &&
             (offset + i - link.acked > WINDOW || (c.dataChannel && c.dataChannel.bufferedAmount > 4 * 1024 * 1024))) {
        await waitWake(link);
      }
      if (link.abortReason) return fail('dibatalkan (' + link.abortReason + ')');
      if (!c.open) return fail('koneksi terputus');
      c.send(new Uint8Array(buf, i, Math.min(CHUNK, buf.byteLength - i)));
    }

    offset += buf.byteLength;
    card.report('Mengirim ke ' + who, offset, file.size, t0);
  }

  sendCtl(c, { type: 'done' });

  // Anggap selesai setelah penerima mengonfirmasi semua byte sudah tersimpan
  card.sub('Menunggu ' + who + ' menyimpan…');
  while (c.open && !link.abortReason && link.acked < file.size) await waitWake(link);
  if (link.abortReason) return fail('dibatalkan (' + link.abortReason + ')');
  if (link.acked < file.size) return fail('koneksi terputus sebelum selesai');

  card.progress(1);
  card.state('done');
  card.sub('Terkirim ke ' + who + ' · ' + fmtSize(file.size));
}

/* ============================================================
   TERIMA FILE
   ============================================================ */
function onData(link, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg === 'object') onControl(link, msg);
  } else if (data instanceof ArrayBuffer) {
    onChunk(link, data);
  }
}

async function onControl(link, msg) {
  switch (msg.type) {
    case 'hello':
      link.gotHello = true;
      if (link.id === hostId) oldHost = false;
      link.name = String(msg.name || '').replace(/[^\w\- ]/g, '').slice(0, 24) || '';
      // Balas sekali, supaya nama kita sampai walau 'hello' pertama sempat hilang saat saluran baru terbuka
      if (!msg.re && !link.replied) { link.replied = true; sendCtl(link.conn, { type: 'hello', name: myName, re: true }); }
      return refreshRoom();
    case 'peers':   // daftar peserta lain dari pembuat room: sambungkan ke semuanya
      if (isHost || link.id !== hostId || !Array.isArray(msg.list) || !peer) return;
      for (const id of msg.list.slice(0, MAX_PEERS)) {
        if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || id === peer.id || links.has(id)) continue;
        connectToPeer(id, 1);
      }
      return;
    case 'full':
      if (link.id === hostId) { leave(); homeMessage('Room penuh (maksimal ' + MAX_PEERS + ' orang).'); }
      return;
    case 'meta':   return onOffer(link, msg);
    case 'accept': if (link.answerResolver) link.answerResolver({ ok: true }); return;
    case 'reject': if (link.answerResolver) link.answerResolver({ ok: false, reason: String(msg.reason || '') }); return;
    case 'ack':    if (Number.isFinite(msg.n)) { link.acked = Math.max(link.acked, msg.n); wakeUp(link); } return;
    case 'abort':  link.abortReason = String(msg.reason || 'tanpa alasan'); wakeUp(link); return;
    case 'done':   return onDone(link);
  }
}

function onChunk(link, buf) {
  const inc = link.incoming;
  if (!inc) return;
  inc.got += buf.byteLength;
  if (inc.got > inc.size) return failIncoming(link, inc, 'data melebihi ukuran file');
  inc.sink.write(buf);
  inc.card.report('Menerima dari ' + nameOf(link), inc.got, inc.size, inc.t0);
}

async function onDone(link) {
  const inc = link.incoming;
  if (!inc) return;
  link.incoming = null;
  updateAwake();

  if (inc.got !== inc.size) { link.incoming = inc; return failIncoming(link, inc, 'file tidak lengkap'); }

  inc.card.sub('Menyimpan…');
  try {
    const file = await inc.sink.finish();
    inc.card.progress(1);
    if (file) {
      inc.card.sub('Selesai dari ' + nameOf(link) + ' · ' + fmtSize(inc.size));
      inc.card.link('Unduh', URL.createObjectURL(file), inc.name);
    } else {
      inc.card.sub('Tersimpan · ' + fmtSize(inc.size) + ' · ' + inc.savedAs);
      inc.card.done();
    }
  } catch (err) {
    inc.card.hideBar();
    inc.card.sub('Gagal menyimpan: ' + (err.message || err));
    sendCtl(link.conn, { type: 'abort', reason: 'gagal menyimpan' });
  }
}

function failIncoming(link, inc, why) {
  if (link.incoming === inc) link.incoming = null;
  inc.sink.abort();
  inc.card.hideBar();
  inc.card.sub('Gagal: ' + why);
  sendCtl(link.conn, { type: 'abort', reason: why });
  updateAwake();
}

async function onOffer(link, m) {
  const c = link.conn;
  const who = nameOf(link);
  const alive = () => links.get(link.id) === link && c.open;
  const valid = typeof m.name === 'string' && Number.isFinite(m.size) && m.size >= 0;
  if (!valid) return sendCtl(c, { type: 'reject', reason: 'permintaan tidak valid' });
  if (link.incoming || link.pendingOffer) return sendCtl(c, { type: 'reject', reason: 'penerima sedang menerima file lain darimu' });

  const card = makeCard(m.name, who + ' ingin mengirim file · ' + fmtSize(m.size));
  card.state('offer');
  link.pendingOffer = card; // tandai dulu supaya tawaran lain tidak menyelip selama pengecekan

  const plan = await planStorage(m.size);
  const reason = plan.reason;
  if (!alive()) return; // koneksi sudah putus selama pengecekan
  if (plan.warn) card.sub(plan.warn);
  if (reason) {
    link.pendingOffer = null;
    card.hideBar();
    card.sub('Ditolak otomatis: ' + reason);
    return sendCtl(c, { type: 'reject', reason });
  }

  const acceptHandler = async () => {
    if (!c.open || link.pendingOffer !== card) return;
    card.clearButtons();
    card.sub('Menyiapkan penyimpanan…');

    // 1) Simpan langsung ke folder pilihan (desktop Chrome/Edge): file besar, atau kalau kuota browser kecil.
    //    Harus dipanggil paling awal supaya masih dihitung sebagai hasil klik pengguna.
    let sink = null;
    let savedAs = '';
    const wantPicker = HAS_PICKER && (m.size >= PICKER_MIN || !plan.diskOk);
    if (wantPicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: m.name });
        sink = await openPickerSink(handle);
        savedAs = handle.name;
      } catch (err) {
        console.warn('Simpan-sebagai tidak dipakai:', err);
        if (err && err.name === 'AbortError' && !plan.diskOk && !plan.canRam) {
          // pengguna menutup jendela dan tidak ada jalur lain: kembalikan tombol
          card.sub('Dibatalkan. Tekan Terima lagi lalu pilih lokasi simpan.');
          card.button('Terima', acceptHandler, 'primary');
          card.button('Tolak', rejectHandler, 'ghost');
          return;
        }
      }
    }
    // 2) Disk privat browser (OPFS)
    if (!sink && HAS_OPFS && (plan.diskOk || !plan.canRam)) {
      try { sink = await openDiskSink(); } catch (err) { console.warn('OPFS tidak bisa dipakai:', err); }
    }
    // 3) RAM, hanya untuk file kecil
    if (!sink) {
      if (!plan.canRam) {
        link.pendingOffer = null;
        card.hideBar();
        card.sub('Gagal: penyimpanan browser tidak bisa dipakai untuk file sebesar ini');
        return sendCtl(c, { type: 'reject', reason: 'penyimpanan browser penerima tidak bisa dipakai' });
      }
      sink = openMemorySink(m.mime);
    }
    if (!alive()) { sink.abort(); return; } // putus selama menyiapkan

    link.pendingOffer = null;
    const inc = { name: m.name, size: m.size, got: 0, lastAck: 0, sink, card, savedAs, t0: performance.now() };
    link.incoming = inc;
    sink.onError = (why) => failIncoming(link, inc, /Quota/i.test(why) ? 'penyimpanan perangkat penuh' : why);
    sink.onWritten = (total) => {
      // Kabari pengirim tiap ~1 MB tertulis (dan di akhir)
      if (total - inc.lastAck >= 1024 * 1024 || total === inc.size) {
        inc.lastAck = total;
        sendCtl(c, { type: 'ack', n: total });
      }
    };
    card.state('send');
    card.sub('Menerima dari ' + who + '… 0%');
    sendCtl(c, { type: 'accept' });
    updateAwake();
  };

  const rejectHandler = () => {
    link.pendingOffer = null;
    card.clearButtons();
    card.hideBar();
    card.sub('Kamu menolak file ini');
    sendCtl(c, { type: 'reject', reason: 'ditolak oleh penerima' });
  };

  card.button('Terima', acceptHandler, 'primary');
  card.button('Tolak', rejectHandler, 'ghost');
}

/* ============================================================
   EVENT TOMBOL
   ============================================================ */
$('limitInfo').textContent = HAS_OPFS
  ? 'File besar didukung (GB pun bisa), selama disk di perangkat penerima cukup.'
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

/* ============================================================
   PASANG SEBAGAI APLIKASI (PWA)
   Android/desktop: tombol Pasang. iPhone/iPad: petunjuk "Tambah ke Layar Utama".
   ============================================================ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((err) => console.warn('Service worker gagal:', err));
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt = null;

function installDismissed() { try { return localStorage.getItem('p2pshare-install-closed') === '1'; } catch { return false; } }

function showInstallCard() {
  if (isStandalone() || installDismissed()) return;
  if (installEvt) {
    $('installText').textContent = 'Buka langsung dari layar utama, tampil seperti aplikasi biasa tanpa bilah browser.';
    $('btnInstall').hidden = false;
  } else if (isIOS) {
    $('installText').textContent = 'Di Safari, ketuk tombol Bagikan (kotak dengan panah ke atas), lalu pilih "Tambah ke Layar Utama".';
    $('btnInstall').hidden = true;
  } else {
    return;
  }
  $('installCard').hidden = false;
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; showInstallCard(); });
window.addEventListener('appinstalled', () => { installEvt = null; $('installCard').hidden = true; });
$('btnInstall').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch {}
  installEvt = null;
  $('installCard').hidden = true;
};
$('btnInstallClose').onclick = () => {
  $('installCard').hidden = true;
  try { localStorage.setItem('p2pshare-install-closed', '1'); } catch {}
};
showInstallCard();

/* ============================================================
   SCAN QR DI DALAM APLIKASI
   Pakai BarcodeDetector bawaan browser kalau ada (Chrome Android). Kalau tidak (iPhone/Safari),
   pakai jsQR yang dimuat hanya saat pemindai dibuka.
   ============================================================ */
let scanner = null; // { stop() } selama pemindai terbuka

// Ambil kode room dari isi QR: link ...?room=KODE, atau langsung 6 karakter kode
function codeFromScan(text) {
  text = String(text || '').trim();
  let code;
  try { code = new URL(text).searchParams.get('room') || ''; } catch { code = text; }
  code = code.toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : '';
}

function loadJsQr() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'jsqr.js';
    el.onload = resolve;
    el.onerror = () => reject(new Error('Pemindai gagal dimuat'));
    document.head.appendChild(el);
  });
}

function closeScanner() {
  if (scanner) scanner.stop();
  scanner = null;
  $('scanner').hidden = true;
}

async function openScanner() {
  if (scanner) return;
  const msg = (t) => ($('scanMsg').textContent = t);
  const video = $('scanVideo');
  $('scanner').hidden = false;
  msg('Menyalakan kamera…');

  let stream = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  scanner = { stop };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; } // dibatalkan saat menunggu izin
    video.srcObject = stream;
    await video.play();

    const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!detector) await loadJsQr();
    if (stopped) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    msg('Arahkan kamera ke QR room');

    const tick = async () => {
      if (stopped) return;
      let text = '';
      if (video.videoWidth) {
        try {
          if (detector) {
            const found = await detector.detect(video);
            text = found.length ? found[0].rawValue : '';
          } else {
            const k = Math.min(1, 640 / video.videoWidth); // perkecil supaya ringan
            canvas.width = Math.round(video.videoWidth * k);
            canvas.height = Math.round(video.videoHeight * k);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            text = r ? r.data : '';
          }
        } catch {}
      }
      if (stopped) return;
      const code = codeFromScan(text);
      if (code) { closeScanner(); joinRoom(code); return; }
      if (text) msg('QR ini bukan QR room P2P Share. Coba QR lain.');
      setTimeout(tick, 130);
    };
    tick();
  } catch (err) {
    console.warn('Scan QR gagal:', err);
    stop();
    if (err && err.name === 'NotAllowedError') msg('Izin kamera ditolak. Aktifkan izin kamera untuk situs ini di pengaturan browser, atau ketik kodenya.');
    else if (err && err.name === 'NotFoundError') msg('Kamera tidak ditemukan di perangkat ini. Ketik kodenya saja.');
    else msg('Kamera tidak bisa dibuka. Ketik kodenya saja.');
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) $('btnScan').hidden = false;
$('btnScan').onclick = openScanner;
$('btnScanClose').onclick = closeScanner;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && scanner) closeScanner(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && scanner) closeScanner(); });

cleanupStorage();

// Buka link ...?room=KODE -> langsung gabung
const params = new URLSearchParams(location.search);
const roomParam = params.get('room');
if (roomParam) joinRoom(roomParam);
else if (params.get('new')) { history.replaceState(null, '', location.pathname); createRoom(); } // pintasan "Buat room" di ikon aplikasi
