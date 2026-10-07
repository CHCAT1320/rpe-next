import { cutSelectedEvents, stickSelectedEvents } from '../application/event-tools.ts';

export function runEventTool(session, action, notify, beat) {
  try {
    const result = action === 'cut' ? cutSelectedEvents(session, { division: session.division, density: session.cutDensity, beat, tempo: session.tempo, factor: session.line?.bpmfactor ?? 1 }) : stickSelectedEvents(session);
    const message = result.changed ? action === 'cut' ? `已将 ${result.changed} 个事件切割为 ${result.generated} 段` : `已粘合 ${result.changed} 个事件` : '没有可处理的事件';
    notify(`${message}${result.skipped ? `；跳过 ${result.skipped} 个不适用的事件` : ''}`, result.changed ? 'success' : 'warning');
  } catch (error) { notify(error.message, 'error'); }
}
