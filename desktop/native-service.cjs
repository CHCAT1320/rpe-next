const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

class NativeService {
  constructor(root) {
    this.pending = new Map(); this.sequence = 0;
    this.worker = new Worker(pathToFileURL(join(__dirname, 'native-worker.mjs')), { workerData: { root } });
    this.ready = new Promise((resolve, reject) => { this.acceptReady = resolve; this.rejectReady = reject; });
    this.worker.on('message', message => {
      if (message.ready) { this.acceptReady(); return; }
      const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result); else pending.reject(Object.assign(new Error(message.error.message), message.error));
    });
    const failed = error => { this.rejectReady(error); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.failed = error; };
    this.worker.on('error', failed); this.worker.on('exit', () => { if (!this.closing) failed(new Error('原生存储后台意外退出，请重新启动编辑器')); });
  }
  async call(method, ...args) {
    await this.ready; if (this.failed) throw this.failed;
    return new Promise((resolve, reject) => { const id = ++this.sequence; this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args }); });
  }
  async close() { if (this.closing) return; this.closing = true; try { await this.call('close'); } finally { await this.worker.terminate(); } }
}
module.exports = { NativeService };
