// wllama's storage backend interface, scoped to this app's OPFS directory.
// Vendor files remain unchanged. Reads and clears never enter the original "cache".
export const LAB_DIRECTORY = 'ai-safari-lab-cache';

const writerCode = `
let handle = null;
let offset = 0;
self.onmessage = async ({ data }) => {
  try {
    if (data.action === 'open') {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(data.directory, { create: true });
      const file = await directory.getFileHandle(data.key, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
    } else if (data.action === 'write') {
      let written = 0;
      while (written < data.bytes.byteLength) {
        const count = handle.write(data.bytes.subarray(written), { at: offset });
        if (!count) throw new Error('Could not write model data');
        written += count;
        offset += count;
      }
    } else if (data.action === 'close') {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
    } else {
      throw new Error('Unknown storage operation');
    }
    self.postMessage({ ok: true });
  } catch (error) {
    try { if (handle) handle.close(); } catch (_) {}
    handle = null;
    self.postMessage({ error: error.message || String(error) });
  }
};
`;

export class NamespacedOPFSBackend {
  constructor(directory = LAB_DIRECTORY) {
    if (!/^ai-safari-[a-z0-9-]+$/.test(directory)) throw new Error('Invalid storage directory');
    this.directory = directory;
  }

  isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  async dir(create = true) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(this.directory, { create });
  }

  async read(key) {
    // CacheManager first probes the literal URL, then its hashed filename.
    if (!key || key.includes("/") || key.includes("\\") || key === "." || key === "..") return null;
    try {
      return await (await (await this.dir(false)).getFileHandle(key)).getFile();
    } catch (error) {
      if (error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async getSize(key) {
    const file = await this.read(key);
    return file ? file.size : -1;
  }

  async list() {
    let directory;
    try { directory = await this.dir(false); }
    catch (error) {
      if (error.name === 'NotFoundError') return [];
      throw error;
    }
    const files = [];
    for await (const [key, entry] of directory.entries()) {
      if (entry.kind === 'file') files.push({ key, size: (await entry.getFile()).size });
    }
    return files;
  }

  async delete(key) {
    try { await (await this.dir(false)).removeEntry(key); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }

  async write(key, stream) {
    const url = URL.createObjectURL(new Blob([writerCode], { type: 'text/javascript' }));
    let worker;
    try { worker = new Worker(url); }
    finally { URL.revokeObjectURL(url); }
    const reader = stream.getReader();
    let pending = null;
    let fatal = null;
    const fail = (error) => {
      fatal = error;
      if (pending) { pending.reject(error); pending = null; }
    };
    worker.onerror = (event) => fail(new Error(event.message || 'Storage worker failed'));
    worker.onmessageerror = () => fail(new Error('Storage worker message failed'));
    worker.onmessage = ({ data }) => {
      if (!pending) return;
      const current = pending;
      pending = null;
      if (data.error) current.reject(new Error(data.error));
      else current.resolve();
    };
    const send = (data) => new Promise((resolve, reject) => {
      if (fatal) return reject(fatal);
      pending = { resolve, reject };
      try { worker.postMessage(data); }
      catch (error) { pending = null; reject(error); }
    });
    try {
      await send({ action: 'open', directory: this.directory, key });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // One acknowledged chunk at a time; never build an ArrayBuffer for the whole model.
        await send({ action: 'write', bytes: value });
      }
      await send({ action: 'close' });
    } catch (error) {
      try { await reader.cancel(error); } catch (_) {}
      try { await send({ action: 'close' }); } catch (_) {}
      throw error;
    } finally {
      reader.releaseLock();
      worker.terminate();
    }
  }
}
