export function storageError(data, fallback = '本地存储失败') {
  const error = new Error(data?.message || fallback);
  error.name = data?.name || 'Error';
  for (const key of ['projectId', 'expectedRevision', 'actualRevision']) if (data?.[key] !== undefined) error[key] = data[key];
  return error;
}

export function storageFailure(error) {
  if (error?.name === 'QuotaExceededError' || /quota.*(?:exceed|full)|disk.*full/i.test(error?.message ?? '')) return '本地存储空间不足，未完成写入。请先导出当前谱面或谱面库，再删除不需要的项目、恢复备份或皮肤以释放空间；上次成功的存档仍保留。';
  if (error?.name === 'VersionError') return '本地数据库已由较新的编辑器升级，请刷新或更新此窗口后重试。';
  return error?.message || String(error);
}

export function ensureStore(connection, transaction, name, options) {
  return connection.objectStoreNames.contains(name) ? transaction.objectStore(name) : connection.createObjectStore(name, options);
}

export function openDatabase(name, version, upgrade, { blockedTimeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let expired = false, timer;
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = event => {
      try { upgrade(request.result, request.transaction, event.oldVersion); }
      catch (error) { request.transaction.abort(); reject(error); }
    };
    request.onblocked = () => {
      if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('rpen-storage-blocked', { detail: { name } }));
      timer ??= setTimeout(() => { expired = true; reject(storageError({ name: 'StorageBlockedError', message: '数据库升级正在等待其他窗口。请关闭仍打开此编辑器的旧窗口或标签页，再重试；原有数据未被删除。' })); }, blockedTimeout);
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      const connection = request.result;
      connection.onversionchange = () => connection.close();
      if (expired) connection.close(); else resolve(connection);
    };
  });
}

export async function storageStatus(manager = globalThis.navigator?.storage) {
  if (nativeStorage) { await nativeReady(); return { supported: true, persistent: true, ...await nativeStorage.call('status') }; }
  if (!manager) return { supported: false, persistent: null, usage: null, quota: null };
  const [persistent, estimate] = await Promise.all([manager.persisted?.() ?? null, manager.estimate?.() ?? {}]);
  return { supported: true, persistent, usage: estimate.usage ?? null, quota: estimate.quota ?? null };
}

export async function requestPersistence(manager = globalThis.navigator?.storage) {
  if (nativeStorage) return true;
  if (!manager?.persist) return null;
  if (await manager.persisted?.()) return true;
  return manager.persist();
}
import { nativeStorage, nativeReady } from './native.mjs';
