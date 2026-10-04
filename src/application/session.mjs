import { History } from './history.mjs';
import { createChart, createLine } from '../core/chart.mjs';
import { beatValue, fromNumber } from '../core/beat.mjs';

export class EditorSession extends EventTarget {
  constructor(chart = createChart()) {
    super();
    this.history = new History(chart);
    this.lineIndex = 0;
    this.selection = new Set();
    this.clipboard = [];
    this.eventSelection = new Set();
    this.eventClipboard = [];
    this.eventLayer = 0;
    this.focus = 'notes';
    this.editSeconds = 0;
    this.recentEdits = [];
  }

  get chart() { return this.history.document; }
  get line() { return this.chart.judgeLineList?.[this.lineIndex]; }
  get notes() { return this.line?.notes ?? []; }
  notify() { this.dispatchEvent(new Event('change')); }

  commit(label, chart) {
    if (this.history.commit(label, chart)) {
      const time = Number.isFinite(this.editSeconds) ? Math.max(0, this.editSeconds) : 0;
      this.recentEdits.push({ start: time, end: time, label });
      if (this.recentEdits.length > 50) this.recentEdits.shift();
    }
    this.notify();
  }

  updateLine(label, change) {
    if (!this.line) throw new Error('请先新增判定线');
    const lines = [...this.chart.judgeLineList];
    lines[this.lineIndex] = change(this.line);
    this.commit(label, { ...this.chart, judgeLineList: lines });
  }

  updateNotes(label, change) {
    this.updateLine(label, line => {
      const notes = change(line.notes ?? []);
      return { ...line, notes, numOfNotes: notes.length };
    });
  }

  insertNotes(notes, label = '添加音符') {
    const first = this.notes.length;
    this.selection = new Set(notes.map((note, index) => first + index));
    this.updateNotes(label, existing => [...existing, ...notes]);
  }

  deleteSelection() {
    if (!this.selection.size) return;
    const selected = this.selection;
    this.selection = new Set();
    this.updateNotes('删除音符', notes => notes.filter((note, index) => !selected.has(index)));
  }

  transformSelection(label, change) {
    if (!this.selection.size) return;
    this.updateNotes(label, notes => notes.map((note, index) => this.selection.has(index) ? change(note) : note));
  }

  copy() { this.clipboard = structuredClone(this.notes.filter((note, index) => this.selection.has(index))); }

  paste(beat, mirror = false, keepTime = false) {
    if (!this.clipboard.length) return;
    const earliest = this.clipboard.reduce((minimum, note) => Math.min(minimum, beatValue(note.startTime)), Infinity);
    const delta = keepTime ? 0 : beat - earliest;
    this.insertNotes(this.clipboard.map(note => ({ ...structuredClone(note),
      positionX: note.positionX * (mirror ? -1 : 1),
      startTime: delta === 0 ? [...note.startTime] : fromNumber(beatValue(note.startTime) + delta),
      endTime: delta === 0 ? [...note.endTime] : fromNumber(beatValue(note.endTime) + delta),
    })), '粘贴音符');
  }

  selectLine(index) { this.lineIndex = index; this.selection.clear(); this.eventSelection.clear(); this.notify(); }

  addLine() {
    this.lineIndex = this.chart.judgeLineList?.length ?? 0;
    this.selection.clear();
    this.eventSelection.clear();
    this.commit('新增判定线', { ...this.chart, judgeLineList: [...(this.chart.judgeLineList ?? []), createLine(`Line ${this.lineIndex + 1}`)] });
  }

  travel(direction) {
    this.history[direction]();
    this.lineIndex = Math.max(0, Math.min(this.lineIndex, (this.chart.judgeLineList?.length ?? 0) - 1));
    this.selection.clear();
    this.eventSelection.clear();
    this.notify();
  }
}
