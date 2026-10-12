import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { initializeDictionary, dictionaryMatches, searchKnowledge, parseDictionaryImport } from '../js/knowledge.mjs';
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
for (const file of ['normalize', 'db', 'terms', 'passages', 'vectors', 'hybrid', 'rag', 'net']) vm.runInThisContext(readFileSync(`js/${file}.js`, 'utf8'));

test('dictionary initialization preserves user definitions and deleted entries; retrieved text remains readable', async () => {
  const db = await AI.db.open();
  await AI.terms.add(db, '文脈', '私が書いた説明');
  await initializeDictionary(db);
  assert.equal((await dictionaryMatches(db, '文脈って何？'))[0].definition, '私が書いた説明');
  await AI.terms.remove(db, '光合成');
  await initializeDictionary(db);
  assert.equal((await dictionaryMatches(db, '光合成とは')).length, 0);
  const doc = await AI.passages.add(db, 'ガラス星は青い星です。', {title: '創作資料'});
  const result = await searchKnowledge(db, 'ガラス星');
  assert.ok(result.notes.some(n => n.includes('青い星')));
  const provider = { id: 'test', version: 1, dim: 2, ready: true, embed: async () => [new Float32Array([1, 0])] };
  await AI.vectors.indexPassage(db, doc.record || doc, provider);
  const semantic = await searchKnowledge(db, '未知の言い換え', provider);
  assert.ok(semantic.hits.some(h => h.via.includes('semantic')));
  assert.ok(semantic.notes.some(n => n.includes('青い星')));
  const mismatch = await searchKnowledge(db, '未知の言い換え', {...provider, version: 2});
  assert.equal(mismatch.hits.length, 0);
  db.close();
});
test('imports validate every row before writing and keep definitions as plain text', () => {
  assert.deepEqual(parseDictionaryImport([{term: '猫', definition: '動物'}])[0], {term: '猫', definition: '動物', sources: []});
  assert.throws(() => parseDictionaryImport([{term: '猫', definition: '動物'}, {term: '空'}]));
  assert.throws(() => parseDictionaryImport({hello: 'world'}));
});
test('offline switch prevents fetch before it is attempted and persists across reload', async () => {
  const db = await AI.db.open(); let calls = 0;
  await AI.net.setOffline(db, true);
  await assert.rejects(AI.net.fetch('https://example.test', {}, () => { calls++; }), /オフライン/);
  assert.equal(calls, 0); await AI.net.load(db); assert.equal(AI.net.isOffline(), true);
  await AI.net.setOffline(db, false);
  await AI.net.fetch('https://example.test', {}, async () => { calls++; return new Response('ok'); });
  assert.equal(calls, 1); db.close();
});
