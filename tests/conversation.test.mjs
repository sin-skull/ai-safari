import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { PROFILES, ConversationEngine, buildConversation, clipBytes } from '../js/conversation-core.mjs';

test('Japanese text budget preserves current question and complete recent exchanges', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ q: '前の質問' + i, a: '答えです。'.repeat(12) }));
  const messages = buildConversation('私の名前を覚えていますか？', history, ['保存メモ'.repeat(600)], PROFILES.mobile);
  assert.equal(messages.at(-1).content, '私の名前を覚えていますか？');
  assert.ok(messages.length < 62);
  assert.ok(messages.some((m) => m.content === '前の質問29'));
  assert.ok(messages.reduce((n, m) => n + new TextEncoder().encode(m.content).length, 0) <= PROFILES.mobile.context - PROFILES.mobile.output - 256);
  assert.equal(clipBytes('あいう', 7), 'あい');
  assert.throws(() => buildConversation('あ'.repeat(3000), [], [], PROFILES.mobile), /短く/);
});
test('No-document conversation is allowed; stopped answers are excluded from context', () => {
  const messages = buildConversation('こんにちは', [{ q: 'old', a: 'partial', interrupted: true }], [], PROFILES.mobile);
  assert.equal(messages.length, 2);
  assert.ok(!messages[0].content.includes('資料だけ'));
});

function harness({ failLoad = false, failExit = false, blockGeneration = false } = {}) {
  const calls = [];
  let finish;
  const gate = new Promise((r) => { finish = r; });
  let count = 0;
  const engine = new ConversationEngine(async () => {
    const id = ++count;
    calls.push('new:' + id);
    return {
      async loadModelFromUrl(url, options) { calls.push('load:' + id); assert.equal(options.n_parallel, 1); if (failLoad) throw new Error('load failed'); },
      async exit() { calls.push('exit:' + id); if (failExit) throw new Error('exit failed'); },
      async *createChatCompletion(options) {
        calls.push('generate:' + id);
        yield { choices: [{ delta: { content: 'こんにちは' } }] };
        if (blockGeneration) await gate;
        if (options.abortSignal.aborted) throw new DOMException('aborted', 'AbortError');
        calls.push('done:' + id);
      },
    };
  });
  return { engine, calls, finish };
}
test('simultaneous model changes release old worker before creating a new worker', async () => {
  const { engine, calls } = harness();
  await Promise.all([engine.load(PROFILES.mobile), engine.load(PROFILES.pc)]);
  assert.deepEqual(calls, ['new:1', 'load:1', 'exit:1', 'new:2', 'load:2']);
});
test('model switching waits for generation to finish before releasing resources', async () => {
  const { engine, calls, finish } = harness({ blockGeneration: true });
  await engine.load(PROFILES.mobile);
  const reply = engine.generate([], () => {});
  await new Promise((r) => setTimeout(r, 0));
  const next = engine.load(PROFILES.pc);
  assert.ok(!calls.includes('exit:1'));
  finish(); await reply; await next;
  assert.ok(calls.indexOf('done:1') < calls.indexOf('exit:1'));
});
test('stop preserves partial output and permits the next operation', async () => {
  const { engine, finish } = harness({ blockGeneration: true });
  await engine.load(PROFILES.mobile);
  const reply = engine.generate([], () => {});
  await new Promise((r) => setTimeout(r, 0));
  const release = engine.unload();
  finish();
  assert.deepEqual(await reply, { text: 'こんにちは', interrupted: true });
  await release;
  assert.equal(engine.state, 'idle'); assert.equal(engine.worker, null);
});
test('failed model load is released and does not poison serialization', async () => {
  const { engine, calls } = harness({ failLoad: true });
  await assert.rejects(engine.load(PROFILES.mobile));
  assert.ok(calls.includes('exit:1')); assert.equal(engine.worker, null);
  await engine.unload(); assert.equal(engine.state, 'idle');
});
test('stop releases a worker even when its next token never resolves', { timeout: 1000 }, async () => {
  const { engine, calls } = harness({ blockGeneration: true });
  await engine.load(PROFILES.mobile);
  const reply = engine.generate([], () => {});
  await new Promise((r) => setTimeout(r, 0));
  engine.stop();
  assert.deepEqual(await reply, { text: 'こんにちは', interrupted: true });
  assert.ok(calls.includes('exit:1'));
  assert.equal(engine.state, 'idle');
});
test('failed release prevents allocation of a second model', async () => {
  const { engine, calls } = harness({ failExit: true });
  await engine.load(PROFILES.mobile);
  await assert.rejects(engine.load(PROFILES.pc));
  assert.ok(!calls.includes('new:2')); assert.equal(engine.state, 'error');
});
test('service-worker precache contains all imported runtime files and separates navigation pages', async () => {
  const handlers = {}, added = [], lookedUp = [];
  const cache = { addAll: async (paths) => added.push(...paths), match: async (path) => { lookedUp.push(path); return new Response(path); } };
  const context = { URL, Response, fetch: () => { throw new Error('network not allowed'); },
    caches: { open: async () => cache },
    self: { location: new URL('https://test.invalid/ai-safari/sw.js'), addEventListener: (n, h) => { handlers[n] = h; }, skipWaiting: async () => {} },
  };
  vm.runInNewContext(readFileSync('sw.js', 'utf8'), context);
  let installing;
  handlers.install({ waitUntil: (p) => { installing = p; } }); await installing;
  for (const path of added) assert.ok(existsSync(path.split('?')[0]), path);
  for (const file of ['js/conversation.mjs', 'js/conversation-core.mjs', 'js/runtime-compat.mjs', 'lab/storage.js', 'lab/vendor/wllama-3.6.1/index.js', 'lab/vendor/wllama-3.6.1/wasm/wllama.wasm', 'lab/vendor/wllama-compat-3.6.1/wasm/wllama.js', 'lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm']) assert.ok(added.includes('./' + file), file);
  for (const page of ['', 'memory.html', 'lab/index.html']) {
    let response;
    handlers.fetch({ request: { url: 'https://test.invalid/ai-safari/' + page, method: 'GET', mode: 'navigate' }, respondWith: (p) => { response = p; } });
    assert.equal(await (await response).text(), './' + (page || 'index.html'));
  }
});

test('CPU bypasses the unreliable Memory64 probe while GPU retains vendor selection', async () => {
  const { configureRuntime } = await import('../js/runtime-compat.mjs');
  const paths = { worker: 'https://example.test/compat.js', wasm: 'https://example.test/compat.wasm' };
  const normal = () => ({ compat: false, wasmPath: 'modern.wasm' });
  const cpu = { setCompat() {}, getWorkerResources: normal };
  configureRuntime(cpu, paths, true);
  assert.deepEqual(cpu.getWorkerResources(), { wasmPath: paths.wasm, jsPath: paths.worker, compat: true });
  const gpu = { setCompat() {}, getWorkerResources: normal };
  configureRuntime(gpu, paths, false);
  assert.equal(gpu.getWorkerResources, normal);
});
