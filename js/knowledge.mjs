// A small, locally authored starter dictionary. This is not a full Japanese dictionary.
export const STARTER_TERMS = [
  ['辞書', '言葉と、その意味や使い方をまとめたもの。'],
  ['文脈', '前後の文章や会話の流れ。言葉が何を指すかを理解する手がかりになる。'],
  ['固有名詞', '特定の人・場所・組織などにつけられた名前。'],
  ['比喩', 'ある物事を別の物事にたとえて表すこと。'],
  ['要約', '文章や話の大切な点を、短くまとめること。'],
  ['推測', '分かっていることを手がかりに、まだ確かめられていないことを考えること。'],
  ['根拠', '判断や説明のよりどころとなる事実や理由。'],
  ['出典', '引用や情報の元になった本・記事・資料など。'],
  ['オフライン', 'ネットワークに接続せず、端末にある情報や機能を使う状態。'],
  ['オンライン', 'ネットワークに接続して、外部の情報やサービスを利用できる状態。'],
  ['ベクトル検索', '文章などを数値の並びで表し、数値的な近さから関連する情報を探す方法。元の本文も一緒に保存する必要がある。'],
  ['光合成', '植物などが光のエネルギーを利用して、二酸化炭素などから有機物を作る働き。植物の光合成では酸素も放出される。'],
];

export async function initializeDictionary(db) {
  const AI = globalThis.AI;
  const row = await AI.db.tx(db, 'settings', 'readonly', t => AI.db.rq(t.objectStore('settings').get('starter-dictionary-v1')));
  if (row) return;
  for (const [term, definition] of STARTER_TERMS) await AI.terms.add(db, term, definition, {
    onConflict: 'ignore', source: { title: 'ai Safari 内蔵基礎辞書' },
  });
  await AI.db.tx(db, 'settings', 'readwrite', t => AI.db.rq(t.objectStore('settings').put({ name: 'starter-dictionary-v1', value: true })));
}

export function definitionQuery(query) {
  return String(query).normalize('NFKC').trim().replace(/[?？!！。\s]+$/gu, '')
    .replace(/(?:とは何ですか|とはなに|とは|って何|ってなに|の意味を教えて|の意味は|の意味)$/u, '')
    .replace(/^[「『]|[」』]$/gu, '').trim();
}

export async function dictionaryMatches(db, query) {
  const AI = globalThis.AI;
  const exact = AI.normalizeTerm(definitionQuery(query));
  const q = AI.normalizeTerm(query);
  return (await AI.terms.list(db)).filter(t => t.definition && (t.key === exact || (t.key.length >= 2 && q.includes(t.key))))
    .sort((a, b) => Number(b.key === exact) - Number(a.key === exact) || b.key.length - a.key.length).slice(0, 3);
}

export async function searchKnowledge(db, query, provider) {
  const AI = globalThis.AI;
  const terms = await dictionaryMatches(db, query);
  const hits = await AI.hybrid.search(db, query, { provider, mode: provider?.ready ? 'hybrid' : 'keyword', limit: 3, minSemantic: 0.78 });
  const notes = terms.map(t => `辞書「${t.term}」: ${t.definition}\n出典: ${t.sources?.map(s => s.title || s.url).filter(Boolean).join('、') || '利用者が保存'}`);
  for (const hit of hits) notes.push(`資料「${hit.passage.title}」: ${AI.rag.excerpt(hit.snippet || hit.passage.body, query, 300)}\n出典: ${hit.passage.sourceUrl || '利用者が保存'}`);
  return { terms, hits, notes, semanticError: hits.semanticError };
}

export function parseDictionaryImport(value) {
  const rows = Array.isArray(value) ? value : value?.terms;
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('辞書は term と definition を持つ配列（最大5000件）にしてください。');
  return rows.map(row => {
    if (typeof row?.term !== 'string' || !row.term.trim() || row.term.length > 200 || typeof row.definition !== 'string' || !row.definition.trim() || row.definition.length > 10000) throw new Error('用語または説明が空か、長すぎる項目があります。');
    return { term: row.term.trim(), definition: row.definition.trim(), sources: Array.isArray(row.sources) ? row.sources.filter(s => s && typeof s.title === 'string' && (!s.url || /^https?:\/\//.test(s.url))) : [] };
  });
}
