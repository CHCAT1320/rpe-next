import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CollaborationMedia } from '../src/platform/collaboration-media.mjs';

const bytes = Uint8Array.of(1, 2, 3, 4);
const manifest = { id: 'a'.repeat(32), chunkSize: 1024 * 1024, files: [{ name: 'cover.png', size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') }] };

test('HTTP 素材只将令牌放入认证头，临时下载失败重试且不重复安装相同文件', async () => {
  let requests = 0; let installed = 0;
  const media = new CollaborationMedia({ request: async (url, options) => {
    requests++; assert.equal(url.protocol, 'https:'); assert.ok(!url.href.includes('test-secret'));
    assert.equal(options.headers.Authorization, 'Bearer test-secret'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return requests === 1 ? new Response('{}', { status: 503 }) : new Response(bytes);
  } });
  media.configure('wss://example.com/collab', 'room', 'test-secret');
  await media.receive(manifest, async (name, received) => { installed++; assert.deepEqual(received, bytes); });
  await media.receive(manifest, async () => { installed++; });
  assert.equal(requests, 2); assert.equal(installed, 1); media.close();
});

test('取消接收会中止在途下载，取消的数据不会安装，之后可以重新接收', async () => {
  let requested; const started = new Promise(resolve => { requested = resolve; }); let installed = 0;
  const media = new CollaborationMedia({ request: (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); requested();
  }) });
  media.configure('ws://localhost/collab', 'room', 'test-secret');
  const downloading = media.receive(manifest, async () => { installed++; });
  await started; media.stopReceiving(); await downloading; assert.equal(installed, 0);
  media.request = async () => new Response(bytes);
  await media.receive(manifest, async () => { installed++; }); assert.equal(installed, 1); media.close();
});

test('非法清单及损坏下载不会写入项目', async () => {
  let installed = 0; const media = new CollaborationMedia({ request: async () => new Response(Uint8Array.of(9, 9, 9, 9)) });
  media.configure('ws://localhost/collab', 'room', 'test-secret');
  await assert.rejects(media.receive({ ...manifest, files: [{ ...manifest.files[0], name: '../cover.png' }] }, async () => { installed++; }), /清单无效/);
  await assert.rejects(media.receive(manifest, async () => { installed++; }), /校验失败/);
  assert.equal(installed, 0); media.close();
});
