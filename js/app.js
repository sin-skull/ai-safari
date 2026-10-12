// 画面の動き。会話（覚える・聞く・調べる）と、左の記憶パネル。
// 文字は必ず textContent で入れる（保存した内容をHTMLとして解釈しない）。
(function () {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const memoryOnly = document.body.dataset.memoryOnly === 'true';

  // 読み込まれたスクリプトの版（index.html の ?v= と同じ。sw.js の VERSION とも揃えてある）。画面に出して、更新されたか確かめられるようにする
  const VERSION = (() => {
    try {
      return new URL(document.currentScript.src).searchParams.get('v') || '不明';
    } catch (_) {
      return '不明';
    }
  })();

  // 古いファイルが混ざっていないか（キャッシュのずれ）。足りない部品があれば理由を出して止める
  const REQUIRED = ['#app', '#thread', '#messages', '#composer', '#input', '#send', '#drawer',
    '#scrim', '#menu', '#close', '#reset', '#search', '#count', '#terms', '#empty', '#tab-terms', '#tab-passages',
    '#tab-queue', '#semantic', '#semantic-btn', '#semantic-sync', '#mode', '#tab-tidy', '#w-score', '#w-importance', '#w-fresh', '#w-reset', '#llm', '#llm-btn', '#persona', '#persona-custom', '#tone', '#dl-list', '#storage', '#backup-info', '#export', '#import', '#import-file'];
  const missing = REQUIRED.filter((s) => !$(s));
  if (missing.length) {
    window.__showFatal &&
      window.__showFatal('ページの一部が古いままのようです。再読み込みしてください。', `見つからない部品: ${missing.join(' ')}`);
    return;
  }

  const WIKI_LICENSE = 'CC BY-SA 4.0'; // Wikipedia の本文のライセンス。保存するときに出典と一緒に残す

  const el = {
    thread: $('#thread'),
    messages: $('#messages'),
    hello: $('#hello'),
    form: $('#composer'),
    input: $('#input'),
    send: $('#send'),
    drawer: $('#drawer'),
    scrim: $('#scrim'),
    menu: $('#menu'),
    close: $('#close'),
    reset: $('#reset'),
    search: $('#search'),
    count: $('#count'),
    list: $('#terms'),
    empty: $('#empty'),
    tabTerms: $('#tab-terms'),
    tabPassages: $('#tab-passages'),
    tabQueue: $('#tab-queue'),
    tabTidy: $('#tab-tidy'),
    wScore: $('#w-score'),
    wImportance: $('#w-importance'),
    wFresh: $('#w-fresh'),
    wReset: $('#w-reset'),
    mode: $('#mode'),
    auto: $('#auto'),
    semantic: $('#semantic'),
    semBtn: $('#semantic-btn'),
    semSync: $('#semantic-sync'),
    llm: $('#llm'),
    llmBtn: $('#llm-btn'),
    llmPack: $('#llm-pack'),
    llmNote: $('#llm-note'),
    llmChoice: $('#llm-choice'),
    load: $('#llm-load'),
    wipeBtn: $('#wipe'),
    resetBtn: $('#reset-all'),
    tone: $('#tone'),
    persona: $('#persona'),
    personaCustom: $('#persona-custom'),
    dlList: $('#dl-list'),
    storage: $('#storage'),
    backupInfo: $('#backup-info'),
    exportBtn: $('#export'),
    importBtn: $('#import'),
    importFile: $('#import-file'),
  };

  // 版の表示と、最新版の確認
  const verEl = $('#version');
  if (verEl) verEl.textContent = `バージョン ${VERSION}`;
  const helloVer = $('#hello-ver');
  if (helloVer) helloVer.textContent = `v${VERSION}`;
  const updateBtn = $('#update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      if (navigator.onLine === false || (window.AI && AI.net && AI.net.isOffline())) {
        if (verEl) verEl.textContent = `バージョン ${VERSION}\nオフライン中は、最新版を確認できません。`;
        return;
      }
      updateBtn.disabled = true;
      updateBtn.textContent = '確認しています…';
      try {
        const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
        if (reg) await reg.update();
      } catch (_) {
        /* 確認できなくても、再読み込みはする */
      }
      location.reload(); // 画面はネットから最新を取る（取れなければ、保存済みの版で開く）
    });
  }

  // 古いブラウザ（matchMedia の addEventListener が無い）でも落ちないようにする
  function onChange(query, handler) {
    if (query.addEventListener) query.addEventListener('change', handler);
    else if (query.addListener) query.addListener(handler);
  }

  function scrollDown() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // ---- 画面の高さ（iPhoneのキーボードで入力欄が隠れないように）----
  const vv = window.visualViewport;
  function fitHeight() {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    if (vv) window.scrollTo(0, 0);
    scrollDown();
  }
  if (vv) vv.addEventListener('resize', fitHeight);
  window.addEventListener('resize', fitHeight);
  fitHeight();

  // ---- 記憶パネル ----
  const wide = window.matchMedia('(min-width: 900px)');
  function setDrawer(open) {
    const overlay = open && !wide.matches;
    el.drawer.classList.toggle('open', overlay);
    el.scrim.classList.toggle('show', overlay);
    el.menu.setAttribute('aria-expanded', String(overlay));
    el.drawer.inert = !(wide.matches || open);
    if (overlay) el.close.focus();
  }

  // iOSはピンチ拡大を viewport で止められないので、ジェスチャーそのものを止める
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault());

  // 横にスワイプして、記憶パネルを開け閉めする（右へ：開く／左へ：閉じる）。縦スクロールや入力中は反応しない
  {
    let start = null;
    document.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      const blocked = e.touches.length !== 1 || wide.matches || (e.target.closest && e.target.closest('input, textarea, select, svg, pre, [data-noswipe]'));
      start = blocked ? null : { x: t.clientX, y: t.clientY, at: Date.now() };
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const quick = Date.now() - start.at < 700;
      start = null;
      if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const open = el.drawer.classList.contains('open');
      if (dx > 0 && !open) setDrawer(true);
      else if (dx < 0 && open) setDrawer(false);
    }, { passive: true });
  }
  onChange(wide, () => setDrawer(false));
  el.menu.addEventListener('click', () => setDrawer(true));
  el.close.addEventListener('click', () => {
    setDrawer(false);
    el.menu.focus();
  });
  el.scrim.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.drawer.classList.contains('open')) {
      setDrawer(false);
      el.menu.focus();
    }
  });
  setDrawer(false);

  // ---- 会話 ----
  // role: 'user' | 'ai'。opts: { title, sub, actions: [{ label, main, run }] }
  function addMessage(role, text, opts = {}) {
    if (el.hello && !opts.keepHello) {
      el.hello.remove();
      el.hello = null;
    }
    const msg = document.createElement('div');
    msg.className = `msg ${role}`;
    const body = document.createElement('div');
    body.className = 'body';

    if (opts.title) {
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = opts.title;
      body.appendChild(title);
    }
    if (text) body.appendChild(document.createTextNode(text));
    if (opts.sub) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = opts.sub;
      body.appendChild(sub);
    }
    msg.appendChild(body);

    if (opts.actions && opts.actions.length) {
      const row = document.createElement('div');
      row.className = 'actions';
      const buttons = [];
      for (const action of opts.actions) {
        const b = document.createElement('button');
        b.type = 'button';
        if (action.main) b.className = 'main';
        b.textContent = action.label;
        b.addEventListener('click', async () => {
          // 1回選んだら、この問いのボタンは全部使えなくする
          buttons.forEach((x) => (x.disabled = true));
          try {
            await action.run();
          } catch (error) {
            addMessage('ai', `うまくいきませんでした。\n${error.message}`);
          }
        });
        buttons.push(b);
        row.appendChild(b);
      }
      body.appendChild(row);
    }

    if (opts.rate) body.appendChild(rateRow(opts.rate));

    el.messages.appendChild(msg);
    scrollDown();
    return msg;
  }

  // 👍/👎。rate: { type: 'term' | 'passage', id }
  function rateRow(rate) {
    const row = document.createElement('div');
    row.className = 'rate';
    const buttons = [
      { value: 1, text: '👍', label: '役に立った' },
      { value: -1, text: '👎', label: '違う・いらない' },
    ].map((def) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = def.text;
      b.setAttribute('aria-label', def.label);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', async () => {
        try {
          const r = await AI.feedback.rate(db, rate.type, rate.id, def.value);
          buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(r.value === [1, -1][i])));
          await render();
        } catch (error) {
          addMessage('ai', `評価を記録できませんでした。\n${error.message}`);
        }
      });
      return b;
    });
    row.append(...buttons);
    return row;
  }

  // ---- 記憶（DB）。開けなくても、入力欄とボタンは反応するようにしておく ----
  let db = null;
  const dbReady = AI.db
    .open()
    .then(async (opened) => {
      db = opened;
      await AI.net.load(db); // 前回のモードを引き継ぐ
      await loadSemantic(); // 意味検索の設定を引き継ぐ
      await loadAnswer(); // 回答モデルの設定を引き継ぐ
      const autoRow = await getSetting(AUTO_KEY);
      autoSearch = !!(autoRow && autoRow.value);
      renderAuto();
      weights = await AI.growth.loadWeights(db); // 並び順の重み
      renderWeights();
      await render();
      await renderFoot(true);
      startWarmUp(); // 意味検索と回答モデルを、起動時に自動で読み込む（待たない）
    })
    .catch((error) => {
      addMessage('ai', `記憶を開けませんでした。\n${error.message}\nプライベートブラウズでは使えないことがあります。`);
    });

  function formatDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  // learn: { term, definition, source? }
  async function save(learn, policy) {
    let result;
    try {
      result = await AI.terms.add(db, learn.term, learn.definition, {
        onConflict: policy,
        source: learn.source,
      });
    } catch (error) {
      addMessage('ai', error.message);
      return;
    }

    if (result.status === 'conflict') {
      addMessage('ai', '', {
        title: `「${result.existing.term}」はもう覚えています`,
        sub: `いま：${result.existing.definition}\n新しい：${result.incoming.definition}`,
        actions: [
          { label: '上書きする', main: true, run: () => save(learn, 'overwrite') },
          { label: '追記する', run: () => save(learn, 'append') },
          { label: '今のまま', run: () => save(learn, 'ignore') },
        ],
      });
      return;
    }

    const term = result.record.term;
    if (policy !== 'ignore') await AI.queue.resolve(db, learn.term); // 覚えたので、未回答からは外す
    if (policy === 'ignore') addMessage('ai', `「${term}」は今のまま残しました。`);
    else if (result.status === 'created') addMessage('ai', `「${term}」を覚えました。`);
    else if (result.status === 'updated') addMessage('ai', `「${term}」を更新しました。`);
    else addMessage('ai', `「${term}」はすでに同じ内容で覚えています。`);
    await render();
  }

  // 文章として保存する（確認のあとに呼ぶ）
  async function savePassage(text, extra = {}) {
    const p = await AI.passages.add(db, text, extra);
    for (const term of extra.terms || []) await AI.queue.resolve(db, term);
    addMessage('ai', `文章として保存しました。\n「${p.title}」`, {
      sub: '「文章」タブで見たり消したりできます。聞くと、この中からも探します。',
    });
    await render();
    indexInBackground(p); // 意味検索がオンなら、ベクトルも作る（待たない）
  }

  // ---- Wikipedia（ここだけが外部に通信する。ボタンを押したときだけ）----
  // ctx: まとめて調べるときだけ { item, done }。決めたら done() で次の語へ進む
  function showCandidate(query, list, index, ctx) {
    const c = list[index];
    const learn = {
      term: query,
      definition: c.extract,
      source: { url: c.url, title: `Wikipedia「${c.title}」`, license: WIKI_LICENSE },
    };
    const finish = () => ctx && ctx.done();
    const actions = [
      {
        label: '単語と文章で覚える',
        main: true,
        run: async () => {
          await save(learn, 'ask');
          await savePassage(c.extract, { title: c.title, sourceUrl: c.url, license: WIKI_LICENSE, terms: [query] });
          finish();
        },
      },
      {
        label: '単語だけ覚える',
        run: async () => {
          await save(learn, 'ask');
          finish();
        },
      },
    ];
    // 他の候補は、題名を見て直接選べるようにする（順番に送らなくてよい）
    list.forEach((other, i) => {
      if (i === index) return;
      actions.push({ label: `候補: ${other.title}`, run: async () => showCandidate(query, list, i, ctx) });
    });
    actions.push({
      label: '別の言葉で調べる',
      run: async () => {
        el.input.value = query;
        fitInput();
        el.input.focus();
        addMessage('ai', '入力欄に言葉を入れました。直して送ってください。知らない語なら、もう一度Wikipediaで調べるボタンが出ます。');
      },
    });
    if (ctx) {
      actions.push({
        label: 'あとで',
        run: async () => {
          addMessage('ai', `「${query}」は調べ待ちのままにします。`);
          finish();
        },
      });
      actions.push({
        label: 'いらない',
        run: async () => {
          await AI.queue.setStatus(db, ctx.item.id, 'dismissed');
          addMessage('ai', `「${query}」は未回答から外しました。`);
          await render();
          finish();
        },
      });
    } else {
      actions.push({ label: 'やめる', run: async () => addMessage('ai', '覚えませんでした。') });
    }
    addMessage('ai', c.extract, {
      title: c.title,
      sub: `Wikipedia（候補 ${index + 1}/${list.length}）\n${c.url}\n${WIKI_LICENSE}・保存すると出典と一緒に残します`,
      actions,
    });
  }

  async function searchWikipedia(query) {
    if (AI.net.isOffline()) {
      addMessage('ai', 'いまはオフラインモードです。右上の「オフライン」を押してオンラインに戻すと、Wikipediaで調べられます。');
      return;
    }
    if (navigator.onLine === false) {
      addMessage('ai', 'いまオフラインなので、調べられません。');
      return;
    }
    const term = AI.wiki.searchTerm(query);
    addMessage('ai', term === query ? `Wikipediaで「${query}」を調べています…` : `Wikipediaで「${term}」を調べています…`, {
      sub: term === query ? '' : '文のままだと的外れな記事が出やすいので、言葉だけ取り出して送っています。',
    });
    let list;
    try {
      list = await AI.wiki.search(query);
    } catch (error) {
      addMessage('ai', `Wikipediaに繋がりませんでした。\n${error.message}`);
      return;
    }
    if (!list.length) {
      addMessage('ai', `Wikipediaにも「${query}」は見つかりませんでした。\n「${query} = 意味」の形で教えてください。`);
      return;
    }
    showCandidate(query, list, 0);
  }

  // ---- 未回答をまとめて調べる ----
  async function researchQueue() {
    if (AI.net.isOffline() || navigator.onLine === false) {
      addMessage('ai', 'いまはオフラインなので調べられません。オンラインに戻してから、もう一度どうぞ。');
      return;
    }
    const items = await AI.queue.list(db);
    if (!items.length) {
      addMessage('ai', '未回答の質問はありません。');
      return;
    }
    addMessage('ai', `次の ${items.length} 件の語をWikipediaに送って調べます。\n${items.map((i) => `・${i.query}`).join('\n')}`, {
      sub: '調べた結果は自動では保存しません。候補を見て、残すものを選べます。',
      actions: [
        { label: '送って調べる', main: true, run: () => runResearch(items) },
        { label: 'やめる', run: async () => addMessage('ai', '調べませんでした。') },
      ],
    });
  }

  async function runResearch(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      addMessage('ai', `(${i + 1}/${items.length}) 「${item.query}」を調べています…`);
      let list;
      try {
        list = await AI.wiki.search(item.query);
      } catch (error) {
        addMessage('ai', `Wikipediaに繋がりませんでした。\n${error.message}\n残りは調べ待ちのままです。`);
        return;
      }
      if (!list.length) {
        addMessage('ai', `「${item.query}」は見つかりませんでした。調べ待ちのままにします。`);
        continue;
      }
      await new Promise((resolve) => showCandidate(item.query, list, 0, { item, done: resolve }));
    }
    addMessage('ai', 'まとめて調べ終わりました。');
    await render();
  }

  // オンラインのとき、溜まっている未回答を知らせる
  async function notifyPending() {
    if (!db || AI.net.isOffline() || navigator.onLine === false) return;
    const n = await AI.queue.count(db);
    if (!n) return;
    addMessage('ai', `答えられなかった質問が ${n} 件あります。`, {
      keepHello: true, // 最初の画面の案内は消さない
      actions: [
        { label: 'まとめて調べる', main: true, run: researchQueue },
        { label: 'あとで', run: async () => {} },
      ],
    });
  }
  AI.net.onChange((off) => {
    if (!off) notifyPending().catch(() => {});
  });
  window.addEventListener('online', () => notifyPending().catch(() => {}));

  // ---- 意味検索（言い換えでも見つける。モデルはブラウザの中で動かす）----
  const SEMANTIC_KEY = 'semantic';
  // これ未満の近さは「関係ない」として捨てる。e5-small の評価セット（docs/EVAL.md）で、正解が1位のときの最小 0.843、
  // 関係ない質問の最大 0.831 だった間に置いた。差は小さい（0.012）ので、文章が増えたら測り直す。
  const SEMANTIC_MIN = 0.84;
  let semantic = { enabled: false, pack: AI.embed.PACKS[0].id };
  let provider = null;
  let preparing = null; // 読み込み中のPromise（二重に読み込まない）
  let semanticWarned = false;

  const packOf = (id) => AI.embed.PACKS.find((p) => p.id === id) || AI.embed.PACKS[0];
  const getSetting = (name) => AI.db.tx(db, 'settings', 'readonly', (t) => AI.db.rq(t.objectStore('settings').get(name)));
  const putSetting = (name, value) =>
    AI.db.tx(db, 'settings', 'readwrite', (t) => AI.db.rq(t.objectStore('settings').put({ name, value })));

  async function loadSemantic() {
    if (memoryOnly) return;
    const row = await getSetting(SEMANTIC_KEY);
    if (row && row.value && row.value.enabled) {
      semantic = row.value;
      provider = AI.embed.transformersProvider(packOf(semantic.pack));
    }
  }

  // 書き換えられる進捗メッセージ
  function progressMessage(text) {
    const msg = addMessage('ai', text);
    const body = msg.querySelector('.body');
    return {
      set(t) {
        body.childNodes[0].nodeValue = t;
      },
      remove() {
        msg.remove();
      },
    };
  }

  const megabytes = (n) => `${(n / 1024 / 1024).toFixed(0)}MB`;
  function downloadProgress(pm) {
    const files = new Map();
    return (info) => {
      files.set(info.label, info);
      let loaded = 0;
      let total = 0;
      files.forEach((f) => {
        loaded += f.loaded;
        total += f.total;
      });
      if (total) pm.set(`モデルをダウンロードしています… ${Math.min(100, Math.round((loaded / total) * 100))}%（${megabytes(loaded)} / ${megabytes(total)}）`);
    };
  }

  async function ensureReady(onProgress) {
    if (!provider) return false;
    if (provider.ready) return true;
    if (!preparing) preparing = provider.prepare(onProgress).finally(() => (preparing = null));
    await preparing;
    return provider.ready;
  }

  // 保存した文章を探す。意味検索がオンならキーワードと合わせる。使えないときはキーワードだけ
  async function searchPassages(query, limit = 5) {
    // 検索で「関係あり」と判定された結果を、評価・ピン・新しさで並べ替える（関係ない文章は上がってこない）
    return AI.growth.rerank(await searchRaw(query, limit), weights);
  }

  async function searchRaw(query, limit) {
    if (!(semantic.enabled && provider)) return AI.passages.search(db, query, { limit });
    let note = null;
    try {
      if (!provider.ready) note = progressMessage('意味検索の準備をしています…');
      await ensureReady();
    } catch (error) {
      if (!semanticWarned) {
        semanticWarned = true;
        addMessage('ai', `${error.message}\nキーワード検索だけで探します。`);
      }
    }
    if (note) note.remove();
    const found = await AI.hybrid.search(db, query, { provider: provider.ready ? provider : null, limit, minSemantic: SEMANTIC_MIN });
    return found;
  }

  // 文章を1件保存したあと、その分のベクトルを作る（失敗しても保存は有効。あとで「未作成を作る」で補える）
  let embedding = 0; // ベクトルを作っている最中の数（その間は、意味検索のモデルを外さない）
  async function indexInBackground(passage) {
    if (!(semantic.enabled && provider)) return;
    embedding++;
    try {
      await ensureReady();
      await AI.vectors.indexPassage(db, passage, provider);
      await renderSemantic();
    } catch (_) {
      await renderSemantic().catch(() => {});
    } finally {
      embedding--;
    }
  }

  async function renderSemantic() {
    if (!db) return;
    if (!semantic.enabled) {
      const pack = packOf(semantic.pack);
      el.semantic.textContent = `意味検索：オフ\n言い換えでも探せるようになります（約${pack.approxMB}MB・Wi-Fi推奨）`;
      el.semBtn.textContent = '有効にする';
      el.semSync.hidden = true;
      return;
    }
    const st = await AI.vectors.status(db, provider);
    el.semantic.textContent = `意味検索：オン（${packOf(semantic.pack).label}）\n作成済み ${st.indexed}/${st.total} 件${st.stale ? `（未作成 ${st.stale} 件）` : ''}`;
    el.semBtn.textContent = 'オフにする';
    el.semSync.hidden = st.stale === 0;
  }

  // 端末にすでにあるものを確かめる（あれば、ダウンロードしない）
  async function savedState(pack) {
    const [lib, model] = await Promise.all([AI.store.inspectLibrary(), AI.store.inspectModel(pack.model)]);
    return { lib, model, complete: lib.cached && model.cached };
  }

  // 有効にする前の確認。保存済みなら通信なしで進める。足りないぶんだけ、容量と通信先を見せる
  async function confirmEnable({ name, pack, run, extra }) {
    setDrawer(false);
    const st = await savedState(pack);
    if (st.complete) {
      addMessage('ai', `${name}を有効にします。\nモデル「${pack.label}」は端末に保存済みなので、ダウンロードしません（通信なし）。`, {
        sub: extra,
        actions: [
          { label: '有効にする', main: true, run: () => run(pack) },
          { label: 'やめる', run: async () => addMessage('ai', '有効にしませんでした。') },
        ],
      });
      return;
    }
    if (AI.net.isOffline() || navigator.onLine === false) {
      addMessage('ai', 'モデルのダウンロードにはネットが要ります。オンラインにしてから、もう一度どうぞ。');
      return;
    }
    let free = '';
    const est = await AI.store.estimate();
    if (est) free = `\n端末の保存領域の目安：あと ${megabytes(Math.max(0, est.quota - est.usage))}`;
    const have = [];
    if (st.lib.cached) have.push('実行用ファイル');
    if (st.model.files) have.push(`モデルの一部（${AI.store.formatSize(st.model.bytes)}）`);
    const left = Math.max(1, pack.approxMB - Math.round(st.model.bytes / 1024 / 1024));
    addMessage('ai', `${name}を有効にします。\nモデル「${pack.label}」を、約${left}MBダウンロードします。${have.length ? `\n保存済みの${have.join('と')}は取り直しません。` : ''}${free}`, {
      sub: `通信先：${pack.hosts.join('、')}\n送るのはモデルの取得だけで、記憶や質問は送りません。取得後は端末に保存され、オフラインでも使えます。いつでもメニューの「端末に保存したもの」から消せます。`,
      actions: [
        { label: 'ダウンロードして有効にする', main: true, run: () => run(pack) },
        { label: 'やめる', run: async () => addMessage('ai', '有効にしませんでした。') },
      ],
    });
  }

  const enableSemantic = () => confirmEnable({ name: '意味検索', pack: packOf(semantic.pack), run: runEnable });

  function runEnable(pack) {
    // 同じモデルの取得を二重に始めない
    return AI.store.once(`enable:${pack.model}`, () => doEnable(pack));
  }

  async function doEnable(pack) {
    const pm = progressMessage('準備しています…');
    const candidate = AI.embed.transformersProvider(pack);
    try {
      await candidate.prepare(downloadProgress(pm));
      pm.set('動作を確かめています…');
      await candidate.embed(['動作確認'], 'query'); // 実際に1回動かして、使えることを確かめる
    } catch (error) {
      pm.remove();
      addMessage('ai', `意味検索を有効にできませんでした。\n${error.message}`);
      await renderFoot(false);
      return;
    }
    AI.store.persist(); // ブラウザに「消さないで」と頼む（取り直しを避ける）
    provider = candidate;
    semantic = { enabled: true, pack: pack.id };
    semanticWarned = false;
    await putSetting(SEMANTIC_KEY, semantic);
    const n = await AI.vectors.reindex(db, provider, {
      onProgress: ({ done, total }) => pm.set(`文章のベクトルを作っています… ${done}/${total}`),
    });
    pm.remove();
    addMessage('ai', `意味検索が使えるようになりました。保存済みの文章 ${n} 件を処理しました。`, {
      sub: '言い換えた質問でも、近い内容の文章を探します。',
    });
    await renderFoot(false);
  }

  // 意味検索をオフにする。wipe なら、ベクトルとモデルも端末から消す（実行用ファイルは「端末に保存したもの」から別に消せる）
  async function turnOffSemantic(wipe) {
    const pack = packOf(semantic.pack);
    semantic = { ...semantic, enabled: false };
    await putSetting(SEMANTIC_KEY, semantic);
    if (wipe) {
      await AI.vectors.removeAll(db);
      try {
        await AI.store.removeModel(pack.model);
      } catch (_) {
        /* 消せなくても無効にはなっている */
      }
    }
    provider = null;
    await renderFoot(false);
    return wipe;
  }

  function disableSemantic() {
    setDrawer(false);
    const off = async (wipe) => {
      await turnOffSemantic(wipe);
      addMessage('ai', wipe ? '意味検索をオフにして、ベクトルとモデルを端末から消しました。' : '意味検索をオフにしました。ベクトルとモデルは残してあります（もう一度有効にするときは、ダウンロードしません）。');
    };
    addMessage('ai', '意味検索をオフにしますか？', {
      sub: '消しても、保存した単語や文章は残ります。',
      actions: [
        { label: 'オフにする（残す）', main: true, run: () => off(false) },
        { label: 'オフにして端末から消す', run: () => off(true) },
        { label: 'やめる', run: async () => {} },
      ],
    });
  }

  async function runSync() {
    setDrawer(false);
    if (!(semantic.enabled && provider)) return;
    const pm = progressMessage('ベクトルを作っています…');
    try {
      await ensureReady(downloadProgress(pm));
      const n = await AI.vectors.reindex(db, provider, {
        onProgress: ({ done, total }) => pm.set(`ベクトルを作っています… ${done}/${total}`),
      });
      pm.remove();
      addMessage('ai', `${n} 件のベクトルを作りました。`);
    } catch (error) {
      pm.remove();
      addMessage('ai', `ベクトルを作れませんでした。\n${error.message}`);
    }
    await renderSemantic();
  }

  // ---- 起動時の自動準備 ----
  // 有効にしてあるものを、起動したら自動で読み込む（オフラインでも、端末にあるものだけで）。
  // メモリの山を作らないよう、1つずつ：意味検索 → 足りないベクトルを作る → 意味検索を外す → 回答モデル。
  // 起動時の読み込みで落ちると、次の起動でまた読み込んで、また落ちる（繰り返す）。
  // それを防ぐため、読み込む前に目印を残し、前回の目印が残っていたら、今回は自動で読み込まない。
  const WARM_KEY = 'warmup-try';
  async function startWarmUp() {
    const row = await getSetting(WARM_KEY);
    if (row && row.value && !closedNormallyAfter(row.value.at)) {
      await putSetting(WARM_KEY, null);
      if (answerCrashed) return; // 回答モデルの案内をもう出している
      addMessage('ai', `前回、起動時の自動読み込み（${row.value.stage}）の途中でアプリが落ちたようです。今回は自動で読み込みません。`, {
        sub: '保存した文章の検索と、文章の抜き出しは使えます。読み込みは、下のボタンからいつでもできます。',
        actions: [{ label: '今すぐ読み込む', main: true, run: () => warmUp() }],
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 1500)); // 画面の表示と更新の確認を先に済ませる
    await warmUp();
  }

  async function warmUp() {
    const wantSemantic = semantic.enabled && provider;
    const wantAnswer = answerCfg.enabled && generator;
    if (!wantSemantic && !wantAnswer) return;
    const mark = (stage) => putSetting(WARM_KEY, { at: Date.now(), stage });
    const pm = progressMessage('起動の準備をしています…');
    const problems = [];
    if (wantSemantic) {
      try {
        await mark('意味検索の読み込み');
        pm.set('意味検索を読み込んでいます…');
        await ensureReady(downloadProgress(pm));
        await mark('意味づけ（ベクトル）の更新');
        await AI.vectors.reindex(db, provider, { onProgress: ({ done, total }) => pm.set(`意味づけ（ベクトル）を更新しています… ${done}/${total}`) });
        await renderSemantic();
        if (wantAnswer && provider.unload && !embedding) await provider.unload(); // 回答モデルを読む前に外す（次の検索で読み直す）
      } catch (error) {
        problems.push(`意味検索：${error.message}`);
      }
    }
    if (wantAnswer) {
      try {
        await mark('回答モデルの読み込み');
        pm.set('回答モデルを読み込んでいます…');
        await ensureGenerator(downloadProgress(pm));
      } catch (error) {
        problems.push(`回答モデル：${error.message}`);
      }
    }
    await putSetting(WARM_KEY, null);
    pm.remove();
    if (problems.length) addMessage('ai', `起動時の準備で、使えないものがありました。\n${problems.join('\n')}`, { sub: '保存した文章の検索と、文章の抜き出しは使えます。' });
  }

  el.semBtn.addEventListener('click', () => (semantic.enabled ? disableSemantic() : enableSemantic()));
  el.semSync.addEventListener('click', runSync);

  // ---- 回答モデル（保存した文章を読んで、文章で答える）----
  const ANSWER_KEY = 'answer';
  let answerCfg = { enabled: false, pack: AI.llm.available()[0].id, persona: { preset: 'polite', custom: '' } };
  let generator = null;
  let generatorPreparing = null;
  let answerWarned = false;
  let answerCrashed = false; // 前回、回答モデルで落ちていた（起動時の案内を重ねない）
  let lastChat = null; // 直前の質問と答え。「それってなんで？」のような続きの質問に使う
  let busy = false; // 回答の生成中は次の生成を始めない（端末が重くなる）

  const llmPackOf = (id) => AI.llm.PACKS.find((p) => p.id === id) || AI.llm.available()[0];

  async function loadAnswer() {
    if (memoryOnly) return;
    const row = await getSetting(ANSWER_KEY);
    if (row && row.value) {
      answerCfg = { ...answerCfg, ...row.value, persona: { ...answerCfg.persona, ...(row.value.persona || {}) } };
    }
    // 前回、読み込みの途中でアプリが落ちていたら（目印が残っている）、回答モデルを自動でオフにする
    const tried = await getSetting(TRY_KEY);
    if (tried && tried.value && closedNormallyAfter(tried.value.at)) {
      await putSetting(TRY_KEY, null); // 答えを作っている途中で、ふつうに閉じただけ
    } else if (tried && tried.value) {
      answerCrashed = true;
      const wasPack = llmPackOf(tried.value.pack);
      await putSetting(TRY_KEY, null);
      const raise = String(tried.value.stage || '').startsWith('回答の作成') && (answerCfg.load || 0) < AI.rag.LOAD_LEVELS.length - 1;
      answerCfg = { ...answerCfg, enabled: false, load: (answerCfg.load || 0) + (raise ? 1 : 0) };
      await saveAnswerCfg();
      addMessage('ai', `前回、回答モデル（${wasPack.label}）の${tried.value.stage || '読み込み'}中にアプリが落ちたようです。回答モデルはオフにしました。`, {
        sub: `原因はまだ分かっていません（メモリ不足とは限りません）。${raise ? '次は、読ませる資料と答えの長さを減らして（負荷を1段下げて）試します。' : ''}保存した文章の検索と、文章の抜き出しはそのまま使えます。下のボタンから、すぐ選び直せます。`,
        actions: AI.llm.available().map((p) => ({
          label: `${p.label}で有効にする`,
          main: p.id !== wasPack.id,
          run: async () => {
            answerCfg = { ...answerCfg, pack: p.id };
            await saveAnswerCfg();
            renderAnswer();
            enableAnswer();
          },
        })),
      });
    }
    if (answerCfg.enabled) generator = AI.llm.transformersGenerator(llmPackOf(answerCfg.pack));
  }

  // 読み込み中の目印。最後まで終われば消す。落ちたら残るので、次の起動で気づける
  const TRY_KEY = 'answer-try';
  // ふつうに閉じた・再読み込みしたときは、目印を消す（落ちたときは、この処理は走らない）
  // 記憶（IndexedDB）への書き込みは閉じる瞬間には間に合わないので、すぐ書ける localStorage に時刻を残す
  const CLEAN_KEY = 'ai-safari-closed-normally';
  window.addEventListener('pagehide', () => {
    try {
      localStorage.setItem(CLEAN_KEY, String(Date.now()));
    } catch (_) {
      /* 使えない環境では、落ちた扱いになるだけ */
    }
  });
  // 前回ふつうに閉じた時刻（起動時に1回だけ読む）。落ちたときは、閉じる処理が走らないので古いまま
  let cleanAt = null;
  function closedNormallyAfter(at) {
    if (cleanAt === null) {
      try {
        cleanAt = Number(localStorage.getItem(CLEAN_KEY) || 0);
        localStorage.removeItem(CLEAN_KEY);
      } catch (_) {
        cleanAt = 0;
      }
    }
    return cleanAt > at;
  }
  async function guarded(pack, work) {
    const mark = (stage) => putSetting(TRY_KEY, { pack: pack.id, at: Date.now(), stage });
    await mark('読み込み');
    try {
      return await work(mark);
    } finally {
      await putSetting(TRY_KEY, null);
    }
  }

  const saveAnswerCfg = () => putSetting(ANSWER_KEY, answerCfg);

  async function ensureGenerator(onProgress) {
    if (!generator) return false;
    if (generator.ready) return true;
    if (!generatorPreparing) {
      generatorPreparing = guarded(llmPackOf(answerCfg.pack), () => generator.prepare(onProgress)).finally(() => (generatorPreparing = null));
    }
    await generatorPreparing;
    return generator.ready;
  }

  function renderAnswer() {
    const pack = llmPackOf(answerCfg.pack);
    el.llmChoice.hidden = answerCfg.enabled; // 使用中は変えられない（オフにしてから選ぶ）
    if (!el.llmPack.options.length) {
      for (const p of AI.llm.available()) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = `${p.label} 約${p.approxMB}MB`;
        el.llmPack.appendChild(o);
      }
    }
    el.llmPack.value = pack.id;
    el.llmNote.textContent = pack.note || '';
    if (!answerCfg.enabled) {
      el.llm.textContent = `回答モデル：オフ\n保存した文章を読んで、文章で答えます（約${pack.approxMB}MB・Wi-Fi推奨）`;
      el.llmBtn.textContent = '有効にする';
      el.tone.hidden = true;
      return;
    }
    el.llm.textContent = `回答モデル：オン（${pack.label}）`;
    el.llmBtn.textContent = 'オフにする';
    el.tone.hidden = false;
    el.load.value = String(answerCfg.load || 0);
    el.persona.value = answerCfg.persona.preset;
    el.personaCustom.hidden = answerCfg.persona.preset !== 'custom';
    el.personaCustom.value = answerCfg.persona.custom || '';
  }

  const enableAnswer = () =>
    confirmEnable({
      name: '回答モデル',
      pack: llmPackOf(answerCfg.pack),
      run: runEnableAnswer,
      extra: '小さなモデルなので、間違えることがあります。答えには必ず根拠の文章を付けます。端末によっては動かないことがあり、そのときは文章の抜粋を並べます。',
    });

  function runEnableAnswer(pack) {
    return AI.store.once(`enable:${pack.model}`, () => doEnableAnswer(pack));
  }

  async function doEnableAnswer(pack) {
    const pm = progressMessage('準備しています…');
    const candidate = AI.llm.transformersGenerator(pack);
    try {
      await guarded(pack, async (mark) => {
        await candidate.prepare(downloadProgress(pm));
        await mark('動作確認');
        pm.set('動作を確かめています…');
        await candidate.generate([{ role: 'user', content: 'こんにちは' }], { maxTokens: 4 }); // 実際に1回動かす
      });
    } catch (error) {
      pm.remove();
      await candidate.unload();
      addMessage('ai', `回答モデルを有効にできませんでした。\n${error.message}`, {
        sub: 'メモリが足りない端末では動かないことがあります。保存した文章の検索は、そのまま使えます。',
      });
      await renderFoot(false);
      return;
    }
    AI.store.persist();
    generator = candidate;
    answerCfg = { ...answerCfg, enabled: true, pack: pack.id };
    answerWarned = false;
    await saveAnswerCfg();
    pm.remove();
    addMessage('ai', '回答モデルが使えるようになりました。', {
      sub: '保存した文章に関係する質問をすると、その文章を読んで答えます。メニューで口調も変えられます。',
    });
    await renderFoot(false);
  }

  // 回答モデルをオフにする。wipe ならモデルのファイルも端末から消す
  async function turnOffAnswer(wipe) {
    const pack = llmPackOf(answerCfg.pack);
    const g = generator;
    generator = null;
    if (g) await g.unload();
    answerCfg = { ...answerCfg, enabled: false };
    await saveAnswerCfg();
    if (wipe) {
      try {
        await AI.store.removeModel(pack.model);
      } catch (_) {
        /* 消せなくても無効にはなっている */
      }
    }
    await renderFoot(false);
  }

  function disableAnswer() {
    setDrawer(false);
    const off = async (wipe) => {
      await turnOffAnswer(wipe);
      addMessage('ai', wipe ? '回答モデルをオフにして、モデルを端末から消しました。' : '回答モデルをオフにしました。モデルは残してあります（もう一度有効にするときは、ダウンロードしません）。');
    };
    addMessage('ai', '回答モデルをオフにしますか？', {
      sub: '保存した単語や文章は残ります。オフの間は、文章の抜粋を並べて答えます。',
      actions: [
        { label: 'オフにする（残す）', main: true, run: () => off(false) },
        { label: 'オフにして端末から消す', run: () => off(true) },
        { label: 'やめる', run: async () => {} },
      ],
    });
  }

  el.load.addEventListener('change', async () => {
    answerCfg = { ...answerCfg, load: Number(el.load.value) };
    await saveAnswerCfg();
  });

  el.llmPack.addEventListener('change', async () => {
    answerCfg = { ...answerCfg, pack: el.llmPack.value };
    await saveAnswerCfg();
    renderAnswer();
  });

  el.llmBtn.addEventListener('click', () => (answerCfg.enabled ? disableAnswer() : enableAnswer()));

  // 口調
  for (const [key, def] of Object.entries(AI.rag.PERSONAS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = def.label;
    el.persona.appendChild(o);
  }
  el.persona.addEventListener('change', async () => {
    answerCfg.persona = { ...answerCfg.persona, preset: el.persona.value };
    el.personaCustom.hidden = el.persona.value !== 'custom';
    await saveAnswerCfg();
  });
  el.personaCustom.addEventListener('change', async () => {
    answerCfg.persona = { ...answerCfg.persona, custom: el.personaCustom.value.trim() };
    await saveAnswerCfg();
  });

  // 保存した文章を根拠に答える。表示まで終えたら true。使えなかったら false（呼び出し側が抜粋の一覧に切り替える）
  async function answerWithModel(query, hits, history) {
    if (busy) return false;
    busy = true;
    try {
      let note = null;
      try {
        if (!generator.ready) note = progressMessage('回答モデルを読み込んでいます…');
        await ensureGenerator(note ? downloadProgress(note) : undefined);
      } catch (error) {
        if (note) note.remove();
        if (!answerWarned) {
          answerWarned = true;
          addMessage('ai', `${error.message}\n文章の抜粋を並べて答えます。`);
        }
        return false;
      }
      if (note) note.remove();

      const msg = addMessage('ai', '考えています…', { actions: [{ label: '止める', run: async () => generator.stop() }] });
      const text = msg.querySelector('.body').childNodes[0];
      let result;
      try {
        // 答えを作っている最中に落ちても、次の起動で気づけるように目印を付ける
        // 答えを作る間は、意味検索のモデルをメモリから外す（2つ同時に載せない）。次の検索で読み直す
        if (provider && provider.ready && provider.unload && !preparing && !embedding) await provider.unload();
        result = await guarded(llmPackOf(answerCfg.pack), async (mark) => {
          await mark('回答の作成');
          return AI.rag.answer({
            // どの段階・どの量で落ちたかを、次の起動で分かるように、動かす直前に記録する
            onProgress: async (p) => {
              const step = p.phase === 'read' ? `塊${p.i}/${p.n}を読む` : p.phase === 'write' ? '仕上げ' : '1回で答える';
              await mark(`回答の作成（${step}・${p.chars}字・答えの量${answerCfg.load || 0}）`);
              text.nodeValue = p.phase === 'read' ? `資料を分けて読んでいます…（${p.i}/${p.n}）` : `読んだ内容から答えを書いています…`;
              scrollDown();
            },
            query,
            hits,
            generator,
            history,
            load: answerCfg.load,
            persona: answerCfg.persona,
            onToken: (t) => {
              text.nodeValue = t;
              scrollDown();
            },
          });
        });
      } catch (error) {
        msg.remove();
        addMessage('ai', `回答を作れませんでした。\n${error.message}\n文章の抜粋を並べて答えます。`);
        return false;
      }
      msg.remove();

      const evidenceActions = result.evidence.map((e) => ({ label: `全文を見る [${e.n}] ${e.passage.title}`, run: async () => showPassage(e.passage, false) }));
      if (result.unknown) {
        await notKnown(query, {
          lead: result.missing ? `保存した文章には、「${result.missing.join('」「')}」が出てきません。` : `保存した文章には、「${query}」の答えが見つかりませんでした。`,
          actions: evidenceActions.map((a) => ({ ...a, label: `近い文章 ${a.label}` })),
        });
        return true;
      }
      AI.growth.markUsed(db, 'passage', result.evidence.map((e) => e.passage.id)).catch(() => {}); // 根拠に使われた
      lastAnswer = { targets: [{ type: 'passage', id: result.evidence[0].passage.id, label: result.evidence[0].passage.title }] };
      // 資料に無い言葉が多すぎる答えは、そのまま出さない。資料から文を抜き出して出す
      if (result.grounding < 0.4) {
        const picked = await AI.rag.extractAnswer({ query, hits }).catch(() => null);
        const topicQ = history && history[0] ? history[0].q : query;
        addMessage('ai', picked ? picked.text : '資料から答えを取り出せませんでした。', {
          sub: `モデルの答えに、保存した文章に無い内容が多かったので、文章から抜き出しました。\n根拠：[1] ${result.evidence[0].passage.title}\nもし良ければ、Wikipediaで調べましょうか？`,
          actions: evidenceActions.concat([
            { label: 'モデルの答えも見る', run: async () => addMessage('ai', result.raw || result.text, { sub: '⚠ 保存した文章に無い内容が多く含まれる、モデルの答えそのままです。間違いが混ざっています。' }) },
            { label: 'Wikipediaで調べる', run: async () => searchWikipedia(topicQ) },
          ]),
        });
        return true;
      }
      if (result.raw && result.raw.length > result.text.length + 8) {
        evidenceActions.push({ label: '答えの続きも見る', run: async () => addMessage('ai', result.raw, { sub: 'モデルが作った答えの全文です（長い部分は、表示を省いていました）。' }) });
      }
      lastChat = { query, text: result.text, hits };
      const weak = result.grounding < 0.5;
      const warn = weak ? '⚠ 保存した文章に無い言葉が多く含まれています。根拠を確かめてください。\nもし良ければ、Wikipediaで調べましょうか？\n' : '';
      const topic = history && history[0] ? history[0].q : query;
      if (weak) evidenceActions.push({ label: 'Wikipediaで調べる', run: async () => searchWikipedia(topic) });
      addMessage('ai', result.text, {
        sub: `${warn}根拠：${result.evidence.map((e) => `[${e.n}] ${e.passage.title}`).join('、')}\n小さなモデルが保存した文章から作った答えです。間違うことがあるので、根拠を押して確かめ、👍/👎を付けてください。`,
        actions: evidenceActions,
      });
      return true;
    } finally {
      busy = false;
    }
  }

  // ---- 端末に保存したもの（いつでも消せる）----
  function twoTapDelete(button, run) {
    let timer = null;
    const label = button.textContent;
    button.addEventListener('click', async () => {
      if (!button.classList.contains('sure')) {
        button.classList.add('sure');
        button.textContent = '本当に消す';
        timer = setTimeout(() => {
          button.classList.remove('sure');
          button.textContent = label;
        }, 4000);
        return;
      }
      clearTimeout(timer);
      button.disabled = true;
      try {
        await run();
      } catch (error) {
        addMessage('ai', `消せませんでした。\n${error.message}`);
      }
      await renderDownloads();
    });
  }

  async function renderDownloads() {
    if (!db) return;
    const rows = [];
    const lib = await AI.store.inspectLibrary();
    if (lib.cached) {
      rows.push({
        title: '実行用ファイル（Transformers.js）',
        note: '意味検索と回答モデルで共通。消すと、この2つはオフになります',
        bytes: lib.bytes,
        remove: async () => {
          if (semantic.enabled) await turnOffSemantic(false);
          if (answerCfg.enabled) await turnOffAnswer(false);
          await AI.store.removeLibrary();
          addMessage('ai', '実行用ファイルを端末から消しました。意味検索と回答モデルはオフにしました（モデルは残っています）。');
        },
      });
    }
    for (const pack of AI.embed.PACKS) {
      const m = await AI.store.inspectModel(pack.model);
      if (!m.files) continue;
      rows.push({
        title: `意味検索のモデル（${pack.label}）`,
        note: semantic.enabled && semantic.pack === pack.id ? '使用中。消すと意味検索はオフになります' : '',
        bytes: m.bytes,
        remove: async () => {
          if (semantic.enabled && semantic.pack === pack.id) await turnOffSemantic(false);
          await AI.store.removeModel(pack.model);
          addMessage('ai', '意味検索のモデルを端末から消しました。');
        },
      });
    }
    const seenModels = new Set(); // 同じモデルで形式違いの版は、ファイルを共有するので1行にまとめる
    for (const pack of AI.llm.PACKS) {
      if (seenModels.has(pack.model)) continue;
      seenModels.add(pack.model);
      const m = await AI.store.inspectModel(pack.model);
      if (!m.files) continue;
      rows.push({
        title: `回答モデル（${pack.label}）`,
        note: answerCfg.enabled && llmPackOf(answerCfg.pack).model === pack.model ? '使用中。消すと回答モデルはオフになります' : '',
        bytes: m.bytes,
        remove: async () => {
          if (answerCfg.enabled && llmPackOf(answerCfg.pack).model === pack.model) await turnOffAnswer(false);
          await AI.store.removeModel(pack.model);
          addMessage('ai', '回答モデルを端末から消しました。');
        },
      });
    }
    el.dlList.replaceChildren();
    if (!rows.length) {
      const p = document.createElement('p');
      p.textContent = '保存したものはありません。';
      el.dlList.appendChild(p);
      return;
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'dl';
      const label = document.createElement('span');
      label.textContent = `${r.title}\n${AI.store.formatSize(r.bytes)}${r.note ? `　${r.note}` : ''}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '消す';
      twoTapDelete(button, r.remove);
      row.append(label, button);
      el.dlList.appendChild(row);
    }
  }

  // ---- 育ち：評価・ピン・使われた回数・言葉からの評価 ----
  let weights = { ...AI.growth.DEFAULT_WEIGHTS };
  let lastAnswer = null; // 直前の答えの対象。次の発言が「ありがとう」などのときだけ使う

  const nameOf = (kind) => (kind === 'term' ? '単語' : '文章');

  async function togglePin(kind, record) {
    const key = kind === 'term' ? record.key : record.id;
    const now = (record.importance || 0) > 0 ? 0 : 1;
    await AI.growth.setImportance(db, kind, key, now);
    record.importance = now;
    addMessage('ai', now ? `「${kind === 'term' ? record.term : record.title}」をピン留めしました。` : 'ピン留めを外しました。', {
      sub: now ? '検索で少し上に出ます。整理の候補にも出しません。' : '',
    });
    await render();
  }
  const pinAction = (kind, record) => ({
    label: (record.importance || 0) > 0 ? '📌 ピンを外す' : '📌 ピン留め',
    run: () => togglePin(kind, record),
  });

  // 言葉（ありがとう／違う）から評価する。明示の👍/👎を優先し、取り消せるようにする
  async function applySentiment(sent, target) {
    const t = target.targets[0]; // 答えの主な根拠だけを評価する
    const cur = await AI.feedback.current(db, t.type, t.id);
    if (cur !== 0) {
      addMessage('ai', sent.value > 0 ? 'はい。' : `「${t.label}」にはすでに${cur > 0 ? '👍' : '👎'}が付いているので、そのままにしました。`, {
        sub: sent.value > 0 ? '' : '変えるときは👍/👎のボタンで。',
      });
      return;
    }
    await AI.feedback.setValue(db, t.type, t.id, sent.value, { via: 'words' });
    await render();
    addMessage('ai', `評価を変更しました：「${t.label}」を${sent.value > 0 ? '👍' : '👎'}に。`, {
      sub: `「${sent.word}」という言葉からの自動の判断です。違っていたら取り消せます。`,
      actions: [
        {
          label: '取り消す',
          run: async () => {
            await AI.feedback.setValue(db, t.type, t.id, 0, { via: 'undo' });
            await render();
            addMessage('ai', '評価を元に戻しました。');
          },
        },
      ],
    });
  }

  // ---- 聞く ----
  // 文章を開く。countUse: 使われた回数に数える（回答の根拠から開いたときは、回答のときに数え済みなので数えない）
  function showPassage(p, countUse = true) {
    if (countUse) AI.growth.markUsed(db, 'passage', p.id).catch(() => {});
    lastAnswer = { targets: [{ type: 'passage', id: p.id, label: p.title }] };
    addMessage('ai', p.body, {
      rate: { type: 'passage', id: p.id },
      title: p.title,
      sub: `保存 ${formatDate(p.fetchedAt)}${p.sourceUrl ? `\n${p.sourceUrl}` : ''}${p.license ? `（${p.license}）` : ''}`,
      actions: [pinAction('passage', p)],
    });
  }

  // 保存した文章が見つかったとき：回答モデルがあれば文章で、なければ抜き出しと一覧で答える
  async function answerFromHits(query, hits, history) {
    if (answerCfg.enabled && generator && (await answerWithModel(query, hits, history))) return;
    const picked = await AI.rag.extractAnswer({ query, hits }).catch(() => null);
    const lead = picked ? `〔抜き出し〕${picked.text}\n（「${hits[0].passage.title}」より。文章から文を抜き出しただけで、答えとは限りません）\n\n` : '';
    addMessage('ai', lead + hits.map((h, i) => `${i + 1}. ${h.passage.title}${h.via && !h.via.includes('keyword') ? '〔意味が近い〕' : ''}\n   ${h.snippet}`).join('\n'), {
      title: `保存した文章に ${hits.length} 件あります`,
      sub: '押すと全文を表示します。',
      actions: hits.map((h) => ({ label: `全文を見る ${h.passage.title}`, run: async () => showPassage(h.passage) })),
    });
    return;
  }

  // ---- 知らないことを自動で調べる（質問の下のスイッチ。初期はオフ）----
  const AUTO_KEY = 'autosearch';
  let autoSearch = false;
  const renderAuto = () => {
    el.auto.setAttribute('aria-pressed', String(autoSearch));
    el.auto.textContent = `知らないことは自動で調べる：${autoSearch ? 'オン' : 'オフ'}`;
  };
  el.auto.addEventListener('click', async () => {
    await dbReady;
    if (!db) return;
    autoSearch = !autoSearch;
    renderAuto();
    await putSetting(AUTO_KEY, autoSearch);
    if (autoSearch) {
      addMessage('ai', '自動で調べるをオンにしました。', {
        sub: '保存した記憶に無い質問は、確認なしでWikipediaに送ります。一番近い記事を文章として保存し、その場で答えます。オフライン中は送りません。',
      });
    }
  });

  // 保存した記憶に無い質問をWikipediaで調べ、一番近い記事を保存して答える。答えまで出せたら true
  async function autoLearn(query) {
    if (AI.net.isOffline() || navigator.onLine === false) return false;
    const note = progressMessage(`Wikipediaで「${AI.wiki.searchTerm(query)}」を調べています…`);
    let list;
    try {
      list = await AI.wiki.search(query);
    } catch (_) {
      note.remove();
      return false; // 繋がらなければ、いつもの案内に戻る
    }
    note.remove();
    if (!list.length) return false;
    const c = list[0];
    const p = await AI.passages.add(db, c.extract, { title: c.title, sourceUrl: c.url, license: WIKI_LICENSE, terms: [query] });
    await AI.queue.resolve(db, query);
    await render();
    addMessage('ai', `Wikipedia「${c.title}」を文章として保存しました。`, {
      sub: '記事が違うときは、取り消して別の候補を選べます。',
      actions: [
        {
          label: '違う記事にする',
          run: async () => {
            await AI.passages.remove(db, p.id);
            await render();
            showCandidate(query, list, list.length > 1 ? 1 : 0);
          },
        },
        {
          label: '保存を取り消す',
          run: async () => {
            await AI.passages.remove(db, p.id);
            await render();
            addMessage('ai', '取り消しました。');
          },
        },
      ],
    });
    const hits = [{ passage: p, snippet: p.body.slice(0, 80), score: 1, via: ['keyword'] }];
    await answerFromHits(query, hits);
    indexInBackground(p); // 意味検索のベクトルは、答えを出し終えてから作る（同時に動かさない）
    return true;
  }

  async function ask(query) {
    // 続きの質問（「それってなんで？」など）は、直前の資料と会話を引き継いで答える
    if (lastChat && answerCfg.enabled && generator && AI.rag.isFollowUp(query)) {
      const prev = lastChat;
      await answerFromHits(query, prev.hits, [{ q: prev.query, a: prev.text }]);
      return;
    }
    lastChat = null;
    const record = await AI.terms.get(db, query);
    const hits = await searchPassages(query);
    if (record) {
      AI.growth.markUsed(db, 'term', record.key).catch(() => {});
      lastAnswer = { targets: [{ type: 'term', id: record.key, label: record.term }] };
      addMessage('ai', record.definition || '（定義はまだありません）', {
        title: record.term,
        rate: { type: 'term', id: record.key },
        sub: `更新 ${formatDate(record.updatedAt)}${hits.length ? `\n保存した文章にも ${hits.length} 件あります。` : ''}`,
        actions: hits.map((h) => ({ label: h.passage.title, run: async () => showPassage(h.passage) })).concat([pinAction('term', record)]),
      });
      return;
    }
    if (hits.length) return answerFromHits(query, hits);
    if (autoSearch && (await autoLearn(query))) return;

    await notKnown(query, {});
  }

  // 答えられなかった質問の後始末：未回答に残し、近い言葉とWikipediaを案内する
  async function notKnown(query, { lead, actions: extra }) {
    const key = AI.normalizeTerm(query);
    const near = key
      ? (await AI.terms.list(db)).filter((r) => r.key.includes(key) || key.includes(r.key)).slice(0, 5)
      : [];
    const actions = (extra || []).concat(
      near.map((r) => ({
        label: r.term,
        run: async () => {
          addMessage('user', r.term);
          await ask(r.term);
        },
      }))
    );
    const head = lead || `「${query}」はまだ知りません。`;
    // 答えられなかった質問は、未回答に残す（あとでオンラインのときにまとめて調べられる）
    await AI.queue.add(db, query);
    await render();

    if (AI.net.isOffline()) {
      addMessage('ai', `${head}${near.length ? '近い言葉があります。' : ''}\n「${query} = 意味」と教えてください。`, {
        sub: 'オフラインモード中なので、外部には調べに行きません。未回答に残したので、オンラインに戻ったらまとめて調べられます。',
        actions,
      });
      return;
    }
    actions.push({ label: 'Wikipediaで調べる', main: true, run: () => searchWikipedia(query) });

    addMessage('ai', `${head}${near.length ? '近い言葉があります。' : ''}\n「${query} = 意味」と教えるか、Wikipediaで調べられます。`, {
      sub: `Wikipediaで調べると、「${query}」がWikipediaに送られます。調べずに閉じても、未回答に残ります。`,
      actions,
    });
  }

  async function handle(text) {
    addMessage('user', text);
    await dbReady;
    if (!db) return; // 開けなかった理由は、すでに画面に出している
    const previous = lastAnswer;
    lastAnswer = null; // 言葉での評価は、答えの直後の1回だけ
    const sent = AI.sentiment.detect(text);
    if (sent.value && previous) return applySentiment(sent, previous);
    const questions = AI.chat.splitQuestions(text);
    if (questions.length > 1) {
      for (let i = 0; i < questions.length; i++) {
        const q = AI.chat.parse(questions[i]);
        addMessage('ai', `(${i + 1}/${questions.length}) ${questions[i]}`);
        await ask(q.query || questions[i]);
      }
      return;
    }
    const parsed = AI.chat.parse(text);
    if (parsed.type === 'teach') {
      if (!parsed.confirm) return save(parsed, 'ask');
      addMessage('ai', `「${parsed.term}」＝「${parsed.definition}」として覚えますか？`, {
        actions: [
          { label: '覚える', main: true, run: () => save(parsed, 'ask') },
          { label: 'やめる', run: async () => addMessage('ai', '覚えませんでした。') },
        ],
      });
      return;
    }
    if (parsed.type === 'note') {
      addMessage('ai', '長い文章なので、文章として保存しますか？', {
        sub: `${parsed.text.length}文字。保存すると、あとからキーワードで探せます。`,
        actions: [
          { label: '文章として保存', main: true, run: () => savePassage(parsed.text) },
          { label: '保存しない', run: async () => addMessage('ai', '保存しませんでした。') },
        ],
      });
      return;
    }
    if (parsed.type === 'ask') return ask(parsed.query);
  }

  // ---- 入力欄 ----
  function fitInput() {
    el.input.style.height = 'auto';
    el.input.style.height = `${el.input.scrollHeight}px`;
    el.send.disabled = el.input.value.trim() === '';
  }
  el.input.addEventListener('input', fitInput);

  const touch = window.matchMedia('(pointer: coarse)');
  el.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 日本語の変換確定のEnterでは送らない。スマホのEnterは改行にする（送るのは右のボタン）
    if (event.isComposing || event.keyCode === 229 || touch.matches) return;
    event.preventDefault();
    submit();
  });

  async function submit() {
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    fitInput();
    try {
      await handle(text);
    } catch (error) {
      addMessage('ai', `うまくいきませんでした。\n${error.message}`);
    }
    if (!touch.matches) el.input.focus();
  }

  // requestSubmit が無い古いブラウザでも動くように、submit イベントから直接呼ぶ
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  document.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      el.input.value = chip.dataset.fill;
      fitInput();
      el.input.focus();
    })
  );

  el.reset.addEventListener('click', () => {
    el.messages.textContent = '';
    el.hello = null;
    addMessage('ai', '新しい会話にしました。覚えた内容は消えていません。');
    el.input.focus();
  });

  // 一覧に出す印：ピン・評価・使われた回数
  function marks(r) {
    const m = [];
    if ((r.importance || 0) > 0) m.push('📌');
    if ((r.score || 0) > 0) m.push('👍');
    if ((r.score || 0) < 0) m.push('👎');
    if (r.useCount > 0) m.push(`使用${r.useCount}回`);
    return m.length ? ` ・ ${m.join(' ')}` : '';
  }

  // ---- 記憶の一覧 ----
  async function renderTerms() {
    if (!db) return;
    const all = await AI.terms.list(db);
    const q = AI.normalizeTerm(el.search.value);
    const shown = q
      ? all.filter((r) => r.key.includes(q) || AI.normalizeTerm(r.definition).includes(q))
      : all;

    el.list.textContent = '';
    for (const r of shown) {
      const li = document.createElement('li');

      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = r.term;

      const def = document.createElement('p');
      def.className = 'def';
      def.textContent = r.definition || '（定義なし）';

      const meta = document.createElement('span');
      meta.className = 'meta';
      const others = r.variants.filter((v) => v !== r.term);
      const from = r.sources.length ? ` ・ 出典 ${r.sources[0].title || r.sources[0].url}` : '';
      meta.textContent = `更新 ${formatDate(r.updatedAt)}${others.length ? ` ・ ${others.join('、')}` : ''}${from}${marks(r)}`;

      // 消すときは2回押す（スマホの押し間違い対策）
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '消す';
      del.setAttribute('aria-label', `${r.term} を消す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '消す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        await AI.terms.remove(db, r.key);
        await render();
      });

      li.append(term, del, def, meta);
      el.list.appendChild(li);
    }

    el.empty.hidden = shown.length > 0;
    el.empty.textContent = all.length === 0 ? 'まだ何も覚えていません。' : '見つかりませんでした。';
    el.count.textContent = q ? `${shown.length} / ${all.length} 件` : `${all.length} 件`;
  }

  // ---- 文章の一覧（「文章」タブ）----
  async function renderPassages() {
    const total = await AI.passages.count(db);
    const q = el.search.value.trim();
    const shown = q
      ? (await AI.passages.search(db, q, { limit: 200 })).map((h) => h.passage)
      : await AI.passages.list(db);

    el.list.textContent = '';
    for (const p of shown) {
      const li = document.createElement('li');

      const title = document.createElement('span');
      title.className = 'term';
      title.textContent = p.title;

      const body = document.createElement('p');
      body.className = 'def clamp';
      body.textContent = p.body;
      body.title = 'タップで全文を開く／閉じる';
      body.addEventListener('click', () => body.classList.toggle('clamp'));

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `保存 ${formatDate(p.fetchedAt)} ・ ${p.body.length}文字${p.sourceUrl ? ` ・ ${p.sourceUrl}` : ''}${p.license ? ` ・ ${p.license}` : ''}${marks(p)}`;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '消す';
      del.setAttribute('aria-label', `${p.title} を消す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '消す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        await AI.passages.remove(db, p.id); // 単語は残る
        await render();
      });

      li.append(title, del, body, meta);
      el.list.appendChild(li);
    }

    el.empty.hidden = shown.length > 0;
    el.empty.textContent = total === 0 ? 'まだ文章は保存していません。長い文章を貼って送ると、保存できます。' : '見つかりませんでした。';
    el.count.textContent = q ? `${shown.length} / ${total} 件` : `${total} 件`;
  }

  // ---- モード（オンライン／オフライン）----
  function showMode(off) {
    el.mode.dataset.mode = off ? 'offline' : 'online';
    el.mode.textContent = off ? 'オフライン' : 'オンライン';
    el.mode.setAttribute('aria-pressed', String(off));
    el.input.placeholder = off ? '覚えさせる・聞く' : '覚えさせる・聞く・文章を貼る';
  }
  AI.net.onChange(showMode);
  el.mode.addEventListener('click', async () => {
    const next = !AI.net.isOffline();
    try {
      await AI.net.setOffline(db, next);
    } catch (error) {
      addMessage('ai', `モードを切り替えられませんでした。\n${error.message}`);
      return;
    }
    addMessage(
      'ai',
      next
        ? 'オフラインモードにしました。これからは外部に通信せず、覚えた内容だけで答えます。'
        : 'オンラインに戻しました。知らない語はWikipediaで調べられます。'
    );
  });

  // ---- 保存領域と書き出し ----
  const DAY = 24 * 60 * 60 * 1000;
  function bytes(n) {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  const installed = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  async function renderFoot(askPersist) {
    // 保存領域：使用量と、消されにくくする要求の結果
    const parts = [];
    try {
      if (navigator.storage && navigator.storage.persist && askPersist) await navigator.storage.persist();
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        parts.push(`使用量 ${bytes(e.usage || 0)}`);
      }
      parts.push(persisted ? '消えにくい保存：有効' : '消えにくい保存：未確認');
    } catch (_) {
      parts.push('保存領域の状態は取得できませんでした');
    }
    await renderSemantic();
    renderAnswer();
    await renderDownloads();
    const note = installed() ? '' : '\nホーム画面に追加すると、消えにくくなります。';
    el.storage.textContent = parts.join(' ／ ') + note;

    // 最後に書き出してからの日数
    const last = await AI.backup.lastExportAt(db);
    const total = (await AI.terms.count(db)) + (await AI.passages.count(db));
    el.backupInfo.className = '';
    if (last == null) {
      el.backupInfo.textContent = total ? '⚠ まだ書き出していません。端末の都合で記憶が消えることがあるので、バックアップを取ってください。' : 'まだ書き出していません。';
      if (total) el.backupInfo.className = 'warn';
    } else {
      const days = Math.floor((Date.now() - last) / DAY);
      el.backupInfo.textContent = days === 0 ? '最後の書き出し：今日' : `最後の書き出し：${days}日前`;
      if (days >= 7 && total) {
        el.backupInfo.textContent += '。そろそろバックアップを取りませんか。';
        el.backupInfo.className = 'warn';
      }
    }
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  el.exportBtn.addEventListener('click', async () => {
    if (!db) return;
    try {
      const data = await AI.backup.exportAll(db);
      const name = `ai-backup-${stamp()}.json`;
      const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
      const touchDevice = window.matchMedia('(pointer: coarse)').matches;
      if (touchDevice && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
        } catch (error) {
          if (error && error.name === 'AbortError') return; // 共有をやめた
          throw error;
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      await AI.backup.markExported(db);
      setDrawer(false);
      addMessage('ai', `書き出しました（${name}）。\n単語 ${data.terms.length} 件、文章 ${data.passages.length} 件。`, {
        sub: '「ファイル」アプリなど、端末の外にも置いておくと安心です。',
      });
      await renderFoot(false);
    } catch (error) {
      addMessage('ai', `書き出せませんでした。\n${error.message}`);
    }
  });

  // ---- 一括で消す ----
  el.wipeBtn.addEventListener('click', async () => {
    await dbReady;
    if (!db) return;
    setDrawer(false);
    const n = await AI.db.tx(db, ['terms', 'passages'], 'readonly', async (t) => ({
      terms: await AI.db.rq(t.objectStore('terms').count()),
      passages: await AI.db.rq(t.objectStore('passages').count()),
    }));
    addMessage('ai', `覚えたこと（単語 ${n.terms} 件、文章 ${n.passages} 件）を全て消しますか？`, {
      sub: '評価や未回答も消えます。元には戻せません。先に書き出しておくと、あとで読み込めます。設定とダウンロード済みのモデルは残ります。',
      actions: [
        { label: '先に書き出す', main: true, run: async () => el.exportBtn.click() },
        {
          label: '消す',
          run: async () => {
            addMessage('ai', '本当に全て消します。よろしいですか？', {
              actions: [
                {
                  label: 'はい、全て消す',
                  run: async () => {
                    await AI.backup.wipe(db);
                    lastAnswer = null;
                    await render();
                    await renderFoot(false);
                    addMessage('ai', '覚えたことを全て消しました。');
                  },
                },
                { label: 'やめる', main: true, run: async () => {} },
              ],
            });
          },
        },
        { label: 'やめる', run: async () => {} },
      ],
    });
  });

  el.resetBtn.addEventListener('click', async () => {
    await dbReady;
    if (!db) return;
    setDrawer(false);
    addMessage('ai', 'アプリをこの端末で初期状態に戻しますか？', {
      sub: '覚えたこと、設定、ダウンロード済みのモデルと実行用ファイルを全て消します。元には戻せません。先に書き出しておくと安心です。',
      actions: [
        { label: '先に書き出す', main: true, run: async () => el.exportBtn.click() },
        {
          label: '全て消して初期状態に戻す',
          run: async () => {
            try {
              if (generator) await generator.unload();
              await AI.backup.wipe(db, { settings: true });
              for (const pack of AI.llm.PACKS) await AI.store.removeModel(pack.model).catch(() => {});
              for (const pack of AI.embed.PACKS) await AI.store.removeModel(pack.model).catch(() => {});
              await AI.store.removeLibrary().catch(() => {});
            } catch (error) {
              addMessage('ai', `消しきれませんでした。\n${error.message}`);
              return;
            }
            location.reload();
          },
        },
        { label: 'やめる', run: async () => {} },
      ],
    });
  });

  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', async () => {
    const file = el.importFile.files && el.importFile.files[0];
    el.importFile.value = ''; // 同じファイルをもう一度選べるように
    if (!file || !db) return;
    setDrawer(false);
    let data;
    let counts;
    try {
      data = JSON.parse(await file.text());
      counts = AI.backup.validate(data);
    } catch (error) {
      addMessage('ai', `読み込めませんでした。\n${error instanceof SyntaxError ? 'JSONとして読めないファイルです。' : error.message}`);
      return;
    }
    const run = (mode) => async () => {
      const r = await AI.backup.importAll(db, data, { mode });
      addMessage('ai', mode === 'overwrite'
        ? `置き換えました。単語 ${r.terms.added} 件、文章 ${r.passages.added} 件。`
        : `統合しました。単語は新規 ${r.terms.added} 件・既存と統合 ${r.terms.merged} 件、文章は新規 ${r.passages.added} 件（同じ内容 ${r.passages.skipped} 件は重ねていません）。`);
      await render();
      await renderFoot(false);
      if (semantic.enabled) runSync(); // 読み込んだ文章のベクトルを作る
    };
    addMessage('ai', `「${file.name}」を読み込みます。\n単語 ${counts.terms} 件、文章 ${counts.passages} 件。`, {
      sub: '統合：今の記憶を残して足します。置き換え：今の記憶は全て消えます。',
      actions: [
        { label: '統合して読み込む', main: true, run: run('merge') },
        { label: '置き換える', run: run('overwrite') },
        { label: 'やめる', run: async () => addMessage('ai', '読み込みませんでした。') },
      ],
    });
  });

  // ---- オフラインで開けるように（Service Worker）----
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---- 未回答の一覧（「未回答」タブ）----
  async function renderQueue() {
    const items = await AI.queue.list(db);
    el.list.textContent = '';
    if (items.length && !AI.net.isOffline()) {
      const li = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'bulk';
      go.textContent = `まとめて調べる（${items.length}件）`;
      go.addEventListener('click', () => {
        setDrawer(false);
        researchQueue();
      });
      li.appendChild(go);
      el.list.appendChild(li);
    }
    for (const r of items) {
      const li = document.createElement('li');
      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = r.query;
      const def = document.createElement('p');
      def.className = 'def';
      def.textContent = r.askedCount > 1 ? `${r.askedCount}回聞かれました` : '答えられませんでした';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `最初に聞いた日 ${formatDate(r.createdAt)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '外す';
      del.setAttribute('aria-label', `${r.query} を未回答から外す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '外す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        await AI.queue.setStatus(db, r.id, 'dismissed');
        await render();
      });
      li.append(term, del, def, meta);
      el.list.appendChild(li);
    }
    el.empty.hidden = items.length > 0;
    el.empty.textContent = '答えられなかった質問はありません。';
    el.count.textContent = `${items.length} 件`;
  }

  // ---- 並び順の重み（設定）----
  const WEIGHT_UI = [
    ['score', el.wScore, '評価（👍/👎）'],
    ['importance', el.wImportance, 'ピン留め'],
    ['fresh', el.wFresh, '新しさ'],
  ];
  function renderWeights() {
    for (const [key, input, label] of WEIGHT_UI) {
      input.value = String(Math.round(weights[key] * 100));
      input.setAttribute('aria-label', label);
      input.parentElement.querySelector('output').textContent = `${Math.round(weights[key] * 100)}%`;
    }
  }
  for (const [key, input] of WEIGHT_UI) {
    input.addEventListener('input', () => {
      input.parentElement.querySelector('output').textContent = `${input.value}%`;
    });
    input.addEventListener('change', async () => {
      weights = await AI.growth.saveWeights(db, { ...weights, [key]: Number(input.value) / 100 });
      renderWeights();
    });
  }
  el.wReset.addEventListener('click', async () => {
    weights = await AI.growth.saveWeights(db, AI.growth.DEFAULT_WEIGHTS);
    renderWeights();
  });

  // ---- 整理と育ち（「整理」タブ）----
  const SVG = 'http://www.w3.org/2000/svg';
  // 手で描いたような、少し歪んだ長方形の線。同じ入力なら同じ形になる
  function wobblyRect(x, y, w, h, seed) {
    const j = (k) => Math.sin(seed * 12.9898 + k * 78.233) * 1.6;
    const pts = [[x + j(1), y + j(2)], [x + w + j(3), y + j(4)], [x + w + j(5), y + h + j(6)], [x + j(7), y + h + j(8)]];
    return `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} L${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)} L${pts[2][0].toFixed(1)} ${pts[2][1].toFixed(1)} L${pts[3][0].toFixed(1)} ${pts[3][1].toFixed(1)} Z`;
  }

  function growthChart(points) {
    const W = 300, H = 120, base = 100, top = 16;
    const max = Math.max(1, ...points.map((p) => p.total));
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `蓄積数の推移。いま ${points[points.length - 1].total} 件`);
    svg.classList.add('chart');
    const slot = W / points.length;
    points.forEach((pt, i) => {
      const h = Math.max(2, ((base - top) * pt.total) / max);
      const x = i * slot + slot * 0.2;
      const w = slot * 0.6;
      const y = base - h;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', wobblyRect(x, y, w, h, i + 1));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.4');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      // 斜線で塗る（鉛筆風）
      for (let k = 6; k < h; k += 6) {
        const line = document.createElementNS(SVG, 'path');
        line.setAttribute('d', `M${(x + 1).toFixed(1)} ${(y + k).toFixed(1)} L${(x + w - 1).toFixed(1)} ${(y + k - 5).toFixed(1)}`);
        line.setAttribute('stroke', 'currentColor');
        line.setAttribute('stroke-width', '0.7');
        line.setAttribute('opacity', '0.45');
        svg.appendChild(line);
      }
      const label = document.createElementNS(SVG, 'text');
      label.setAttribute('x', (x + w / 2).toFixed(1));
      label.setAttribute('y', String(H - 4));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '9');
      label.setAttribute('fill', 'currentColor');
      label.textContent = i === points.length - 1 ? '今' : `${points.length - 1 - i}週前`;
      svg.appendChild(label);
      if (i === points.length - 1 || i === 0) {
        const n = document.createElementNS(SVG, 'text');
        n.setAttribute('x', (x + w / 2).toFixed(1));
        n.setAttribute('y', (y - 4).toFixed(1));
        n.setAttribute('text-anchor', 'middle');
        n.setAttribute('font-size', '10');
        n.setAttribute('fill', 'currentColor');
        n.textContent = String(pt.total);
        svg.appendChild(n);
      }
    });
    return svg;
  }

  function wikiTitleOf(p) {
    try {
      const last = new URL(p.sourceUrl).pathname.split('/').pop();
      return decodeURIComponent(last).replace(/_/g, ' ') || p.title;
    } catch (_) {
      return p.title;
    }
  }

  // 古い文章を Wikipedia から取り直す（押したときだけ。記事名が Wikipedia に送られる）
  async function refetchPassage(c) {
    const p = await AI.passages.get(db, c.id);
    if (!p) return;
    const found = await AI.wiki.byTitle(wikiTitleOf(p));
    if (!found) {
      addMessage('ai', `Wikipediaで「${p.title}」が見つかりませんでした。今の文章はそのままにしました。`);
      return;
    }
    const same = AI.normalizeTerm(found.extract) === AI.normalizeTerm(p.body);
    const updated = await AI.passages.replaceBody(db, p.id, found.extract);
    addMessage('ai', same ? `「${p.title}」は内容が変わっていませんでした（保存日だけ新しくしました）。` : `「${p.title}」を最新の内容に入れ替えました。`, {
      sub: '評価・ピン・使われた回数は引き継いでいます。',
    });
    indexInBackground(updated); // 意味検索がオンなら、ベクトルも作り直す
    await render();
  }

  async function renderTidy() {
    const [terms, passages, queueCount] = await Promise.all([AI.terms.list(db), AI.passages.list(db), AI.queue.count(db)]);
    const sum = AI.growth.summary(terms, passages, queueCount);
    const list = AI.growth.candidates(terms, passages);
    el.list.textContent = '';

    // 育ち
    const grow = document.createElement('li');
    grow.className = 'grow';
    const head = document.createElement('span');
    head.className = 'term';
    head.textContent = '育ち';
    const stats = document.createElement('p');
    stats.className = 'def';
    stats.textContent =
      `単語 ${sum.terms} ・ 文章 ${sum.passages} ・ 未回答 ${sum.queue}\n👍 ${sum.liked} ・ 👎 ${sum.disliked} ・ 📌 ${sum.pinned}` +
      (sum.used.length ? `\nよく使われた：${sum.used.map((u) => `${u.title}（${u.useCount}回）`).join('、')}` : '\nまだ回答に使われた知識はありません。');
    grow.append(head, document.createElement('span'), stats, growthChart(sum.points));
    el.list.appendChild(grow);

    // 整理の候補
    const h2 = document.createElement('li');
    h2.className = 'sect';
    h2.textContent = list.length ? `整理の候補 ${list.length} 件（低評価・未使用・古い順）` : '整理の候補はありません。';
    el.list.appendChild(h2);

    for (const c of list) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'term';
      title.textContent = `${c.title}`;
      const reasons = document.createElement('p');
      reasons.className = 'def';
      reasons.textContent = c.reasons.map((r) => r.text).join('\n');
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = nameOf(c.kind);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '消す';
      del.setAttribute('aria-label', `${c.title} を消す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '消す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        if (c.kind === 'term') await AI.terms.remove(db, c.id);
        else await AI.passages.remove(db, c.id);
        await render();
      });

      const row = document.createElement('div');
      row.className = 'tidy-actions';
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.textContent = '📌 残す';
      keep.addEventListener('click', async () => {
        await AI.growth.setImportance(db, c.kind, c.id, 1);
        await render();
      });
      row.appendChild(keep);
      if (c.refetch) {
        const re = document.createElement('button');
        re.type = 'button';
        re.textContent = AI.net.isOffline() ? '再取得（オンライン時）' : 'Wikipediaで再取得';
        re.disabled = AI.net.isOffline();
        re.title = '押すと、記事名がWikipediaに送られます';
        re.addEventListener('click', async () => {
          re.disabled = true;
          try {
            await refetchPassage(c);
          } catch (error) {
            addMessage('ai', `再取得できませんでした。\n${error.message}`);
            re.disabled = false;
          }
        });
        row.appendChild(re);
      }
      li.append(title, del, reasons, meta, row);
      el.list.appendChild(li);
    }
    el.empty.hidden = true;
    el.count.textContent = `${terms.length + passages.length} 件の知識`;
  }

  // ---- タブ ----
  let tab = 'terms';
  const TABS = { terms: el.tabTerms, passages: el.tabPassages, queue: el.tabQueue, tidy: el.tabTidy };
  const PLACEHOLDER = { terms: '記憶を探す', passages: '文章を探す', queue: '', tidy: '' };
  function setTab(next) {
    tab = next;
    for (const [name, button] of Object.entries(TABS)) button.setAttribute('aria-selected', String(tab === name));
    el.search.placeholder = PLACEHOLDER[tab];
    el.search.hidden = tab === 'queue' || tab === 'tidy'; // 未回答・整理は検索欄を出さない
    el.search.value = '';
    return render();
  }
  // 「未回答」タブに件数を出す（気づけるように）
  async function updateBadge() {
    const n = await AI.queue.count(db);
    el.tabQueue.textContent = n ? `未回答 ${n}` : '未回答';
  }
  async function render() {
    if (!db) return;
    if (tab === 'terms') await renderTerms();
    else if (tab === 'passages') await renderPassages();
    else if (tab === 'tidy') await renderTidy();
    else await renderQueue();
    await updateBadge();
  }
  el.tabTerms.addEventListener('click', () => setTab('terms'));
  el.tabPassages.addEventListener('click', () => setTab('passages'));
  el.tabQueue.addEventListener('click', () => setTab('queue'));
  el.tabTidy.addEventListener('click', () => setTab('tidy'));
  el.search.addEventListener('input', render);

  fitInput();
})();
