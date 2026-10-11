import test from 'node:test';
import assert from 'node:assert/strict';
import { usesNativeTextShortcut } from '../src/ui/keyboard.mjs';
import { CollaborationPanel } from '../src/ui/collaboration.mjs';

const input = type => { const target = { type, closest: selector => selector === 'input' ? target : null }; return target; };

test('文本和数值框保留原生剪贴板、撤销、删除、选字和焦点导航', () => {
  for (const type of ['text', 'number', 'search', 'email', 'password', 'date', 'time']) {
    const target = input(type);
    for (const modifier of ['ctrlKey', 'metaKey']) for (const key of ['a', 'c', 'x', 'v', 'z', 'y', 'b']) {
      assert.equal(usesNativeTextShortcut({ target, key, [modifier]: true }), true, `${type}: ${modifier}+${key}`);
      assert.equal(usesNativeTextShortcut({ target, key, [modifier]: true, shiftKey: true }), true);
    }
    for (const key of ['Backspace', 'Delete', 'Insert', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab', 'Enter', 'Escape']) {
      assert.equal(usesNativeTextShortcut({ target, key }), true, `${type}: ${key}`);
      assert.equal(usesNativeTextShortcut({ target, key, shiftKey: true }), true);
    }
  }
});

test('数值输入及输入法不穿透，非文本控件和数值框非输入快捷键仍可用', () => {
  const target = input('number');
  for (const key of ['0', '2', '9', 'e', 'E', '-', '+', '.', ',']) assert.equal(usesNativeTextShortcut({ target, key }), true);
  for (const key of [' ', 'q', 'w', 'r', 'i', 'j']) assert.equal(usesNativeTextShortcut({ target, key }), false);
  for (const type of ['range', 'checkbox', 'button', 'color']) for (const key of [' ', 'q', 'ArrowLeft', 'c']) assert.equal(usesNativeTextShortcut({ target: input(type), key }), false);
  for (const target of [input('text'), { isContentEditable: true }, { closest: selector => selector.includes('textarea') ? {} : null }]) {
    assert.equal(usesNativeTextShortcut({ target, key: 'q' }), true);
  }
  for (const state of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) assert.equal(usesNativeTextShortcut({ key: 'q', ...state }), true);
});

test('联机斜杠不会从数值框或文本框穿透打开聊天', () => {
  let opened = 0;
  const panel = { client: { active: true }, chatBox: { hidden: true }, openChat: () => opened++ };
  for (const type of ['text', 'number', 'date']) CollaborationPanel.prototype.handleChatKey.call(panel, { target: input(type), key: '/' });
  assert.equal(opened, 0);
  CollaborationPanel.prototype.handleChatKey.call(panel, { target: input('range'), key: '/', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(opened, 1);
});
