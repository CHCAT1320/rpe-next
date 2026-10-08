import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { startCollaborationServer } from '../server.mjs';
import { createChart } from '../../src/core/chart.mjs';
import { EditorSession } from '../../src/application/session.mjs';
import { CollaborationClient } from '../../src/application/collaboration-client.mjs';
import { CollaborationTransport } from '../../src/platform/collaboration-transport.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > 10000) throw new Error('联机素材测试超时'); await wait(10); }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function room(context) {
  const service = await startCollaborationServer({ port: 0 }); const failures = []; const clients = [];
  context.after(async () => { for (const peer of clients) peer.client.leave(); await service.close(); });
  const address = `ws://127.0.0.1:${service.port}/collab`;
  const make = () => {
    const transport = new CollaborationTransport(); const session = new EditorSession(createChart());
    const client = new CollaborationClient(transport, { session: () => session, receiveChart: chart => { session.history.document = chart; }, notify: (message, level) => { if (level === 'error') failures.push(message); } });
    const received = new Map(); const manifests = [];
    client.addEventListener('asset-manifest', event => {
      manifests.push(event.detail);
      transport.media.receive(event.detail, async (name, bytes) => received.set(name, bytes)).catch(error => failures.push(error.message));
    });
    const peer = { client, transport, received, manifests }; clients.push(peer); return peer;
  };
  const host = make(); host.client.connect(address, { name: 'Host' }); await until(() => host.client.ready);
  const join = async (enabled = false) => {
    const peer = make(); peer.transport.subscribeAssets(enabled);
    peer.client.connect(address, { name: 'Guest' }, { room: host.client.room, token: host.client.token });
    await until(() => host.client.requests.length); host.client.approve(host.client.requests[0].request, true); await until(() => peer.client.ready); return peer;
  };
  return { service, host, join, failures };
}

test('无人接收也能发布；晚加入勾选自动补收、更新整组、复用相同文件与断线后的授权隔离', { timeout: 20000 }, async context => {
  const { host, join, failures } = await room(context);
  const audio = randomBytes(3 * 1024 * 1024 + 13); const cover = randomBytes(1024 * 1024 + 19);
  const published = await host.transport.media.publish([['song.ogg', audio], ['cover.png', cover]]);
  const guest = await join(false); await wait(50); assert.equal(guest.manifests.length, 0);
  guest.transport.subscribeAssets(true); await until(() => guest.received.size === 2 || failures.length);
  assert.deepEqual(failures, []); assert.equal(hash(guest.received.get('song.ogg')), hash(audio)); assert.equal(hash(guest.received.get('cover.png')), hash(cover));
  assert.equal(guest.manifests[0].id, published.id);
  const upload = []; host.transport.media.addEventListener('progress', event => upload.push(event.detail));
  const replacement = randomBytes(100000);
  const next = await host.transport.media.publish([['song.ogg', audio], ['cover.png', replacement]]);
  await until(() => guest.received.get('cover.png')?.length === replacement.length);
  assert.equal(hash(guest.received.get('cover.png')), hash(replacement));
  assert.equal(upload.filter(entry => entry.phase === 'upload').at(-1).total, replacement.length);
  const third = await join(true); await until(() => third.received.size === 2);
  assert.equal(third.manifests[0].id, next.id); assert.equal(hash(third.received.get('cover.png')), hash(replacement));
  const url = new URL(`file/${next.id}/${hash(audio)}/0`, guest.transport.media.base); const credential = guest.transport.media.token;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(new URL('prepare', guest.transport.media.base), { method: 'POST', headers: { Authorization: `Bearer ${credential}` }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Headers': 'authorization' } })).status, 204);
  guest.client.leave(); await wait(20);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${credential}` } })).status, 403);
  assert.deepEqual(failures, []);
});

test('高时延下实际四路二进制并发，慢成员不阻塞房主发布或另一成员下载', { timeout: 20000 }, async context => {
  const { host, join, failures } = await room(context);
  const bytes = randomBytes(8 * 1024 * 1024); let inFlight = 0; let peak = 0;
  host.transport.media.request = async (...args) => {
    inFlight++; peak = Math.max(peak, inFlight);
    try { await wait(120); return await fetch(...args); } finally { inFlight--; }
  };
  const slow = await join(true); const fast = await join(true);
  slow.transport.media.request = async (...args) => { await wait(800); return fetch(...args); };
  const started = performance.now(); await host.transport.media.publish([['large.ogg', bytes]]); const uploadMilliseconds = performance.now() - started;
  await until(() => fast.received.size === 1 || failures.length); const fastMilliseconds = performance.now() - started;
  assert.equal(peak, 4); assert.equal(slow.received.size, 0);
  assert.equal(hash(fast.received.get('large.ogg')), hash(bytes));
  await until(() => slow.received.size === 1 || failures.length); assert.equal(hash(slow.received.get('large.ogg')), hash(bytes));
  assert.deepEqual(failures, []);
  context.diagnostic(JSON.stringify({ bytes: bytes.length, simulatedRequestLatencyMs: 120, concurrentRequests: peak, uploadMilliseconds: Math.round(uploadMilliseconds), fastMemberMilliseconds: Math.round(fastMilliseconds), slowMemberMilliseconds: Math.round(performance.now() - started) }));
});

test('不完整上传与错误哈希不会覆盖最近已发布的素材组', async context => {
  const { host, join } = await room(context); const media = host.transport.media; const signal = new AbortController().signal;
  const previous = await media.publish([['cover.png', Uint8Array.of(1, 2, 3)]]);
  const invalidHash = 'a'.repeat(64);
  const pending = await media.fetch('prepare', { method: 'POST', body: JSON.stringify({ files: [{ name: 'cover.png', hash: invalidHash, size: 3 }] }) }, signal);
  await assert.rejects(media.fetch(`commit/${pending.id}`, { method: 'POST' }, signal), /尚未上传完整/);
  await media.fetch(`upload/${pending.id}/${invalidHash}/0`, { method: 'PUT', body: Uint8Array.of(4, 5, 6) }, signal);
  await assert.rejects(media.fetch(`commit/${pending.id}`, { method: 'POST' }, signal), /校验失败/);
  const guest = await join(true); await until(() => guest.received.size === 1);
  assert.equal(guest.manifests[0].id, previous.id); assert.deepEqual(guest.received.get('cover.png'), Uint8Array.of(1, 2, 3));
});
