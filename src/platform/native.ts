import { snapshotParts } from './recovery-transfer.ts';

/** The object the desktop preload exposes on `window`; only version 1 is understood. */
interface NativeBridgeResponse {
  ok: boolean;
  result?: any;
  error?: { message: string; [key: string]: unknown };
}
interface NativeBridge {
  version: number;
  call(...args: unknown[]): Promise<NativeBridgeResponse>;
}
interface NativeStorage {
  call(...args: unknown[]): Promise<any>;
}

const bridge = (globalThis as { rpenDesktopStorage?: NativeBridge }).rpenDesktopStorage?.version === 1
  ? (globalThis as { rpenDesktopStorage?: NativeBridge }).rpenDesktopStorage
  : null;
// Recreate typed errors in the renderer; contextBridge only preserves Error messages.
export const nativeStorage: NativeStorage | null = bridge ? {
  call: async (...args: unknown[]) => {
    const response = await bridge.call(...args);
    if (!response.ok) throw Object.assign(new Error(response.error?.message ?? '存储操作失败'), response.error);
    return response.result;
  },
} : null;
const binaryCache = new WeakMap<object, string>();
let ready: Promise<void> | undefined;
function partWeight(part: unknown): number {
  // Budget the batch without serializing the entire chart on the UI thread.
  const stack: unknown[] = [part]; let weight = 0;
  while (stack.length && weight < 256 * 1024) {
    const value = stack.pop();
    if (typeof value === 'string') weight += value.length * 2;
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) { weight += key.length * 2 + 8; stack.push(item); }
    } else weight += 8;
  }
  return weight;
}
async function arrayHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function nativeWrite(kind: string, id: string, record: any, options: Record<string, unknown> = {}): Promise<any> {
  if (!nativeStorage) throw new Error('原生存储不可用');
  const token = await nativeStorage.call('begin', kind, id, options), binaries: { path: (string | number)[]; value: any }[] = [];
  try {
    let batch: unknown[] = [], weight = 0;
    for (const part of snapshotParts(record, [], binaries)) {
      const size = partWeight(part);
      if (batch.length && (batch.length >= 128 || weight + size > 256 * 1024)) {
        await nativeStorage.call('parts', token, batch); batch = []; weight = 0;
      }
      batch.push(part); weight += size;
    }
    if (batch.length) await nativeStorage.call('parts', token, batch);
    for (const { path, value } of binaries) {
      const blob = value instanceof Blob;
      const bytes: Uint8Array | null = blob ? null : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const length = blob ? value.size : bytes!.length;
      // Mutable arrays must be checked again, even if their object identity is unchanged.
      const cached = binaryCache.get(value as object);
      const knownHash = blob ? cached : cached && globalThis.crypto?.subtle ? await arrayHash(bytes!) : undefined;
      const entry = await nativeStorage.call('binaryBegin', token, { path, length, kind: blob ? 'blob' : 'bytes', type: blob ? value.type : '', hash: knownHash });
      let hash: string | undefined = entry.hash;
      if (!entry.existing) for (let offset = 0; offset < length; offset += 1024 ** 2) {
        const chunk = blob ? new Uint8Array(await (value as Blob).slice(offset, offset + 1024 ** 2).arrayBuffer()) : bytes!.slice(offset, offset + 1024 ** 2);
        const result = await nativeStorage.call('binaryChunk', token, entry.index, offset, chunk); hash = result.hash ?? hash;
      }
      if (hash) binaryCache.set(value as object, hash);
    }
    return await nativeStorage.call('commit', token);
  } catch (error) { await nativeStorage.call('abort', token).catch(() => {}); throw error; }
}

export async function decodeNative(envelope: any): Promise<any> {
  if (!envelope) return undefined;
  if (!nativeStorage) throw new Error('原生存储不可用');
  const data = envelope.data;
  for (const entry of envelope.binaries ?? []) {
    const bytes = new Uint8Array(entry.length);
    for (let offset = 0; offset < bytes.length;) {
      const chunk = await nativeStorage.call('blob', entry.hash, offset, Math.min(1024 ** 2, bytes.length - offset));
      if (!chunk?.length) throw Error('素材文件不完整'); bytes.set(chunk, offset); offset += chunk.length;
    }
    const value = entry.kind === 'blob' ? new Blob([bytes as BlobPart], { type: entry.type }) : bytes;
    let parent = data;
    for (const key of entry.path.slice(0, -1)) { if (!Object.hasOwn(parent, key)) throw Error('存储素材引用无效'); parent = parent[key]; }
    Object.defineProperty(parent, entry.path.at(-1), { value, enumerable: true, writable: true, configurable: true });
    binaryCache.set(value as object, entry.hash);
  }
  return data;
}
export async function nativeAssetBytes(value: any): Promise<any> {
  if (!(value instanceof Blob)) return value;
  const bytes = new Uint8Array(await value.arrayBuffer());
  const hash = binaryCache.get(value); if (hash) binaryCache.set(bytes, hash);
  return bytes;
}

async function legacyDatabase(name: string): Promise<IDBDatabase | null> {
  const databases = await indexedDB.databases?.();
  if (databases && !databases.some(database => database.name === name)) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name); let missing = false;
    request.onupgradeneeded = () => { missing = true; request.transaction?.abort(); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => missing ? resolve(null) : reject(request.error);
  });
}
async function legacyRead(database: IDBDatabase, store: string, key: IDBValidKey | null, keys = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const objectStore = database.transaction(store).objectStore(store);
    const request = keys ? objectStore.getAllKeys() : objectStore.get(key as IDBValidKey);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

async function migrateLegacy(): Promise<void> {
  if (!nativeStorage) return;
  const sources = [['rpe-next-library', 'projects', 'projects'], ['rpe-next-recovery', 'drafts', 'drafts'], ['rpe-next-editor-skins', 'packages', 'editor-skins'], ['rpe-next-note-skins', 'packages', 'note-skins'], ['rpe-next-mods', 'packages', 'mods'], ['rpe-next-library', 'preferences', 'preferences']] as const;
  let overlay: HTMLDivElement | undefined;
  try {
    for (const [name, store, kind] of sources) {
      const database = await legacyDatabase(name); if (!database) continue;
      try {
        if (!database.objectStoreNames.contains(store)) continue;
        const keys = await legacyRead(database, store, null, true) as IDBValidKey[];
        for (const [index, key] of keys.entries()) {
          const id = String(key), source = name + '/' + store;
          if (await nativeStorage.call('migrationDone', source, kind, id)) continue;
          if (!overlay) {
            overlay = document.createElement('div'); overlay.className = 'native-storage-migration'; overlay.setAttribute('role', 'status');
            const title = document.createElement('strong'); title.textContent = '正在迁移桌面存储';
            const progress = document.createElement('p'); progress.dataset.nativeProgress = 'true';
            const hint = document.createElement('p'); hint.textContent = '正在复制到原生文件谱面库并校验。旧数据库保留；关闭程序后，下次可继续迁移。'; overlay.append(title, progress, hint); document.body.append(overlay);
          }
          overlay.querySelector<HTMLElement>('[data-native-progress]')!.textContent = `${kind} · ${index + 1}/${keys.length}`;
          const value = await legacyRead(database, store, key);
          const record = kind === 'preferences' ? { id, value } : value;
          if (!record) continue;
          // A deletion marker from the old library must not resurrect a deleted project.
          if (kind === 'projects' && database.objectStoreNames.contains('revisions')) {
            const revision = await legacyRead(database, 'revisions', key); if (revision?.deleted) continue;
          }
          if (kind === 'projects' && database.objectStoreNames.contains('summaries')) {
            const summary = await legacyRead(database, 'summaries', key); if (summary?.thumbnail) record.thumbnail = summary.thumbnail;
          }
          if (kind === 'projects' && !record.thumbnail) record.thumbnail = await (await import('./thumbnail.ts')).projectThumbnail(record);
          await nativeWrite(kind, id, record, { migration: true });
          await nativeStorage.call('markMigration', source, kind, id);
        }
      } finally { database.close(); }
    }
    if (!await nativeStorage.call('read', 'preferences', 'ui-settings')) {
      const values: Record<string, string | null> = {};
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key && /^rpe(?:-next|-collab)-/.test(key)) Object.defineProperty(values, key, { value: localStorage.getItem(key), enumerable: true });
      }
      await nativeWrite('preferences', 'ui-settings', { id: 'ui-settings', values });
    }
    await nativeStorage.call('migrationComplete');
  } finally { overlay?.remove(); }
}

export function nativeReady(): Promise<void> {
  if (!nativeStorage) return Promise.resolve();
  return ready ??= nativeStorage.call('legacyMigrationPending').then((pending: boolean) => pending ? migrateLegacy() : undefined).catch((error: unknown) => { ready = undefined; throw error; });
}
export async function nativeRead(kind: string, id: string): Promise<any> { await nativeReady(); return decodeNative(await nativeStorage!.call('read', kind, id)); }
export async function nativeList(kind: string, deleted = false): Promise<any[]> { await nativeReady(); return Promise.all((await nativeStorage!.call('list', kind, deleted)).map(decodeNative)); }

export async function nativePackages(kind: string, mode: 'read' | 'delete' | 'write', id = '', record?: any): Promise<any> {
  await nativeReady();
  if (!nativeStorage) throw new Error('原生存储不可用');
  if (mode === 'read') {
    const items = await nativeStorage.call('list', kind, false), records: any[] = [];
    for (const entry of items) records.push(await nativeRead(kind, entry.data.id));
    return records;
  }
  if (mode === 'delete') return nativeStorage.call('remove', kind, id);
  return nativeWrite(kind, id, record);
}
