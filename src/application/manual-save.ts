/**
 * Runs `callback` when the browser is next idle, so a background save does not compete with a frame.
 * `requestIdleCallback` is not available everywhere, so a macrotask is the fallback.
 */
export function scheduleSave(callback: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(callback, { timeout: 500 });
  else setTimeout(callback, 0);
}

/**
 * Serialises saves per owner so two saves of the same document cannot interleave.
 *
 * `capture` snapshots the document synchronously, at the moment the save was requested, so the bytes
 * written are the ones the user asked for even though the write itself is deferred; `complete` runs
 * only after the write succeeds. A second request for an owner that is already saving returns the
 * in-flight promise instead of queueing another write.
 *
 * `Project` is inferred from `write` at construction. The snapshot shape is inferred per call instead
 * of being a class parameter, because a caller's capture closure returns more than the project — the
 * document it saved, for example — and that extra shape is only knowable at the call site.
 */
export class ManualSaveQueue<Project> {
  write: (project: Project) => Promise<unknown> | unknown;
  schedule: (callback: () => void) => void;
  pending: Map<unknown, { latest: any; next: any; promise: Promise<Project> }>;

  constructor(write: (project: Project) => Promise<unknown> | unknown, schedule: (callback: () => void) => void = scheduleSave) {
    this.write = write;
    this.schedule = schedule;
    this.pending = new Map();
  }

  save<Snapshot extends { project: Project }>(owner: unknown, capture: () => Snapshot, complete: (snapshot: Snapshot) => void): Promise<Project> {
    const pending = this.pending.get(owner);
    if (pending) {
      const next = capture() as any, previous = pending.latest;
      const assets = next.project.assets ?? [], oldAssets = previous.project.assets ?? [];
      const folders = next.project.assetFolders ?? [], oldFolders = previous.project.assetFolders ?? [];
      if (next.document !== previous.document || assets.length !== oldAssets.length || assets.some(([name, bytes]: [string, unknown], index: number) => oldAssets[index]?.[0] !== name || oldAssets[index]?.[1] !== bytes)
        || folders.length !== oldFolders.length || folders.some((name: string, index: number) => oldFolders[index] !== name)) pending.next = pending.latest = next;
      return pending.promise;
    }
    const snapshot = capture() as any;
    const entry: { latest: any; next: any; promise: Promise<Project> } = { latest: snapshot, next: null, promise: Promise.resolve(undefined as unknown as Project) };
    const operation = new Promise<Project>((resolve, reject) => {
      this.schedule(async () => {
        try {
          let current = snapshot;
          while (current) {
            await this.write(current.project);
            complete(current);
            const next = entry.next; entry.next = null;
            if (next) {
              next.project.id = current.project.id;
              next.project.storageRevision = current.project.storageRevision;
            }
            if (!next) resolve(current.project);
            current = next;
          }
        }
        catch (error) { reject(error); }
      });
    }).finally(() => this.pending.delete(owner));
    entry.promise = operation; this.pending.set(owner, entry);
    return operation;
  }
}
