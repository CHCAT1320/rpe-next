import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface Pending { resolve: (value: any) => void; reject: (error: Error) => void }

export class NativeService {
  pending = new Map<number, Pending>();
  sequence = 0;
  worker: Worker;
  ready: Promise<void>;
  acceptReady!: () => void;
  rejectReady!: (error: Error) => void;
  failed?: Error;
  closing = false;
  constructor(root: string) {
    this.worker = new Worker(pathToFileURL(join(here, 'native-worker.ts')), { workerData: { root } });
    this.ready = new Promise((resolve, reject) => { this.acceptReady = resolve; this.rejectReady = reject; });
    this.worker.on('message', (message: any) => {
      if (message.ready) { this.acceptReady(); return; }
      const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result); else pending.reject(Object.assign(new Error(message.error.message), message.error));
    });
    const failed = (error: Error) => { this.rejectReady(error); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.failed = error; };
    this.worker.on('error', failed); this.worker.on('exit', () => { if (!this.closing) failed(new Error('原生存储后台意外退出，请重新启动编辑器')); });
  }
  async call(method: string, ...args: any[]): Promise<any> {
    await this.ready; if (this.failed) throw this.failed;
    return new Promise((resolve, reject) => { const id = ++this.sequence; this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args }); });
  }
  async close(): Promise<void> { if (this.closing) return; this.closing = true; try { await this.call('close'); } finally { await this.worker.terminate(); } }
}
