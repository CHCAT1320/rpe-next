const ITEMS_PER_CHUNK = 128;
const BYTES_PER_CHUNK = 1024 * 1024;

/** A JSON-like chart value: the recovery transfer walks it without assuming a shape. */
type Node = unknown;

/** The shape `snapshotParts` streams: a leaf, an array header or a slice of small array items. */
export interface SnapshotLeaf { path: (string | number)[]; value: Node }
export interface SnapshotArrayHeader { path: (string | number)[]; length: number }
export interface SnapshotArraySlice { path: (string | number)[]; offset: number; values: Node[] }
export type SnapshotPart = SnapshotLeaf | SnapshotArrayHeader | SnapshotArraySlice;

/** The messages the worker receives. */
type WorkerMessage =
  | { kind: 'begin'; projectId: string | undefined; name: string; limit: number; viewState: Record<string, unknown>; assets: [string, number][] }
  | { kind: 'chart'; part: SnapshotPart }
  | { kind: 'asset'; index: number; offset: number; bytes: Uint8Array }
  | { kind: 'commit' };

/** The worker's replies. */
interface WorkerReply { ok?: boolean; message?: string; ready?: boolean }

const scalar = (value: Node): boolean => value === null || typeof value !== 'object';
const smallArray = (value: Node): boolean => Array.isArray(value) && value.length <= 16 && value.every(scalar);

function compact(value: Node): boolean {
  if (scalar(value) || smallArray(value)) return true;
  if (Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return true;
  return Object.values(value as Record<string, Node>).every(item => scalar(item) || smallArray(item));
}

// Keep each structured-clone operation small, including on charts with one very
// large note/event list. Beat arrays and ordinary note/event records stay whole.
export function* snapshotParts(value: Node, path: (string | number)[] = []): Generator<SnapshotPart> {
  if (compact(value)) { yield { path, value }; return; }
  if (Array.isArray(value)) {
    yield { path, length: value.length };
    let offset = 0;
    while (offset < value.length) {
      if (!compact(value[offset])) { yield* snapshotParts(value[offset], [...path, offset]); offset++; continue; }
      const start = offset; const values: Node[] = [];
      while (offset < value.length && values.length < ITEMS_PER_CHUNK && compact(value[offset])) values.push(value[offset++]);
      yield { path, offset: start, values };
    }
  } else {
    const header: Record<string, Node> = {}; const children: string[] = [];
    for (const key of Object.keys(value as Record<string, Node>)) {
      const item = (value as Record<string, Node>)[key];
      if (compact(item)) Object.defineProperty(header, key, { value: item, enumerable: true, configurable: true, writable: true });
      else children.push(key);
    }
    yield { path, value: header };
    for (const key of children) yield* snapshotParts((value as Record<string, Node>)[key], [...path, key]);
  }
}

type MutableNode = Record<string, unknown> | unknown[];

export function applySnapshotPart(root: Node, part: SnapshotPart): Node {
  const { path } = part;
  if ('offset' in part) {
    let array = root as unknown[];
    for (const key of path) array = (array as unknown as Record<string | number, unknown>)[key] as unknown[];
    for (let index = 0; index < part.values.length; index++) array[part.offset + index] = part.values[index];
    return root;
  }
  const value: Node = 'length' in part ? new Array(part.length) : part.value;
  if (!path.length) return value;
  let parent = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  Object.defineProperty(parent, path.at(-1) as string | number, { value, enumerable: true, configurable: true, writable: true });
  return root;
}

/** The slice of `Worker` the transfer uses; typed so tests can pass a fake. */
export interface TransferWorker {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

export async function transferSnapshot(worker: TransferWorker, [projectId, name, chart, assets, limit, viewState]: [string | undefined, string, unknown, [string, Uint8Array][], number, Record<string, unknown>]): Promise<void> {
  let reply: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const receive = (): Promise<void> => new Promise<void>((resolve, reject) => { reply = { resolve, reject }; });
  worker.onmessage = ({ data }) => {
    if (data.ok === false) reply?.reject(new Error(data.message || '后台备份失败，请重试'));
    else reply?.resolve();
  };
  worker.onerror = event => reply?.reject(new Error(event.message || '后台备份失败，请重试'));
  worker.onmessageerror = () => reply?.reject(new Error('后台备份数据无法读取'));
  const send = (data: WorkerMessage, transfer: Transferable[] = []): Promise<void> => { const response = receive(); worker.postMessage(data, transfer); return response; };
  try {
    await receive();
    await send({ kind: 'begin', projectId, name, limit, viewState, assets: assets.map(([path, bytes]) => [path, bytes.byteLength]) });
    for (const part of snapshotParts(chart)) await send({ kind: 'chart', part });
    for (let index = 0; index < assets.length; index++) {
      const bytes = assets[index]![1];
      for (let offset = 0; offset < bytes.byteLength; offset += BYTES_PER_CHUNK) {
        const chunk = bytes.slice(offset, offset + BYTES_PER_CHUNK);
        await send({ kind: 'asset', index, offset, bytes: chunk }, [chunk.buffer as ArrayBuffer]);
      }
    }
    await send({ kind: 'commit' });
  } finally { reply = null; worker.terminate(); }
}

export type { MutableNode };
