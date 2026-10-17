import { localPreferences, flushLocalPreferences } from '../platform/local-preferences.mjs';
import { requestPersistence, storageStatus } from '../platform/storage.mjs';
import { exportLibrary } from '../platform/library-backup.mjs';
import { download } from '../platform/files.mjs';
import { deleteDraft, listDrafts } from '../platform/recovery.mjs';
import { listProjects } from '../platform/library.mjs';
import { showDialog } from './dialog.mjs';
import { nativeStorage, nativeList } from '../platform/native.mjs';

const BACKUP_KEY = 'rpe-next-external-backup-v1';
const FIRST_SAVE_KEY = 'rpe-next-first-library-save-v1';
export function noteExternalBackup() { try { localPreferences.setItem(BACKUP_KEY, String(Date.now())); } catch {} }
export function noteLibrarySave() { try { if (!localPreferences.getItem(FIRST_SAVE_KEY)) localPreferences.setItem(FIRST_SAVE_KEY, String(Date.now())); } catch {} }
const bytes = value => Number.isFinite(value) ? `${(value / 1024 ** 2).toFixed(1)} MiB` : '未知';

export class StoragePanel {
  constructor(settings, { reportError, notify, canSwitchLibrary = () => true }) {
    this.reportError = reportError; this.notify = notify;
    this.host = document.createElement('section'); this.host.id = 'storage-settings';
    const title = document.createElement('h3'); title.textContent = '本地存储与外部备份';
    this.status = document.createElement('p'); this.status.id = 'storage-status'; this.status.setAttribute('role', 'status');
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '谱面库与自动备份属于同一份站点数据。持久化可降低浏览器回收风险，无法抵御主动清除网站数据；请保留外部 PEZ 备份。不同浏览器或地址的谱面库相互独立。';
    if (nativeStorage) hint.textContent = '桌面设置统一保存在当前谱面库的 preferences 目录，更新或移动程序后会自动沿用，无需复制程序文件夹。谱面库使用独立文件与去重素材保存，索引损坏可重建。恢复记录与回收站仍在库内，请另存独立文件夹备份或 PEZ。首次迁移保留旧数据库。';
    const actions = document.createElement('div'); actions.className = 'storage-actions';
    const button = (label, id, run) => { const node = document.createElement('button'); node.type = 'button'; node.id = id; node.textContent = label; node.onclick = async () => { node.disabled = true; try { await run(); } catch (error) { reportError(error); } finally { node.disabled = false; } }; actions.append(node); return node; };
    this.persist = button('申请持久化保护', 'storage-persist', async () => { const result = await requestPersistence(); notify(result === true ? '已获得持久化存储保护，仍请保留外部备份' : result === false ? '浏览器未批准持久化，可稍后重试；请导出外部备份' : '当前环境不支持持久化申请，请保留外部备份', result === true ? 'success' : 'warning'); await this.refresh(); });
    button('刷新用量', 'storage-refresh', () => this.refresh());
    button('导出全部谱面备份', 'library-export-all', () => this.exportAll());
    button('管理恢复备份', 'storage-recovery-manage', () => this.manageRecovery());
    if (nativeStorage) {
      this.persist.hidden = true;
      button('打开谱面库文件夹', 'storage-open-root', () => nativeStorage.call('openRoot'));
      button('迁移谱面库位置', 'storage-move-root', async () => {
        await this.confirm('迁移谱面库', '将完整复制并校验谱面库到所选文件夹下的 RPENLibrary，成功后切换到新位置。原文件夹保留；请等当前保存结束后操作。', async () => {
          this.status.textContent = '正在复制并校验谱面库，请稍候…';
          await flushLocalPreferences();
          const result = await nativeStorage.call('chooseRoot');
          if (result) this.notify('谱面库位置已更新，原文件夹已保留', 'success');
          await this.refresh();
        });
      });
      button('备份完整库到文件夹', 'storage-backup-folder', async () => {
        this.status.textContent = '正在复制并校验完整谱面库，请稍候…';
        await flushLocalPreferences();
        const result = await nativeStorage.call('backupFolder');
        if (result) { noteExternalBackup(); this.notify('已完成独立备份：' + result.root, 'success', 7000); }
        await this.refresh();
      });
      button('管理回收站', 'storage-trash', () => this.manageTrash());
      button('使用已有谱面库 / 完整备份', 'storage-use-root', () => {
        if (!canSwitchLibrary()) return;
        return this.confirm('使用已有谱面库', '选择一个包含 library.json 的完整库或备份文件夹，成功后重新载入并回到谱面库。当前库保留，两个库不会合并；请先保存正在编辑的项目。', async () => {
          await flushLocalPreferences();
          const result = await nativeStorage.call('useRoot'); if (result) location.reload();
        });
      });
      button('重建库索引', 'storage-rebuild', async () => { await nativeStorage.call('rebuild'); document.dispatchEvent(new Event('rpen-library-refresh')); await this.refresh(); this.notify('已从项目文件重建索引', 'success'); });
      button('清理无引用素材', 'storage-collect', () => this.confirm('清理无引用素材', '仅清理没有被项目、保留版本、回收站、恢复记录或皮肤模组引用的素材文件。历史版本仍会保留。', async () => {
        const result = await nativeStorage.call('collect'); this.notify(`已释放 ${bytes(result.bytes)}，清理 ${result.removed} 个素材文件`, 'success'); await this.refresh();
      }));
    }
    this.host.append(title, this.status, hint, actions); settings.querySelector('.settings-body').append(this.host);
    this.banner = document.createElement('p'); this.banner.id = 'storage-backup-reminder'; this.banner.className = 'hint'; this.banner.hidden = true; document.querySelector('#project-cards').before(this.banner);
    document.addEventListener('rpen-storage-changed', () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh().catch(error => reportError(error)), 300); });
    settings.addEventListener('toggle', () => { if (settings.open) this.refresh().catch(reportError); });
    listProjects().then(projects => { if (projects.length) noteLibrarySave(); return this.refresh(); }).catch(reportError);
  }
  async refresh() {
    const info = await storageStatus();
    this.status.textContent = info.native ? `谱面库：${info.root}\n素材 ${bytes(info.usage)}（${info.blobs} 个去重文件） · 磁盘剩余 ${bytes(info.free)} · ${info.projects} 个项目 / 回收站 ${info.trash} 个` : `${info.persistent === true ? '持久化保护已开启' : info.supported ? '尚未获得持久化保护' : '当前环境无法查询持久化状态'} · 已用 ${bytes(info.usage)} / 估计配额 ${bytes(info.quota)}`;
    if (info.native && info.warnings?.length) this.status.textContent += '\n' + [...new Set(info.warnings)].join('；');
    this.persist.disabled = info.persistent === true || !globalThis.navigator?.storage?.persist;
    let last = 0, first = 0; try { last = Number(localPreferences.getItem(BACKUP_KEY)) || 0; first = Number(localPreferences.getItem(FIRST_SAVE_KEY)) || 0; } catch {}
    const due = first > 0 && (!last || Date.now() - last > 7 * 86400000) && (await listProjects()).length > 0;
    this.banner.hidden = !due;
    this.banner.textContent = !last ? '尚未记录外部备份。建议导出 PEZ；设置 → 本地存储可一次备份整个谱面库。' : nativeStorage ? '距上次外部备份已超过 7 天，建议备份完整库到其他磁盘或导出 PEZ。' : '距上次发起外部备份已超过 7 天。建议导出 PEZ；自动备份也会随站点数据一同被清除。';
    if (info.quota && info.usage / info.quota >= .85) { this.banner.hidden = false; this.banner.textContent = '本地存储已使用超过估计配额的 85%，建议先导出备份，再清理不需要的项目或恢复备份。'; }
  }
  async confirm(title, description, run) {
    document.querySelector('#settings-modal').close();
    showDialog(title, description);
    const apply = document.querySelector('#modal-apply'); apply.hidden = false; apply.textContent = '确认';
    apply.onclick = async () => {
      apply.disabled = true;
      try { await run(); document.querySelector('#modal').close(); }
      catch (error) { document.querySelector('#modal-error').textContent = error.message; }
      finally { apply.disabled = false; }
    };
  }
  async manageTrash() {
    document.querySelector('#settings-modal').close();
    const host = showDialog('谱面库回收站', '恢复会重新加入谱面库；永久删除后可使用“清理无引用素材”释放不再被历史或备份引用的文件。');
    const projects = await nativeList('projects', true);
    if (!projects.length) { host.textContent = '回收站为空。'; return; }
    for (const project of projects) {
      const row = document.createElement('div'); row.className = 'storage-draft-row';
      const label = document.createElement('span'); label.textContent = `${project.name} · ${new Date(project.deletedAt).toLocaleString()}`;
      const restore = document.createElement('button'); restore.textContent = '恢复';
      const purge = document.createElement('button'); purge.textContent = '永久删除';
      const act = async method => {
        restore.disabled = purge.disabled = true;
        try { await nativeStorage.call(method, project.id, project.storageRevision); row.remove(); document.dispatchEvent(new Event('rpen-library-refresh')); await this.refresh(); }
        catch (error) { this.reportError(error); restore.disabled = purge.disabled = false; }
      };
      restore.onclick = () => act('restore');
      purge.onclick = () => { if (confirm(`永久删除“${project.name}”？此操作无法撤销。`)) act('purge'); };
      row.append(label, restore, purge); host.append(row);
    }
  }
  async exportAll() {
    const result = await exportLibrary({ progress: (index, count, name) => { this.status.textContent = `正在打包外部备份 ${index}/${count}${name ? '：' + name : ''}`; } });
    download(result.blob, `rpe-next-library-${new Date().toISOString().slice(0, 10)}.zip`);
    noteExternalBackup(); this.notify(`已发起 ${result.count} 个项目的备份下载；请确认下载完成。恢复时解压 ZIP，分别打开其中的 PEZ。`, 'success', 7000); await this.refresh();
  }
  async manageRecovery() {
    document.querySelector('#settings-modal').close();
    const host = showDialog('管理恢复备份', '删除只影响选中的恢复副本，不改变谱面库项目。请先保留需要的外部备份。');
    const drafts = await listDrafts();
    if (!drafts.length) { host.textContent = '没有恢复备份。'; return; }
    for (const draft of drafts) {
      const row = document.createElement('div'); row.className = 'storage-draft-row';
      const label = document.createElement('span'); label.textContent = `${draft.title || draft.name} · ${new Date(draft.updated).toLocaleString()}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除此备份';
      remove.onclick = async () => { if (!confirm('永久删除这份恢复备份？')) return; try { remove.disabled = true; await deleteDraft(draft.id); row.remove(); await this.refresh(); } catch (error) { remove.disabled = false; this.reportError(error); } };
      row.append(label, remove); host.append(row);
    }
  }
}
