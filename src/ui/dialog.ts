import { stringifyPreservingNumbers } from '../core/chart.ts';

const modal = document.querySelector('#modal');
const content = document.querySelector('#modal-content');
const apply = document.querySelector('#modal-apply');
const remove = document.querySelector('#modal-delete');
const error = document.querySelector('#modal-error');

export function showDialog(title, description) {
  if (modal.open) modal.close();
  document.querySelector('#modal-title').textContent = title;
  document.querySelector('#modal-description').textContent = description;
  error.textContent = '';
  content.replaceChildren();
  apply.hidden = true;
  apply.disabled = false;
  apply.textContent = '应用';
  remove.hidden = true;
  apply.onclick = null;
  remove.onclick = null;
  modal.showModal();
  return content;
}

export function editJson(title, description, value, onApply, onDelete) {
  showDialog(title, description);
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', title + ' JSON');
  textarea.value = stringifyPreservingNumbers(value);
  textarea.spellcheck = false;
  content.append(textarea);
  apply.hidden = false;
  apply.onclick = () => {
    try { onApply(JSON.parse(textarea.value)); modal.close(); }
    catch (failure) { error.textContent = failure.message; }
  };
  if (onDelete) {
    remove.hidden = false;
    remove.onclick = () => {
      try { onDelete(); modal.close(); }
      catch (failure) { showDialog('操作未完成', failure.message); }
    };
  }
}

export function choose(title, description, entries, label, onChoose) {
  showDialog(title, description);
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.textContent = label(entry);
    button.onclick = async () => {
      try { modal.close(); await onChoose(entry); }
      catch (failure) { showDialog('操作未完成', failure.message); }
    };
    content.append(button);
  }
}

export function confirmAction(title, action) {
  showDialog(title, '当前谱面有未保存修改。继续会放弃本次修改；可取消并保存到谱面库或导出 PEZ。自动备份仅在设定间隔到达后生成。');
  apply.hidden = false;
  apply.onclick = () => { modal.close(); action(); };
}

export function dialogOpen() { return Boolean(modal.open || document.querySelector('#settings-modal')?.open); }

