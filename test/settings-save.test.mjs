import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOTKEYS, migratePreferences, shortcutAction, shortcutMatches } from '../src/core/preferences.mjs';
import { parseShortcut } from '../src/core/shortcut-spec.mjs';
import { HOTKEY_LABELS, validateHotkeys, recordedShortcut } from '../src/core/hotkey-settings.mjs';
import { ManualSaveQueue } from '../src/application/manual-save.mjs';
import { History } from '../src/application/history.mjs';
import { normalizeEditorPreferences } from '../src/platform/editor-preferences.mjs';
import { Preview } from '../src/ui/preview.mjs';
import { PasteGesture } from '../src/ui/paste-gesture.mjs';

test('默认热键全部有名称，允许区域、长短按和选择状态复用', () => {
  assert.deepEqual(Object.keys(HOTKEY_LABELS).sort(), Object.keys(DEFAULT_HOTKEYS).sort());
  const result = validateHotkeys(DEFAULT_HOTKEYS);
  assert.equal(result.valid, true);
  assert.equal(result.issues.filter(issue => issue.severity === 'info').length, 4);
  const preferences = migratePreferences();
  assert.equal(shortcutAction({ key: 'r' }, preferences, 'notes'), 'AddHold');
  assert.equal(shortcutAction({ key: 'r' }, preferences, 'events'), 'AddEvent');
  assert.equal(shortcutAction({ key: 'ArrowLeft' }, preferences), 'LastBeat');
  assert.equal(shortcutAction({ key: 'ArrowLeft' }, preferences, 'notes', { hasSelection: true }), 'PageLeft');
});

test('按语义检查冲突，左右修饰键等价，额外修饰键可区分', () => {
  assert.equal(validateHotkeys({ ...DEFAULT_HOTKEYS, Save: 'rightctrl + z' }).valid, false);
  assert.equal(validateHotkeys({ ...DEFAULT_HOTKEYS, Save: 'Ctrl+Alt+S' }).valid, true);
  assert.equal(shortcutMatches({ key: 's', ctrlKey: true, altKey: true }, 'CTRL&S'), false);
  assert.equal(validateHotkeys({ ...DEFAULT_HOTKEYS, AddEvent: 'Q' }).valid, false);
  assert.equal(validateHotkeys({ ...DEFAULT_HOTKEYS, AddEvent: 'W' }).valid, true);
  assert.equal(validateHotkeys({ ...DEFAULT_HOTKEYS, Save: '/' }).valid, false);
});

test('录入校验非法组合、重复键、标点以及 Shift 数字', () => {
  for (const value of ['Ctrl', 'Ctrl++S', 'S&S', 'S&D', 'InvalidKey']) assert.ok(parseShortcut(value).error);
  assert.equal(recordedShortcut({ key: 'Control', ctrlKey: true }), null);
  assert.equal(recordedShortcut({ key: '!', code: 'Digit1', shiftKey: true }).value, 'LEFTSHIFT&1');
  assert.equal(shortcutMatches({ key: '!', code: 'Digit1', shiftKey: true }, 'SHIFT&1'), true);
  assert.equal(recordedShortcut({ key: '/', code: 'Slash', ctrlKey: true }).value, 'LEFTCTRL&SLASH');
  assert.ok(recordedShortcut({ key: 'Process', isComposing: true }).error);
});

test('清除热键可跨重启保留，重新绑定暂停后原空格不匹配', () => {
  const preferences = migratePreferences('{}', 'AddDrag\nPause CTRL+P\nFutureAction Z');
  assert.equal(preferences.hotkeys.AddDrag, '');
  assert.equal(shortcutAction({ key: 'w' }, preferences), undefined);
  assert.equal(shortcutMatches({ key: ' ' }, preferences.hotkeys.Pause), false);
  assert.equal(shortcutMatches({ key: 'p', ctrlKey: true }, preferences.hotkeys.Pause), true);
  assert.equal(preferences.originalHotkeys.FutureAction, 'Z');
});

test('重绑长按粘贴组合键后，释放 Shift / Alt 也会清理手势', () => {
  for (const [modifier, released] of [['shiftKey', 'Shift'], ['altKey', 'Alt']]) {
    let pasted = 0;
    const gesture = new PasteGesture({ paste: () => pasted++, open() {}, valid: () => true, schedule: () => 1, unschedule() {} });
    gesture.down({ key: 'g', [modifier]: true, preventDefault() {} }, {});
    assert.equal(gesture.up({ key: released, preventDefault() {} }), true);
    assert.equal(pasted, 1); assert.equal(gesture.pending, null);
  }
});

test('手动保存推迟工作、复用未完成请求，保存期间编辑仍保持未保存状态', async () => {
  const scheduled = []; const writes = []; const original = { value: 1 }; const history = new History(original);
  const next = { value: 2 }; history.commit('edit', next);
  const queue = new ManualSaveQueue(async project => writes.push(project), callback => scheduled.push(callback));
  const capture = () => ({ document: history.document, project: { chart: history.document } });
  const complete = snapshot => history.markSaved(snapshot.document);
  const first = queue.save(history, capture, complete);
  assert.equal(queue.save(history, capture, complete), first);
  assert.equal(writes.length, 0);
  history.commit('edit during save', { value: 3 });
  await scheduled.shift()(); await first;
  assert.equal(writes[0].chart, next); assert.equal(history.dirty, true);
  history.undo(); assert.equal(history.dirty, false);
});

test('后台写入失败保留脏状态且可重试，不同谱面互不阻塞', async () => {
  const scheduled = []; let fail = true;
  const queue = new ManualSaveQueue(async () => { if (fail) throw new Error('quota'); }, callback => scheduled.push(callback));
  const first = new History({}); first.commit('edit', {}); const second = new History({}); second.commit('edit', {});
  const save = history => queue.save(history, () => ({ project: { chart: history.document }, document: history.document }), snapshot => history.markSaved(snapshot.document));
  const failed = assert.rejects(save(first), /quota/);
  const other = assert.rejects(save(second), /quota/);
  assert.equal(scheduled.length, 2);
  await scheduled.shift()(); await scheduled.shift()(); await failed; await other;
  assert.equal(first.dirty, true); assert.equal(second.dirty, true);
  fail = false; const retried = save(first); await scheduled.shift()(); await retried;
  assert.equal(first.dirty, false); assert.equal(second.dirty, true);
});

test('判定线粗细持久化、迁移并实时绘制，不改变自定义图片尺寸', () => {
  globalThis.devicePixelRatio = 1;
  assert.equal(normalizeEditorPreferences({ lineScale: 20 }).lineScale, 10);
  assert.equal(migratePreferences('{"LineScale":2}').settings.lineScale, 2);
  const calls = [];
  const context = { save() {}, restore() {}, scale() {}, fillRect(...args) { calls.push(args); }, drawImage(...args) { calls.push(args.slice(1)); } };
  const preview = new Preview({}); const state = { scaleX: 1, scaleY: 1, color: [255, 255, 255], alpha: 255 };
  preview.drawLine(context, {}, state, 1); assert.equal(calls.at(-1)[3], 7.5);
  preview.lineScale = 2; preview.drawLine(context, {}, state, 1); assert.equal(calls.at(-1)[3], 10);
  preview.images = { images: new Map([['custom.png', { width: 120, height: 80 }]]) };
  preview.skin = { tintedSource: (key, texture) => texture };
  preview.drawLine(context, { Texture: 'custom.png' }, state, 1); assert.deepEqual(calls.at(-1), [-60, -40, 120, 80]);
});
