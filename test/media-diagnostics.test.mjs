import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CollaborationMedia, digestBytes } from '../src/platform/collaboration-media.mjs';
import { MediaDiagnostics } from '../src/platform/media-diagnostics.mjs';
import { CollaborationTransport } from '../src/platform/collaboration-transport.mjs';

test('等待阶段每十秒记录一次，可在完成前导出活跃阶段，完成后停止', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const entries = []; const diagnostics = new MediaDiagnostics((phase, details) => entries.push({ phase, ...details }));
  const end = diagnostics.start('hash', { bytes: 100, fileIndex: 1, kind: 'image' });
  assert.equal(diagnostics.snapshot()[0].stage, 'hash');
  context.mock.timers.tick(20000); assert.equal(entries.filter(entry => entry.phase === 'media-hash-waiting').length, 2);
  end(); context.mock.timers.tick(10000); end();
  assert.equal(entries.length, 4); assert.deepEqual(diagnostics.snapshot(), []);
});

test('校验完成后等待 prepare 响应不再显示校验，日志不泄露名称地址凭据与哈希', async () => {
  const bytes = Uint8Array.of(1, 2, 3); const hash = createHash('sha256').update(bytes).digest('hex');
  const manifest = { id: 'a'.repeat(32), chunkSize: 1048576, missing: [hash] };
  const transport = new CollaborationTransport(); const media = transport.media; const stages = [];
  let finishPrepare;
  media.configure('wss://private-host.example/collab', 'private-room', 'private-token');
  media.addEventListener('progress', event => stages.push(event.detail.phase));
  const preparing = new Promise(resolve => {
    media.request = async url => {
      if (url.pathname.endsWith('prepare')) return new Promise(done => { finishPrepare = () => done(Response.json(manifest)); resolve(); });
      return Response.json({ received: bytes.length });
    };
  });
  const publishing = media.publish([['private-cover.png', bytes]]);
  await preparing;
  assert.equal(stages.at(-1), 'prepare');
  assert.ok(media.diagnostics.snapshot().some(entry => entry.endpoint === 'prepare'));
  assert.ok(!media.diagnostics.snapshot().some(entry => entry.stage === 'hash'));
  finishPrepare(); await publishing;
  assert.deepEqual(media.diagnostics.snapshot(), []);
  const output = JSON.stringify(transport.diagnostics);
  for (const secret of ['private-cover', 'private-host', 'private-room', 'private-token', hash]) assert.ok(!output.includes(secret));
  for (const phase of ['media-hash-start', 'media-hash-complete', 'media-request-start', 'media-response-headers', 'media-request-complete', 'media-publish-complete']) assert.ok(output.includes(phase));
  media.close();
});

test('请求失败、重试和最终状态可定位，错误消息不直接写入日志', async () => {
  const media = new CollaborationMedia({ request: async () => Response.json({ error: 'secret-server-path' }, { status: 403 }) });
  const entries = []; media.addEventListener('diagnostic', event => entries.push(event.detail));
  media.configure('wss://example.com/collab', 'room', 'secret');
  await assert.rejects(media.publish([['image.png', Uint8Array.of(1)]]), /secret-server-path/);
  assert.ok(entries.some(entry => entry.phase === 'media-request-failed' && entry.status === 403));
  assert.ok(entries.some(entry => entry.phase === 'media-publish-failed'));
  assert.ok(!JSON.stringify(entries).includes('secret')); assert.deepEqual(media.diagnostics.snapshot(), []);
  media.close();
});

test('Worker 握手和摘要阶段单独记录，不把就绪消息误当作校验结果', async context => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker'); let terminated = 0;
  class FakeWorker {
    postMessage(bytes) {
      queueMicrotask(() => {
        this.onmessage({ data: { phase: 'ready' } }); this.onmessage({ data: { phase: 'digest-start' } });
        this.onmessage({ data: { hash: createHash('sha256').update(bytes).digest('hex') } });
      });
    }
    terminate() { terminated++; }
  }
  globalThis.Worker = FakeWorker;
  context.after(() => { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker; });
  const entries = []; const bytes = Uint8Array.of(4, 5, 6);
  assert.equal(await digestBytes(bytes, undefined, phase => entries.push(phase)), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(terminated, 1);
  for (const phase of ['hash-copy-start', 'hash-copy-complete', 'hash-worker-posted', 'hash-worker-ready', 'hash-worker-digest-start', 'hash-worker-complete']) assert.ok(entries.includes(phase));
  assert.equal(bytes.length, 3);
});

test('Worker 卡住超时会写入失败阶段并清理活跃任务', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class { postMessage() {} terminate() {} };
  context.after(() => { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker; });
  const media = new CollaborationMedia(); const entries = []; media.addEventListener('diagnostic', event => entries.push(event.detail));
  const rejected = assert.rejects(media.hash(Uint8Array.of(1)), error => error.name === 'TimeoutError');
  context.mock.timers.tick(120000); await rejected;
  assert.ok(entries.some(entry => entry.phase === 'media-hash-worker-timeout'));
  assert.ok(entries.some(entry => entry.phase === 'media-hash-failed' && entry.error === 'TimeoutError'));
  assert.deepEqual(media.diagnostics.snapshot(), []);
});
