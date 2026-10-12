// 文章を「意味のベクトル」に変える部品（プロバイダ）。
//
// プロバイダの形（これを満たせば差し替えられる。テストでは疑似プロバイダを使う）:
//   id       モデルの識別子（ベクトルに記録する。変わったら作り直す）
//   version  同じモデルでの設定の版（前処理を変えたら上げる）
//   dim      ベクトルの次元
//   ready    準備できているか
//   prepare(onProgress)       モデルを読み込む。onProgress({ label, loaded, total })
//   embed(texts, kind)        kind: 'query' | 'passage'。戻り値: 長さ dim に正規化した Float32Array の配列
//
// 実モデルは Transformers.js で、ブラウザ内で動かす。通信が起きるのは prepare のときだけ。
//   ・Transformers.js 本体：jsDelivr からバージョンを固定して取得し、SHA-256 が一致したものだけ使う。端末に保存する
//   ・モデルの重み：Hugging Face から取得し、ブラウザのキャッシュに保存される
//   ・実行用の wasm：jsDelivr から取得し、ブラウザのキャッシュに保存される
// 一度取得すれば、オフライン（機内モード）でも動く。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  // 選べるモデルパック。容量は目安（量子化版）。
  const PACKS = [
    {
      id: 'e5-small',
      label: '標準（多言語 e5-small）',
      model: 'Xenova/multilingual-e5-small',
      dtype: 'q8',
      dim: 384,
      approxMB: 120,
      version: 1,
      hosts: ['huggingface.co（モデル）', 'cdn.jsdelivr.net（実行用ファイル）'],
    },
  ];

  // Transformers.js 本体。版を固定し、中身のハッシュを確かめてから使う（CDN側が差し替えられても動かさない）。
  // 版を上げるときは、url と sha256 を同時に更新する（sha256 は `sha256sum` で、npm の dist/transformers.min.js から求める）。
  const LIB = {
    url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js',
    sha256: '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743',
  };
  const LIB_CACHE = 'ai-safari-lib-1'; // AI.store.LIB_CACHE と同じ名前
  let libPromise = null;

  async function sha256Hex(buffer) {
    const digest = await root.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 本体を端末の保存領域から読む。無ければ取得して、ハッシュを確かめてから保存する。
  async function loadLibrary() {
    if (!libPromise) {
      libPromise = (async () => {
        const cache = await root.caches.open(LIB_CACHE);
        let buffer = null;
        const hit = await cache.match(LIB.url);
        if (hit) {
          buffer = await hit.arrayBuffer();
          if ((await sha256Hex(buffer)) !== LIB.sha256) buffer = null; // 壊れていたら取り直す
        }
        if (!buffer) {
          if (AI.net.isOffline() || (root.navigator && root.navigator.onLine === false)) {
            throw new Error('意味検索の実行ファイルがこの端末にありません。オンラインで「意味検索を有効にする」を行ってください。');
          }
          const response = await AI.net.fetch(LIB.url);
          if (!response.ok) throw new Error(`実行ファイルを取得できませんでした（${response.status}）。`);
          buffer = await response.arrayBuffer();
          if ((await sha256Hex(buffer)) !== LIB.sha256) {
            throw new Error('取得した実行ファイルが想定と違うため、使いません（改ざん防止のため）。');
          }
          await cache.put(LIB.url, new Response(buffer, { headers: { 'content-type': 'text/javascript' } }));
        }
        const blobUrl = URL.createObjectURL(new Blob([buffer], { type: 'text/javascript' }));
        return import(blobUrl); // 実行中に使うので、blobUrl は解放しない
      })().catch((error) => {
        libPromise = null; // 次は取り直せるように
        throw error;
      });
    }
    return libPromise;
  }

  function normalize(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    const norm = Math.sqrt(sum) || 1;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
    return out;
  }

  // モデルを読み込んでパイプラインを作る（意味検索と回答で共通）。
  // すでに端末にあるファイルは取り直さない（Transformers.js が保存先を先に見る）。featureName はエラー文用
  let defaultFetch = null;
  async function createPipeline(task, pack, onProgress, featureName) {
    const lib = await loadLibrary();
    // オフラインモード中は、外には取りに行かない（端末に保存済みのモデルだけを使う）
    // 注意：allowRemoteModels を false にすると、Transformers.js は端末の保存分すら見ずにエラーにする
    // （「local も remote も無効」と判定される）。なので常に true にし、オフラインモード中は
    // 通信そのもの（env.fetch）を止める。保存分は通信より先に見られるので、端末にあれば読める。
    lib.env.cacheKey = AI.store.MODEL_CACHE; // 元のaiのモデル/WASMキャッシュには触れない
    lib.env.experimental_useCrossOriginStorage = false;
    lib.env.allowLocalModels = false;
    lib.env.allowRemoteModels = true;
    lib.env.backends.onnx.wasm.numThreads = 1;
    if (!defaultFetch) defaultFetch = lib.env.fetch;
    lib.env.fetch = AI.net.isOffline()
      ? async (url) => {
          throw new Error(`オフラインモードなので取得しません（${String(url).split('/').pop()}）`);
        }
      : defaultFetch;
    const progress = (info) => {
      if (!onProgress || !info) return;
      if (info.status === 'progress' && info.total) {
        onProgress({ label: info.file || 'model', loaded: info.loaded || 0, total: info.total });
      } else if (info.status === 'ready') {
        onProgress({ label: 'ready', loaded: 1, total: 1 });
      }
    };
    try {
      return await lib.pipeline(task, pack.model, { dtype: pack.dtype, device: pack.device || 'wasm', progress_callback: progress });
    } catch (error) {
      if (AI.net.isOffline()) {
        throw new Error(`モデルの一部がこの端末にありません。オンラインモードで「${featureName}を有効にする」を行ってください。\n（${error && error.message ? error.message : error}）`);
      }
      throw new Error(`モデルを読み込めませんでした。${error && error.message ? error.message : error}`);
    }
  }

  // Transformers.js を使う実プロバイダ
  function transformersProvider(pack) {
    let extractor = null;
    const provider = {
      id: `${pack.model}@${pack.dtype}`,
      version: pack.version,
      dim: pack.dim,
      pack,
      get ready() {
        return extractor !== null;
      },
      async prepare(onProgress) {
        if (extractor) return;
        extractor = await createPipeline('feature-extraction', pack, onProgress, '意味検索');
      },
      // メモリから外す（ファイルは端末に残る。次に使うときは、保存済みから読み直す）
      async unload() {
        const e = extractor;
        if (e && e.dispose) {
          await e.dispose();
        }
        extractor = null;
      },
      async embed(texts, kind) {
        if (!extractor) throw new Error('モデルの準備ができていません');
        const prefix = kind === 'query' ? 'query: ' : 'passage: '; // e5 の決まり
        const out = [];
        // 一度に入れすぎるとメモリを使うので、少しずつ
        for (let i = 0; i < texts.length; i += 8) {
          const batch = texts.slice(i, i + 8).map((t) => prefix + t);
          const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
          const rows = tensor.tolist();
          for (const row of rows) out.push(normalize(Float32Array.from(row)));
        }
        return out;
      },
    };
    return provider;
  }

  // reset はテスト用（読み込み済みの状態を捨てる）
  AI.embed = { PACKS, LIB, LIB_CACHE, normalize, loadLibrary, createPipeline, transformersProvider, reset: () => (libPromise = null) };
})(typeof globalThis !== 'undefined' ? globalThis : window);
