import { noteIsAbove } from '../core/chart.mjs';
import { selectedEvents, transformEvents } from './event-commands.mjs';

export function applyNumberShortcut(session, action) {
  if (!['NumberMirror', 'NumberFill'].includes(action)) return false;
  if (session.focus === 'notes' && session.selection.size === 1) {
    session.transformSelection(action === 'NumberMirror' ? '镜像音符 X' : '切换音符上下侧', note => action === 'NumberMirror'
      ? { ...note, positionX: -note.positionX }
      : { ...note, above: noteIsAbove(note) ? note.type === 2 ? 0 : 2 : 1 });
    return true;
  }
  if (session.focus !== 'events' || session.eventSelection.size !== 1) return false;
  const entry = selectedEvents(session)[0]; if (!entry) return false;
  if (entry.type === 'alphaEvents') {
    const value = action === 'NumberMirror' ? 0 : 255;
    transformEvents(session, '快捷填充透明度尾值', event => ({ ...event, end: value, ...(event.inst ? { start: value } : {}) }));
    return true;
  }
  if (action !== 'NumberMirror' || entry.type === 'paintEvents' || !Number.isFinite(entry.event.start) || !Number.isFinite(entry.event.end)) return false;
  transformEvents(session, '事件首尾数值取反', event => ({ ...event, start: -event.start, end: -event.end }));
  return true;
}
