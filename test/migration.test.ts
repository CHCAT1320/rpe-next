import test from 'node:test';
import assert from 'node:assert/strict';
import { migratePreferences, shortcutAction } from '../src/core/preferences.ts';
import { scanMigration, materializeProject, decodeLegacy, parseInfo, migrationConflicts } from '../src/platform/migration.ts';
import { createChart } from '../src/core/chart.ts';
import { parseDocument } from '../src/core/formats.ts';

function entry(path, content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { path, getFile: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer }) };
}

test('迁移热键真正匹配，未支持配置原样保留', () => {
  const preferences = migratePreferences('{"MusicVolume":0.4,"maxHistorySize":60,"Unknown":{"enabled":true}}', 'AddTap A\nSave LEFTCTRL&K\nFutureAction LEFTALT&F\n');
  assert.equal(preferences.settings.volume, 0.4);
  assert.equal(preferences.settings.historyLimit, 60);
  assert.deepEqual(preferences.originalSettings.Unknown, { enabled: true });
  assert.deepEqual(preferences.report.retainedHotkeys, ['FutureAction']);
  assert.equal(shortcutAction({ key: 'a' }, preferences), 'AddTap');
  assert.equal(shortcutAction({ key: 'q' }, preferences), undefined);
  assert.equal(shortcutAction({ key: 'k', ctrlKey: true }, preferences), 'Save');
  assert.equal(shortcutAction({ key: 'a', ctrlKey: true }, preferences), 'SelectAll');
});

test('扫描按 info.txt 选择主谱，保留项目资源，不读取凭据', async () => {
  const chart = createChart(); chart.META.name = '迁移测试'; chart.custom = { preserved: true };
  const entries = [entry('Settings.json', '{"MusicVolume":0.4}'), entry('Hotkey.txt', 'AddTap A'),
    entry('Resources/1/info.txt', '#\nName: 迁移测试\nChart: main.json\nSong: music.ogg'),
    entry('Resources/1/main.json', JSON.stringify(chart)), entry('Resources/1/AutoSave_old.json', JSON.stringify(chart)),
    entry('Resources/1/music.ogg', new Uint8Array([1, 2, 3])), entry('Resources/1/textures/测试.png', new Uint8Array([4, 5])),
    { path: 'User.txt', getFile: () => { throw new Error('不应该读取账户数据'); } }];
  const plan = await scanMigration(entries, 'Old RPE');
  assert.equal(plan.projects.length, 1);
  assert.equal(plan.failures.length, 0);
  const project = await materializeProject(plan, plan.projects[0]);
  assert.deepEqual(project.chart, chart);
  assert.equal(project.assets.length, 5);
  assert.ok(new Map(project.assets).has('textures/测试.png'));
  assert.equal(project.chartName, 'main.json');
  assert.equal((await materializeProject(plan, plan.projects[0])).id, project.id);
});

test('扫描失败单独报告，不假装迁移成功', async () => {
  const plan = await scanMigration([entry('Resources/2/info.txt', 'Chart: missing.json'), entry('Settings.json', '{}')], 'RPE');
  assert.equal(plan.failures.length, 1);
  assert.equal(plan.projects.length, 0);
  assert.deepEqual(parseInfo('Name: A:B\nChart: x.json'), { Name: 'A:B', Chart: 'x.json' });
  assert.equal(decodeLegacy(new Uint8Array([0xd6, 0xd0])), '中');
});

test('迁移 extra.json 保留字节并接入 effects，标识冲突不依赖主文件夹名或歌曲名', async () => {
  const chart = createChart(); const extra = JSON.stringify({ effects: [{ shader: 'grayscale', start: [0, 0, 1], end: [4, 0, 1] }], custom: '保留' });
  const entries = [entry('Resources/Same/info.txt', 'Path: Same\nChart: main.json'), entry('Resources/Same/main.json', JSON.stringify(chart)), entry('Resources/Same/EXTRA.JSON', extra)];
  const plan = await scanMigration(entries, 'NewFolder');
  const project = await materializeProject(plan, plan.projects[0]);
  assert.equal(new TextDecoder().decode(new Map(project.assets).get('EXTRA.JSON')), extra);
  assert.equal(project.chart.effects[0].shader, 'grayscale');
  const existing = [{ id: 'old-id', source: 'OldFolder/Resources/SAME/main.json', name: '改过曲名' }];
  const conflicts = migrationConflicts(plan.projects, existing);
  assert.equal(conflicts[0].existing.id, 'old-id');
  assert.equal(migrationConflicts(plan.projects, [{ id: project.id }])[0].existing.id, project.id);
  assert.equal(migrationConflicts([{ directory: 'Resources/Other/', name: '改过曲名' }], existing)[0].existing, undefined);
});

test('迁移共享音乐与曲绘按相对路径及大小写解析', async () => {
  const chart = createChart(); chart.META.song = '..\\Shared\\Music.FLAC'; chart.META.background = 'cover.jpeg';
  const entries = [entry('Resources/1/main.json', JSON.stringify(chart)), entry('Resources/Shared/music.flac', new Uint8Array([1, 2])), entry('Resources/COVER.JPEG', new Uint8Array([3, 4]))];
  const plan = await scanMigration(entries, 'RPE'); const project = await materializeProject(plan, plan.projects[0]);
  const assets = new Map(project.assets);
  assert.deepEqual(assets.get(chart.META.song), new Uint8Array([1, 2]));
  assert.deepEqual(assets.get(chart.META.background), new Uint8Array([3, 4]));
});

test('旧 RPE 三元文本转换，精确保留音符字段和原文', () => {
  const text = '100\nbp 0 0 1 120\nli 0 1 line.png 0\ncx 0 0 0 1 4 0 1 0 100 1 0\ncv 0 0 0 1 4 0 1 10 10 0\nn2 0 1 1 3 2 1 3 50 1.5 1 5 0 2 99\nct 0 0 0 1 4 0 1 1 Hello%S%world %N%';
  const chart = parseDocument(text);
  assert.equal(chart.META.offset, 100);
  assert.deepEqual(chart.judgeLineList[0].notes[0].startTime, [1, 1, 3]);
  assert.equal(chart.judgeLineList[0].notes[0].speed, 1.5);
  assert.equal(chart.judgeLineList[0].notes[0].yOffset, 5);
  assert.equal(chart.judgeLineList[0].extended.textEvents[0].start, 'Hello world');
  assert.equal(chart.rpeNextLegacySource.text, text);
});

test('PEC 按原 SavePec 反向转换 offset、坐标、速度和类型', () => {
  const chart = parseDocument('175\nbp 0 120\ncp 0 0 1024 700\ncm 0 0 4 2048 1400 1\ncv 0 0 17.11111111111111\nn4 0 2 1024 1 0\n# 2\n& 1.5\nn2 0 4 8 0 0 1');
  assert.equal(chart.META.offset, 0);
  const line = chart.judgeLineList[0];
  assert.equal(line.notes[0].type, 4);
  assert.equal(line.notes[0].positionX, 675);
  assert.equal(line.notes[0].speed, 2);
  assert.equal(line.notes[1].above, 0);
  assert.equal(line.eventLayers[0].moveXEvents.at(-1).end, 675);
  assert.equal(line.eventLayers[0].moveYEvents.at(-1).end, 450);
  assert.ok(Math.abs(line.eventLayers[0].speedEvents[0].start - 10) < 1e-12);
});
