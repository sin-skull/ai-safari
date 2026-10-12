// 端末に保存したもの（モデルなど）の管理。
//   ・何がどれだけ保存されているか調べる
//   ・保存済みなら、もう一度ダウンロードしない（取得前にここで確かめる）
//   ・いつでも、1つずつ端末から消せる
// 保存先はブラウザの Cache Storage。実行用の本体は 'ai-safari-lib-1'、モデルの重みは Transformers.js が 'ai-safari-transformers-cache' に置く。
// 本体は意味検索と回答で共有する（同じものを2つは持たない）。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const LIB_CACHE = 'ai-safari-lib-1';
  const MODEL_CACHE = 'ai-safari-transformers-cache';

  const cachesOf = (impl) => impl || root.caches || null;

  // モデルに属するファイルか（例: https://huggingface.co/Xenova/xxx/resolve/main/onnx/model.onnx）
  const belongsTo = (url, model) => url.includes(`/${model}/`);

  async function sizeOf(cache, request) {
    const res = await cache.match(request);
    if (!res) return 0;
    const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (len > 0) return len;
    try {
      return (await res.blob()).size;
    } catch (_) {
      return 0;
    }
  }

  // モデル1つ分の保存状況。cached = 重み（.onnx）まで揃っている
  async function inspectModel(model, cachesImpl) {
    const c = cachesOf(cachesImpl);
    const out = { cached: false, bytes: 0, files: 0 };
    if (!c) return out;
    if (!(await c.has(MODEL_CACHE))) return out;
    const cache = await c.open(MODEL_CACHE);
    const keys = await cache.keys();
    for (const request of keys) {
      if (!belongsTo(request.url, model)) continue;
      out.files++;
      out.bytes += await sizeOf(cache, request);
      if (/\.onnx(_data)?(\?|$)/.test(request.url)) out.cached = true;
    }
    return out;
  }

  async function inspectLibrary(cachesImpl) {
    const c = cachesOf(cachesImpl);
    const out = { cached: false, bytes: 0, files: 0 };
    if (!c) return out;
    if (!(await c.has(LIB_CACHE))) return out;
    const cache = await c.open(LIB_CACHE);
    const keys = await cache.keys();
    for (const request of keys) {
      out.files++;
      out.bytes += await sizeOf(cache, request);
    }
    out.cached = out.files > 0;
    return out;
  }

  // そのモデルのファイルだけを消す（他のモデルと本体には触らない）。消した件数を返す
  async function removeModel(model, cachesImpl) {
    const c = cachesOf(cachesImpl);
    if (!c || !(await c.has(MODEL_CACHE))) return 0;
    const cache = await c.open(MODEL_CACHE);
    let n = 0;
    for (const request of await cache.keys()) {
      if (belongsTo(request.url, model) && (await cache.delete(request))) n++;
    }
    return n;
  }

  async function removeLibrary(cachesImpl) {
    const c = cachesOf(cachesImpl);
    if (!c) return false;
    return c.delete(LIB_CACHE);
  }

  // 保存領域の使用量と上限の目安
  async function estimate() {
    try {
      const e = await root.navigator.storage.estimate();
      return e && e.quota ? { usage: e.usage || 0, quota: e.quota } : null;
    } catch (_) {
      return null;
    }
  }

  // ブラウザに「消さないで」と頼む（容量が足りなくなったときに勝手に消されて、取り直しになるのを避ける）
  async function persist() {
    try {
      if (root.navigator.storage && root.navigator.storage.persist) return await root.navigator.storage.persist();
    } catch (_) {
      /* 断られても使える */
    }
    return false;
  }

  // 同じ名前の処理が動いている間は、それを待つ（ボタンの連打などで、同じ取得を二重に始めない）
  const running = new Map();
  function once(key, fn) {
    if (running.has(key)) return running.get(key);
    const p = Promise.resolve()
      .then(fn)
      .finally(() => running.delete(key));
    running.set(key, p);
    return p;
  }

  const formatSize = (n) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)}GB` : `${Math.max(1, Math.round(n / 1024 / 1024))}MB`);

  AI.store = { LIB_CACHE, MODEL_CACHE, belongsTo, inspectModel, inspectLibrary, removeModel, removeLibrary, estimate, persist, once, formatSize };
})(typeof globalThis !== 'undefined' ? globalThis : window);
