'use strict';

/*
  Web Worker: menulis data yang diterima langsung ke disk (Origin Private File System).
  Data tidak ditumpuk di RAM. Worker dipakai karena createSyncAccessHandle
  hanya tersedia di dalam worker (dan ini cara tercepat menulis ke OPFS).

  Perintah dari app.js:
    {cmd:'open', name}   buka file sementara
    {cmd:'write', buf}   tulis satu potongan (ArrayBuffer)
    {cmd:'close'}        selesai, simpan
    {cmd:'abort'}        batal, hapus file sementara
*/

let handle = null;
let fileName = '';
let pos = 0;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      fileName = m.name;
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(fileName, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      pos = 0;
      postMessage({ type: 'opened' });

    } else if (m.cmd === 'write') {
      const data = new Uint8Array(m.buf);
      const n = handle.write(data, { at: pos });
      if (n !== data.byteLength) throw new Error('Penulisan ke disk tidak lengkap');
      pos += n;
      postMessage({ type: 'written', total: pos });

    } else if (m.cmd === 'close') {
      handle.flush();
      handle.close();
      handle = null;
      postMessage({ type: 'closed', size: pos });

    } else if (m.cmd === 'abort') {
      try { handle && handle.close(); } catch {}
      handle = null;
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(fileName);
      } catch {}
      postMessage({ type: 'aborted' });
    }
  } catch (err) {
    postMessage({ type: 'error', message: (err && err.name ? err.name + ': ' : '') + (err && err.message || err) });
  }
};
