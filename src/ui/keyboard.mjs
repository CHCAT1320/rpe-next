export function isTextEntry(target) {
  if (target?.isContentEditable || target?.closest?.('textarea,[contenteditable="true"],[role="textbox"]')) return true;
  const input = target?.closest?.('input');
  return Boolean(input && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color'].includes(input.type));
}

export function isPlaybackSpace(event) {
  return event.key === ' ' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextEntry(event.target);
}
