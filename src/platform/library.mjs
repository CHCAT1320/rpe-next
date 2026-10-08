import { projectThumbnail } from './thumbnail.mjs';

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('rpe-next-library', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('summaries', { keyPath: 'id' });
      request.result.createObjectStore('preferences');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function access(stores, mode, action) {
  const connection = await database();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    let result;
    try { result = action(transaction); }
    catch (error) { transaction.abort(); connection.close(); reject(error); return; }
    transaction.oncomplete = () => { connection.close(); resolve(result?.result); };
    transaction.onerror = () => { connection.close(); reject(transaction.error); };
    transaction.onabort = () => { connection.close(); reject(transaction.error ?? new Error('存储事务已取消')); };
  });
}

const projectWrites = new Map();

export function storeProject(project) {
  const previous = projectWrites.get(project.id) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => writeProject(project));
  projectWrites.set(project.id, operation);
  const release = () => { if (projectWrites.get(project.id) === operation) projectWrites.delete(project.id); };
  operation.then(release, release);
  return operation;
}

async function writeProject(project) {
  if (typeof Worker === 'undefined') return storeProjectDirect(project);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./library-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => { worker.terminate(); data.ok ? resolve() : reject(new Error(data.message)); };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || '后台保存失败，请重试')); };
    worker.onmessageerror = () => { worker.terminate(); reject(new Error('后台保存数据无法读取')); };
    try { worker.postMessage(project); }
    catch (error) { worker.terminate(); reject(error); }
  });
}

export async function storeProjectDirect(project) {
  const thumbnail = await projectThumbnail(project);
  return access(['projects', 'summaries'], 'readwrite', transaction => {
    transaction.objectStore('projects').put(project);
    return transaction.objectStore('summaries').put(projectSummary(project, thumbnail));
  });
}
export function projectSummary(project, thumbnail) {
  return { version: 2, id: project.id, name: project.chart.META.name ?? project.chartName,
      chartName: project.chartName, identifier: project.identifier ?? project.info?.Path ?? project.chart?.META?.id ?? '', source: project.source, imported: project.imported, bytes: project.bytes,
      updated: project.updated ?? project.imported, group: project.group ?? project.info?.Group ?? '未分组',
      pinned: Boolean(project.pinned), archived: Boolean(project.archived), level: project.chart.META.level ?? '', charter: project.chart.META.charter ?? '',
      thumbnail, composer: project.chart.META.composer ?? '', lines: project.chart.judgeLineList?.length ?? 0,
      notes: (project.chart.judgeLineList ?? []).reduce((sum, line) => sum + (line.notes?.length ?? 0), 0) };
}
export const updateSummary = summary => access(['summaries'], 'readwrite', transaction => transaction.objectStore('summaries').put(summary));
export const listProjects = () => access(['summaries'], 'readonly', transaction => transaction.objectStore('summaries').getAll());
export const readProject = id => access(['projects'], 'readonly', transaction => transaction.objectStore('projects').get(id));
export const readPreferences = () => access(['preferences'], 'readonly', transaction => transaction.objectStore('preferences').get('current'));
export const storePreferences = preferences => access(['preferences'], 'readwrite', transaction => transaction.objectStore('preferences').put(preferences, 'current'));
export const readClipboardHistory = () => access(['preferences'], 'readonly', transaction => transaction.objectStore('preferences').get('clipboard-history'));
export const storeClipboardHistory = entries => access(['preferences'], 'readwrite', transaction => transaction.objectStore('preferences').put(entries, 'clipboard-history'));
