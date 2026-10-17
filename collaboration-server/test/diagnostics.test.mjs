import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import diagnostics from '../diagnostics.cjs';

test('诊断日志跨启动追加，按大小保留有限轮换文件', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rpen-diagnostics-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.log'), first = diagnostics.createDiagnostics(path, { maxBytes: 200 });
  first.write({ phase: 'first' }); await first.flush();
  const second = diagnostics.createDiagnostics(path, { maxBytes: 200 }); second.write({ phase: 'second' }); await second.flush();
  assert.match(await readFile(path, 'utf8'), /first/); assert.match(await readFile(path, 'utf8'), /second/);
  for (let index = 0; index < 25; index++) second.write({ phase: 'more', index }); await second.flush();
  const files = await readdir(directory); assert.ok(files.length <= 4); assert.ok(files.includes('test.log.3'));
  const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse));
  assert.ok(lines.some(line => line.index === 24)); assert.ok(lines.every(line => line.time));
});
