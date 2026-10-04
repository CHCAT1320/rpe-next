const ranges = { scale: [20, 2000], division: [1, 100], gridCount: [2, 100], volume: [0, 1], hitVolume: [0, 1], realtimeAlpha: [0, 1], ratioWidth: [1, 100], ratioHeight: [1, 100], barWidth: [0.5, 10], barAlpha: [0.1, 2], eventValueSize: [8, 28], eventOpacity: [0.05, 1], eventBarWidth: [0.35, 1], scrollSpeed: [0.1, 100], autoSaveSeconds: [1, 3600], autoSaveLimit: [1, 100] };
Object.assign(ranges, { cameraX: [-1000000, 1000000], viewDivisor: [0.1, 100], backgroundBlur: [0, 30] });
const flags = ['snapX', 'realtime', 'hitEnabled', 'allLines', 'preservePitch', 'autoSave', 'autoplayView', 'highlight', 'seamlessEvents', 'notesOnly', 'showGameUI', 'lineNumbers', 'lineArrows', 'lineTint', 'mergeLineNumbers', 'pickPreviewLines', 'tipsEnabled', 'successNotifications'];
export function normalizeEditorPreferences(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) if (Number.isFinite(value[key])) result[key] = Math.max(minimum, Math.min(maximum, value[key]));
  if (result.division) result.division = Math.round(result.division);
  for (const key of flags) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (['compact', 'icons', 'wide'].includes(value.toolbarMode)) result.toolbarMode = value.toolbarMode;
  return result;
}
export function readEditorPreferences(storage = localStorage) {
  try { return normalizeEditorPreferences(JSON.parse(storage.getItem('rpe-next-editor-v1') ?? '{}')); } catch { return {}; }
}
export function writeEditorPreferences(value, storage = localStorage) { storage.setItem('rpe-next-editor-v1', JSON.stringify(normalizeEditorPreferences(value))); }
