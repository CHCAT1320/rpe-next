import { shortcutKey } from '../core/preferences.ts';

export function isTextEntry(target) {
  if (target?.isContentEditable || target?.closest?.('textarea,[contenteditable="true"],[role="textbox"]')) return true;
  const input = target?.closest?.('input');
  return Boolean(input && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color'].includes(input.type));
}

export function isPlaybackSpace(event) {
  return shortcutKey(event) === 'SPACE' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextEntry(event.target);
}
export function isTypingText(target) {
  if (target?.isContentEditable || target?.closest?.('textarea,[contenteditable="true"],[role="textbox"]')) return true;
  const input = target?.closest?.('input');
  return Boolean(input && ['text', 'search', 'url', 'email', 'password', 'tel'].includes(input.type));
}

export function releaseShortcutFocus(target) {
  if (!isTypingText(target) && target?.closest?.('input,select,button')) target.blur?.();
}
