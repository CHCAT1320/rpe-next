import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSession } from '../src/application/session.mjs';
import { createChart, createLine, createNote } from '../src/core/chart.mjs';
import { insertEvent, placedEvent, eventListAt, transformEvents } from '../src/application/event-commands.mjs';
import { copyObjects, pasteObjects, deleteObjects, projectClipboard } from '../src/application/clipboard.mjs';
import { parseLineExpression, formatLineExpression } from '../src/application/multi-line-edit.mjs';
import { Timeline } from '../src/ui/timeline.mjs';

function sessionWithLines(count = 3) {
  const chart = createChart(); chart.judgeLineList = Array.from({ length: count }, (_, index) => createLine(`Line ${index + 1}`));
  return new EditorSession(chart);
}

function canvas() { return { clientWidth: 500, clientHeight: 600, style: {}, addEventListener() {}, focus() {}, setPointerCapture() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 600 }; }, getContext() { return { }; } }; }

test('多线模式保持去重排序并在关闭时保留集合', () => {
  const session = sessionWithLines();
  session.setMultiLineEnabled(true); session.addMultiLine(2); session.addMultiLine(1); session.addMultiLine(2);
  assert.deepEqual(session.multiLineIndices, [0, 1, 2]);
  session.removeMultiLine(0); assert.deepEqual(session.multiLineIndices, [1, 2]);
  session.setMultiLineEnabled(false); assert.equal(session.multiLineActive, false); assert.deepEqual(session.multiLineIndices, [1, 2]);
});

test('多线边界按钮按循环线组添加，音符可迁移到指定线', () => {
  const session = sessionWithLines(); session.setMultiLineEnabled(true); session.multiLineIndices = [0];
  session.addPreviousMultiLine(); assert.deepEqual(session.multiLineIndices, [0, 2]);
  session.addNextMultiLine(); assert.deepEqual(session.multiLineIndices, [0, 1, 2]);
  session.setMultiLineEnabled(false); session.insertNotes([createNote(1, 1, 0)]); session.selection = new Set([0]); session.moveSelectionToLine(2);
  assert.equal(session.lineIndex, 2); assert.equal(session.chart.judgeLineList[0].notes.length, 0);
});

test('多线音符并列显示但编辑只作用于当前线', () => {
  const session = sessionWithLines(); session.setMultiLineEnabled(true); session.addMultiLine(1); session.addMultiLine(2);
  session.insertNotes([createNote(1, 2, 10)]);
  assert.deepEqual(session.chart.judgeLineList.map(line => line.notes.length), [1, 0, 0]);
  session.transformSelection('镜像', note => ({ ...note, positionX: -note.positionX }));
  assert.equal(session.chart.judgeLineList[0].notes[0].positionX, -10);
  session.selectLine(1); session.insertNotes([createNote(1, 2, 20)]);
  assert.deepEqual(session.chart.judgeLineList.map(line => line.notes.length), [1, 1, 0]);
  session.selection = new Set([0]);
  session.deleteSelection(); assert.deepEqual(session.chart.judgeLineList.map(line => line.notes.length), [1, 0, 0]);
  session.travel('undo'); assert.deepEqual(session.chart.judgeLineList.map(line => line.notes.length), [1, 1, 0]);
});

test('多线事件放置和批量变换保留每条线独立数组', () => {
  const session = sessionWithLines(); session.setMultiLineEnabled(true, 'events'); session.addMultiLine(1);
  const event = placedEvent(session, 'moveXEvents', 2, 3); insertEvent(session, 'moveXEvents', event);
  assert.equal(eventListAt(session, 0, 'moveXEvents').length, 2);
  assert.equal(eventListAt(session, 1, 'moveXEvents').length, 1);
  session.selectLine(1);
  const second = placedEvent(session, 'moveXEvents', 4, 5); insertEvent(session, 'moveXEvents', second);
  session.eventSelection = new Set(['moveXEvents:1']);
  transformEvents(session, '调整', current => ({ ...current, start: current.start + 5, end: current.end + 5 }));
  assert.equal(eventListAt(session, 0, 'moveXEvents')[0].start, 0);
  assert.equal(eventListAt(session, 1, 'moveXEvents')[0].start, 0);
  assert.equal(eventListAt(session, 1, 'moveXEvents')[1].start, 5);
});

test('多线事件删除撤销恢复选择不丢失谱面引用', () => {
  const session = sessionWithLines(2); session.setMultiLineEnabled(true, 'events'); session.addMultiLine(1);
  insertEvent(session, 'moveXEvents', placedEvent(session, 'moveXEvents', 2, 3));
  session.selectLine(1); insertEvent(session, 'moveXEvents', placedEvent(session, 'moveXEvents', 4, 5));
  session.multiEventSelection = new Map([[1, new Set(['moveXEvents:0'])]]);
  session.eventSelection = new Set(['moveXEvents:0']);
  const before = eventListAt(session, 1, 'moveXEvents').length;
  deleteObjects(session); assert.equal(eventListAt(session, 1, 'moveXEvents').length, before - 1);
  session.travel('undo');
  assert.equal(eventListAt(session, 1, 'moveXEvents').length, before);
  assert.deepEqual([...session.multiEventSelection.get(1)], ['moveXEvents:0']);
});

test('多线剪贴板复制粘贴和删除一次提交', () => {
  const session = sessionWithLines(); session.setMultiLineEnabled(true); session.addMultiLine(1);
  session.insertNotes([createNote(1, 1, 0)]); copyObjects(session); session.selection = new Set([0]);
  pasteObjects(session, 4); assert.deepEqual(session.chart.judgeLineList.map(line => line.notes.length), [2, 0, 0]);
  deleteObjects(session); assert.deepEqual(session.chart.judgeLineList.map(line => line.notes.length), [1, 0, 0]);
});

test('多线剪贴板保留来源线并按目标面板映射相对线号', () => {
  const session = sessionWithLines();
  session.chart.judgeLineList[1].notes = [createNote(1, 1, 100)];
  session.chart.judgeLineList[2].notes = [createNote(1, 2, -100)];
  session.multiLineEnabled = true; session.multiLineMode = 'notes'; session.multiLineIndices = [1, 2];
  session.multiLineSelection = new Map([[1, new Set([0])], [2, new Set([0])]]);
  copyObjects(session);
  assert.deepEqual(session.clipboardNoteLines, [1, 2]);
  const projected = projectClipboard(session, 4, { targetLineIndex: 0 });
  assert.deepEqual(projected.noteLines, [0, 1]);
  pasteObjects(session, 4, { targetLineIndex: 0 });
  assert.equal(session.chart.judgeLineList[0].notes.length, 1);
  assert.equal(session.chart.judgeLineList[1].notes.length, 2);
  assert.deepEqual([...session.multiLineSelection.get(0)], [0]);
  assert.deepEqual([...session.multiLineSelection.get(1)], [1]);
});

test('多线线号表达式支持空格和闭区间并拒绝反向范围', () => {
  assert.deepEqual(parseLineExpression('0 2:4 4 8', 10), [0, 2, 3, 4, 8]);
  assert.equal(formatLineExpression([4, 2, 3, 2]), '2:4');
  assert.throws(() => parseLineExpression('4:2', 10), /范围无效/);
  assert.deepEqual(parseLineExpression('-1 0 99', 3), [0]);
});

test('多线事件和音符共享单线宽度，仍可保留事件显式覆盖', () => {
  const session = sessionWithLines(2); session.setMultiLineEnabled(true, 'events'); session.addMultiLine(1);
  const timeline = new Timeline(canvas(), canvas(), () => session, () => {}, () => {}); timeline.multiLineWidth = 320;
  assert.equal(timeline.panelWidth(500, 'notes'), 320);
  assert.equal(timeline.panelWidth(500, 'events'), 320);
  timeline.multiLineEventWidth = 180; assert.equal(timeline.panelWidth(500, 'events'), 320);
});
