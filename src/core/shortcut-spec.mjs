const aliases = { CONTROL: 'CTRL', CMD: 'CTRL', META: 'CTRL', RETURN: 'ENTER', ESC: 'ESCAPE', SPACEBAR: 'SPACE',
  '←': 'LEFTARROW', '→': 'RIGHTARROW', '↑': 'UPARROW', '↓': 'DOWNARROW',
  ARROWLEFT: 'LEFTARROW', ARROWRIGHT: 'RIGHTARROW', ARROWUP: 'UPARROW', ARROWDOWN: 'DOWNARROW',
  '[': 'LEFTBRACKET', ']': 'RIGHTBRACKET', '-': 'MINUS', ',': 'COMMA', '.': 'PERIOD', '/': 'SLASH', '\\': 'BACKSLASH', ';': 'SEMICOLON', "'": 'QUOTE', '`': 'TILDE', '=': 'EQUAL' };
const namedKeys = new Set(['SPACE', 'ENTER', 'TAB', 'ESCAPE', 'DELETE', 'BACKSPACE', 'INSERT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  'LEFTARROW', 'RIGHTARROW', 'UPARROW', 'DOWNARROW', 'LEFTBRACKET', 'RIGHTBRACKET', 'MINUS', 'COMMA', 'PERIOD', 'SLASH', 'BACKSLASH', 'SEMICOLON', 'QUOTE', 'TILDE', 'EQUAL']);

export function normalizeShortcutKey(key) { return aliases[key] ?? key; }

export function parseShortcut(specification) {
  if (typeof specification !== 'string') return { error: '快捷键必须是文本' };
  if (!specification.trim() || specification.toUpperCase() === 'NONE') return { value: '', parts: [], key: '' };
  const parts = specification.toUpperCase().replaceAll(' ', '').split(/[&+]/).map(part => normalizeShortcutKey(part.replace(/^(LEFT|RIGHT)(CTRL|SHIFT|ALT)$/, '$2')));
  if (parts.some(part => !part)) return { error: '组合键不能有空项，例如 Ctrl+S' };
  if (new Set(parts).size !== parts.length) return { error: '同一个按键不能重复出现' };
  const modifiers = ['CTRL', 'ALT', 'SHIFT'].filter(part => parts.includes(part));
  const keys = parts.filter(part => !['CTRL', 'SHIFT', 'ALT'].includes(part));
  if (keys.length !== 1) return { error: '需要一个普通按键，可搭配 Ctrl / Alt / Shift' };
  const key = keys[0];
  if (!/^[A-Z0-9]$/.test(key) && !/^F([1-9]|1[0-2])$/.test(key) && !namedKeys.has(key)) return { error: `不支持的按键：${key}` };
  const ordered = [...modifiers.map(part => `LEFT${part}`), key];
  return { value: ordered.join('&'), parts: ordered, key };
}

export function formatShortcut(specification) {
  const parsed = parseShortcut(specification);
  if (parsed.error) return specification;
  const labels = { LEFTCTRL: 'Ctrl', LEFTALT: 'Alt', LEFTSHIFT: 'Shift', SPACE: 'Space', ESCAPE: 'Esc', LEFTARROW: '←', RIGHTARROW: '→', UPARROW: '↑', DOWNARROW: '↓', LEFTBRACKET: '[', RIGHTBRACKET: ']' };
  return parsed.parts.map(part => labels[part] ?? part).join(' + ') || '未绑定';
}
