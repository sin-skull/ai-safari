import { initializeDictionary, searchKnowledge, parseDictionaryImport } from './knowledge.mjs';

export function createKnowledgeUI({ getDB, action, unload, acquireLock, releaseLock, setStatus }) {
  const $ = id => document.getElementById(id);
  const provider = AI.embed.transformersProvider(AI.embed.PACKS[0]);
  let stopped = false, releaseFailed = false;
  async function refresh() {
    const state = await AI.vectors.status(getDB(), provider);
    $('knowledge-status').textContent = `辞書 ${await AI.terms.count(getDB())}件 · 保存文章 ${state.total}件 · この意味検索モデルの索引 ${state.indexed}件。内蔵辞書は基礎17語です（総合辞書ではありません）。`;
  }
  async function semantic(work) {
    if (releaseFailed) throw new Error('意味検索モデルを解放できませんでした。アプリを更新・再起動してください。');
    await unload();
    await acquireLock();
    try {
      setStatus('意味検索モデルを準備しています… 初回は約120MBを取得します。');
      await provider.prepare(info => setStatus(`意味検索を準備中… ${info.label}${info.total ? ' ' + Math.round(info.loaded / info.total * 100) + '%' : ''}`));
      return await work(provider);
    } finally {
      try { await provider.unload(); }
      catch (error) { releaseFailed = true; throw error; }
      // Never release ownership or load a second model if disposal failed.
      releaseLock();
    }
  }
  function card(title, body, source) {
    const box = document.createElement('article');
    const heading = document.createElement('strong'); heading.textContent = title;
    const text = document.createElement('p'); text.textContent = body;
    box.append(heading, text);
    if (source) {
      const note = document.createElement('small'); note.textContent = source; box.append(note);
    }
    $('knowledge-results').append(box);
    return box;
  }
  $('dictionary-form').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      await AI.terms.add(getDB(), $('dictionary-term').value, $('dictionary-definition').value, { onConflict: 'overwrite', source: { title: '利用者が記入' } });
      $('dictionary-form').reset(); await refresh(); setStatus('辞書に保存しました。用語の意味を会話欄でも質問できます。');
    });
  });
  $('dictionary-file').addEventListener('change', () => action(async () => {
    const file = $('dictionary-file').files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error('辞書ファイルは10MB以下にしてください。');
    const rows = parseDictionaryImport(JSON.parse(await file.text()));
    for (const row of rows) await AI.terms.add(getDB(), row.term, row.definition, { onConflict: 'ignore', source: row.sources[0] || { title: file.name } });
    $('dictionary-file').value = ''; await refresh(); setStatus(`${rows.length}件を読み込みました。同じ用語は現在の説明を残しています。`);
  }));
  $('knowledge-search-form').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      const result = await retrieve($('knowledge-query').value);
      $('knowledge-results').replaceChildren();
      for (const term of result.terms) card(term.term, term.definition, term.sources.map(s => s.title || s.url).join(' · '));
      for (const hit of result.hits) card(hit.passage.title, hit.snippet || hit.passage.body, hit.passage.sourceUrl || '端末に保存した資料');
      if (!result.terms.length && !result.hits.length) card('見つかりませんでした', '辞書や参考資料を追加してみてください。');
      setStatus(result.semanticError ? '意味検索に失敗したため、言葉の一致で調べました。' : '端末内の検索が終わりました。');
    });
  });
  $('web-search').addEventListener('click', () => action(async () => {
    if (AI.net.isOffline()) throw new Error('Wikipedia検索にはオンラインモードが必要です。');
    const query = $('knowledge-query').value.trim();
    if (!query) throw new Error('調べる言葉を入力してください。');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    let rows;
    try { rows = await AI.wiki.search(query, { signal: controller.signal, limit: 3 }); }
    finally { clearTimeout(timer); }
    $('knowledge-results').replaceChildren();
    for (const row of rows) {
      const box = card(row.title, row.extract, 'Wikipedia · CC BY-SA');
      if (/^https:\/\//.test(row.url)) {
        const link = document.createElement('a'); link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '出典を開く ↗'; box.append(link);
      }
      const save = document.createElement('button'); save.type = 'button'; save.textContent = '辞書・資料に保存';
      save.addEventListener('click', () => action(async () => {
        await AI.terms.add(getDB(), row.title, row.extract, { onConflict: 'ignore', source: { title: row.title, url: row.url, license: 'CC BY-SA' } });
        await AI.passages.add(getDB(), row.extract, { title: row.title, sourceUrl: row.url, license: 'CC BY-SA' });
        save.disabled = true; save.textContent = '保存しました'; await refresh();
      }));
      box.append(save);
    }
    setStatus(rows.length ? '選んだ情報を保存すると、オフラインでも参照できます。' : '見つかりませんでした。');
  }));
  $('semantic-index').addEventListener('click', () => action(async () => {
    stopped = false; $('semantic-stop').hidden = false;
    try {
      const count = await semantic(p => AI.vectors.reindex(getDB(), p, {
        shouldStop: () => stopped,
        onProgress: ({ done, total }) => setStatus(`索引を作成中… ${done} / ${total}件`),
      }));
      await refresh(); setStatus(`${count}件の索引を保存しました。${stopped ? '停止しました。' : ''}会話は「会話を準備」で再開できます。`);
    } finally { $('semantic-stop').hidden = true; }
  }));
  $('semantic-stop').addEventListener('click', () => { stopped = true; setStatus('実行中の読み込み・文章の処理が終わったところで停止します。'); });
  async function retrieve(query) {
    if (!$('semantic-use').checked) return searchKnowledge(getDB(), query);
    const state = await AI.vectors.status(getDB(), provider);
    if (!state.indexed) {
      $('knowledge-status').textContent = 'このモデルの索引がありません。言葉の一致で検索します。必要なら「索引化」を押してください。';
      return searchKnowledge(getDB(), query);
    }
    try { return await semantic(p => searchKnowledge(getDB(), query, p)); }
    catch (error) {
      if (releaseFailed) throw error;
      $('knowledge-status').textContent = '意味検索を利用できないため、言葉の一致で検索します。' + error.message;
      const result = await searchKnowledge(getDB(), query); result.semanticError = error; return result;
    }
  }
  return {
    retrieve,
    assertReleased() { if (releaseFailed) throw new Error('意味検索モデルの解放に失敗しました。アプリを再起動してください。'); },
    async initialize() { await initializeDictionary(getDB()); await refresh(); },
    render(active) {
      for (const id of ['dictionary-save', 'dictionary-file', 'knowledge-search', 'semantic-index', 'semantic-use']) $(id).disabled = !getDB() || active;
      $('web-search').disabled = !getDB() || active || AI.net.isOffline() || navigator.onLine === false;
    },
  };
}
