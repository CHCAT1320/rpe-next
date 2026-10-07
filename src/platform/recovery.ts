function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('rpe-next-recovery', 2);
    request.onupgradeneeded = () => {
      const connection = request.result;
      const drafts = connection.objectStoreNames.contains('drafts') ? request.transaction.objectStore('drafts') : connection.createObjectStore('drafts', { keyPath: 'id' });
      const summaries = connection.createObjectStore('summaries', { keyPath: 'id' });
      summaries.createIndex('projectId', 'projectId');
      const cursor = drafts.openCursor();
      cursor.onsuccess = () => { if (cursor.result) { summaries.put(summary(cursor.result.value)); cursor.result.continue(); } };
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function summary(draft) {
  return { id: draft.id, projectId: draft.projectId, name: draft.name, title: draft.chart.META.name ?? draft.name, updated: draft.updated };
}

async function transaction(stores, mode, action) {
  const connection = await database();
  return new Promise((resolve, reject) => {
    const operation = connection.transaction(stores, mode);
    const request = action(operation);
    operation.oncomplete = () => { connection.close(); resolve(request.result); };
    operation.onerror = () => { connection.close(); reject(operation.error); };
    operation.onabort = () => { connection.close(); reject(operation.error ?? new Error('恢复存储已中止')); };
  });
}

export function saveDraft(id, name, chart) {
  const draft = { id, name, chart, updated: Date.now() };
  return transaction(['drafts', 'summaries'], 'readwrite', operation => {
    operation.objectStore('summaries').put(summary(draft));
    return operation.objectStore('drafts').put(draft);
  });
}

export async function saveSnapshot(projectId, name, chart, assets, limit = 10, viewState = {}) {
  const connection = await database();
  return new Promise((resolve, reject) => {
    const operation = connection.transaction(['drafts', 'summaries'], 'readwrite'); const store = operation.objectStore('drafts');
    const summaries = operation.objectStore('summaries');
    const request = summaries.index('projectId').getAll(projectId);
    request.onsuccess = () => {
      const previous = request.result.sort((left, right) => right.updated - left.updated);
      for (const draft of previous.slice(Math.max(0, limit - 1))) { store.delete(draft.id); summaries.delete(draft.id); }
      const draft = { id: crypto.randomUUID(), projectId, name, chart, assets, viewState, updated: Date.now() };
      store.put(draft); summaries.put(summary(draft));
    };
    operation.oncomplete = () => { connection.close(); resolve(); };
    operation.onabort = operation.onerror = () => { connection.close(); reject(operation.error); };
  });
}

export async function listDrafts(projectId = null) {
  const drafts = await transaction(['summaries'], 'readonly', operation => projectId == null
    ? operation.objectStore('summaries').getAll()
    : operation.objectStore('summaries').index('projectId').getAll(projectId));
  return drafts.sort((left, right) => right.updated - left.updated);
}

export const readDraft = id => transaction(['drafts'], 'readonly', operation => operation.objectStore('drafts').get(id));
