import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { PROFILES, ConversationEngine, buildConversation, clipBytes, withReplyPreferences } from '../js/conversation-core.mjs';
import { PHRASE_EXAMPLE, findPhrase, parsePhraseTeaching } from '../js/phrases.mjs';

test('explicit teaching commands preserve the requested answer and reject discussion', () => {
  assert.deepEqual(parsePhraseTeaching('もう恋なんてしないなんて？と言われたら「言わないよ絶対〜」って答えて'), {q: 'もう恋なんてしないなんて？', a: '言わないよ絶対〜'});
  assert.deepEqual(parsePhraseTeaching('「おかえり」と聞かれたら「ただいま」と返してください。'), {q: 'おかえり', a: 'ただいま'});
  assert.deepEqual(parsePhraseTeaching('おかえり？と聞かれたら、「ただいま」と答えて'), {q: 'おかえり？', a: 'ただいま'});
  for (const q of ['「ただいま」って答えてもいい？', '彼におかえりと言われたら嬉しい', 'xと言われたら「y」って答えてと友達に言われた']) assert.equal(parsePhraseTeaching(q), null);
});

test('taught phrases recognize punctuation and explicit continuation requests, not unrelated questions', () => {
  const phrases = [PHRASE_EXAMPLE, { q: 'おかえり', a: 'ただいま' }];
  assert.equal(findPhrase('もう恋なんてしないなんて？', phrases)?.a, PHRASE_EXAMPLE.a);
  assert.equal(findPhrase('「もう恋なんてしないなんて」の続きは？', phrases)?.a, PHRASE_EXAMPLE.a);
  assert.equal(findPhrase('おかえり！', phrases)?.a, 'ただいま');
  assert.equal(findPhrase('おかえりの意味は？', phrases), undefined);
  assert.equal(findPhrase('もう恋なんてしない', phrases), undefined);
  assert.equal(findPhrase('', phrases), undefined);
  assert.equal(findPhrase('おかえり', []), undefined);
});

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
  const generated = [];
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
        generated.push(options);
        calls.push('generate:' + id);
        yield { choices: [{ delta: { content: 'こんにちは' } }] };
        if (blockGeneration) await gate;
        if (options.abortSignal.aborted) throw new DOMException('aborted', 'AbortError');
        calls.push('done:' + id);
      },
    };
  });
  return { engine, calls, finish, generated };
}

test('reply length reserves generation space for every profile and tone', () => {
  for (const base of Object.values(PROFILES)) for (const tone of ['standard', 'friendly', 'polite']) {
    const short = withReplyPreferences(base, { tone, length: 'short' });
    const detailed = withReplyPreferences(base, { tone, length: 'detailed' });
    assert.ok(detailed.output > short.output);
    assert.equal(detailed.context, base.context, 'Changing style must not resize the loaded model');
    const messages = buildConversation('説明してください。', Array.from({length: 6}, () => ({q: '質問'.repeat(50), a: '回答'.repeat(70)})), ['メモ'.repeat(500)], detailed);
    const promptBytes = messages.reduce((total, m) => total + Buffer.byteLength(m.content), 0);
    assert.ok(promptBytes + detailed.output + 256 <= base.context);
    assert.equal(messages.at(-1).content, '説明してください。');
    assert.ok(messages[0].content.includes(detailed.toneInstruction));
    assert.ok(messages[0].content.includes(detailed.lengthInstruction));
  }
});

test('changing reply preferences changes generation limits without reloading the model', async () => {
  const { engine, calls, generated } = harness();
  await engine.load(PROFILES.pc);
  await engine.generate([], () => {}, { length: 'short' });
  await engine.generate([], () => {}, { length: 'detailed' });
  assert.equal(generated[0].max_tokens, 128);
  assert.equal(generated[1].max_tokens, 768);
  assert.equal(calls.filter(c => c.startsWith('new:')).length, 1);
  assert.ok(!calls.some(c => c.startsWith('exit:')));
});
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
  const cache = { addAll: async (requests) => { for (const r of requests) { assert.equal(r.cache, 'reload'); added.push('./' + new URL(r.url).pathname.split('/ai-safari/')[1]); } }, match: async (path) => { lookedUp.push(path); return new Response(path); } };
  const context = { URL, Response, Request, fetch: () => { throw new Error('network not allowed'); },
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
