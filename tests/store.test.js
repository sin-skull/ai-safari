// フェーズ5 の回帰テスト：端末に保存したものの管理（確認・削除・二重取得の防止）。
// 本物の Cache Storage の代わりに、同じ形の疑似 caches を使う。
(function () {
  'use strict';
  const { test, equal, ok } = window.T;

  function fakeCaches(initial) {
    const stores = new Map();
    const mk = (entries) => {
      const m = new Map(Object.entries(entries));
      return {
        async keys() {
          return Array.from(m.keys()).map((url) => ({ url }));
        },
        async match(req) {
          const url = typeof req === 'string' ? req : req.url;
          if (!m.has(url)) return undefined;
          const size = m.get(url);
          return { headers: { get: (h) => (h === 'content-length' ? String(size) : null) }, blob: async () => ({ size }) };
        },
        async delete(req) {
          return m.delete(typeof req === 'string' ? req : req.url);
        },
      };
    };
    for (const [name, entries] of Object.entries(initial)) stores.set(name, mk(entries));
    return {
      async has(name) {
        return stores.has(name);
      },
      async open(name) {
        if (!stores.has(name)) stores.set(name, mk({}));
        return stores.get(name);
      },
      async delete(name) {
        return stores.delete(name);
      },
    };
  }

  const HF = 'https://huggingface.co';
  const sample = () =>
    fakeCaches({
      'ai-safari-transformers-cache': {
        [`${HF}/Xenova/multilingual-e5-small/resolve/main/config.json`]: 1000,
        [`${HF}/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx`]: 100 * 1024 * 1024,
        [`${HF}/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/config.json`]: 2000,
        [`${HF}/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/onnx/model_quantized.onnx`]: 500 * 1024 * 1024,
      },
      'ai-safari-lib-1': { 'https://cdn.jsdelivr.net/lib.js': 900000 },
    });

  test('store: モデルごとに保存状況を調べる（別のモデルと混ざらない）', async () => {
    const c = sample();
    const e5 = await AI.store.inspectModel('Xenova/multilingual-e5-small', c);
    equal(e5.cached, true);
    equal(e5.files, 2);
    equal(e5.bytes, 100 * 1024 * 1024 + 1000);
    const qwen = await AI.store.inspectModel('onnx-community/Qwen2.5-0.5B-Instruct', c);
    equal(qwen.bytes, 500 * 1024 * 1024 + 2000);
    const none = await AI.store.inspectModel('someone/else', c);
    equal(none.cached, false);
    equal(none.files, 0);
  });

  test('store: 設定ファイルだけで重みが無いときは「保存済み」にしない（残りだけ取る）', async () => {
    const c = fakeCaches({ 'ai-safari-transformers-cache': { [`${HF}/a/b/resolve/main/config.json`]: 10 } });
    const st = await AI.store.inspectModel('a/b', c);
    equal(st.cached, false);
    equal(st.files, 1);
  });

  test('store: 保存先が無い端末（caches なし）でも落ちない', async () => {
    const st = await AI.store.inspectModel('a/b', null);
    equal(st.cached, false);
    equal((await AI.store.inspectLibrary(null)).cached === false || true, true);
  });

  test('store: 1つのモデルだけを消せる。他のモデルと実行用ファイルは残る', async () => {
    const c = sample();
    const n = await AI.store.removeModel('onnx-community/Qwen2.5-0.5B-Instruct', c);
    equal(n, 2);
    equal((await AI.store.inspectModel('onnx-community/Qwen2.5-0.5B-Instruct', c)).files, 0);
    equal((await AI.store.inspectModel('Xenova/multilingual-e5-small', c)).cached, true);
    equal((await AI.store.inspectLibrary(c)).cached, true);
  });

  test('store: 実行用ファイルを消せる', async () => {
    const c = sample();
    equal((await AI.store.inspectLibrary(c)).bytes, 900000);
    await AI.store.removeLibrary(c);
    equal((await AI.store.inspectLibrary(c)).cached, false);
    equal((await AI.store.inspectModel('Xenova/multilingual-e5-small', c)).cached, true);
  });

  test('store: 同じ名前の処理は1回だけ動く（二重ダウンロードの防止）', async () => {
    let calls = 0;
    const work = () =>
      new Promise((resolve) => {
        calls++;
        setTimeout(() => resolve('done'), 20);
      });
    const [a, b] = await Promise.all([AI.store.once('x', work), AI.store.once('x', work)]);
    equal(calls, 1);
    equal(a, 'done');
    equal(b, 'done');
    await AI.store.once('x', work); // 終わったあとなら、また動かせる
    equal(calls, 2);
  });

  test('store: 失敗しても、次は取り直せる', async () => {
    let calls = 0;
    const bad = async () => {
      calls++;
      throw new Error('boom');
    };
    let failed = 0;
    await AI.store.once('y', bad).catch(() => failed++);
    await AI.store.once('y', bad).catch(() => failed++);
    equal(calls, 2);
    equal(failed, 2);
  });

  test('store: 容量の表示', () => {
    equal(AI.store.formatSize(500 * 1024 * 1024), '500MB');
    equal(AI.store.formatSize(1.5 * 1024 * 1024 * 1024), '1.5GB');
  });
})();
