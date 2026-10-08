export function scheduleSave(callback) {
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(callback, { timeout: 500 });
  else setTimeout(callback, 0);
}

export class ManualSaveQueue {
  constructor(write, schedule = scheduleSave) {
    this.write = write;
    this.schedule = schedule;
    this.pending = new Map();
  }

  save(owner, capture, complete) {
    if (this.pending.has(owner)) return this.pending.get(owner);
    const snapshot = capture();
    const operation = new Promise((resolve, reject) => {
      this.schedule(async () => {
        try { await this.write(snapshot.project); complete(snapshot); resolve(snapshot.project); }
        catch (error) { reject(error); }
      });
    }).finally(() => this.pending.delete(owner));
    this.pending.set(owner, operation);
    return operation;
  }
}
