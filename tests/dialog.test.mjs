// 会話の前処理（端末の情報・訂正・履歴の選び方・複数の依頼）のテスト。
// 例文はこのテストのために書いたもので、利用者の会話履歴は含めない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceAnswer, isCorrection, isUserFact, selectHistory, applyCorrection, splitRequests, classify } from '../js/dialog.mjs';
import { buildConversation, PROFILES } from '../js/conversation-core.mjs';

const now = new Date(2026, 9, 13, 7, 5);

test('時刻・日付・通信状態は端末の情報で答える。意味の質問や相談は対象外', () => {
  assert.match(deviceAnswer('今は何時？', { now }).text, /7時05分/);
  assert.match(deviceAnswer('今何時', { now }).text, /7時05分/);
  assert.match(deviceAnswer('今日は何日？', { now }).text, /2026年10月13日（火）/);
  assert.match(deviceAnswer('何曜日？', { now }).text, /火/);
  assert.match(deviceAnswer('これはオンライン？', { now, offline: true }).text, /オフラインモード/);
  assert.match(deviceAnswer('ネットつながってる？', { now, offline: false, online: true }).text, /外部取得を許可/);
  assert.match(deviceAnswer('今オンライン？', { now, offline: false, online: false }).text, /つながっていない/);
  for (const q of ['何時に寝ればいい？', 'オンラインとは？', '時間って何？', '時刻の意味は？', '明日の予定を教えて']) assert.equal(deviceAnswer(q, { now }), null, q);
});

test('訂正・否定を見分ける。ふつうの質問は訂正ではない', () => {
  for (const q of ['違う', 'いや、そうじゃない', 'ちがいます。正しくは佐藤です', '意味わからない', 'それは関係ないよ', '猫じゃなくて犬です']) assert.ok(isCorrection(q), q);
  for (const q of ['違いは何？', 'こんにちは', '時間って何？']) assert.ok(!isCorrection(q), q);
});

test('利用者自身についての発言を事実として扱う。質問は含めない', () => {
  assert.ok(isUserFact('私の名前は佐藤です'));
  assert.ok(isUserFact('僕は大学生です。'));
  assert.ok(!isUserFact('私の名前は何？'));
  assert.ok(!isUserFact('私の名前を覚えてる？'));
});

test('用語の意味を聞くときは、過去の答えを渡さない（言い回しを写させない）', () => {
  const history = [{ q: '時間って何？', a: '時間とは、時間の流れを指す。' }];
  assert.equal(selectHistory('状態って？', history).past.length, 0);
  assert.equal(selectHistory('無駄な時間とは？', history).past.length, 0);
});

test('話題が変わったら、関係のない答えを渡さない。続きの質問・相づちには直前だけ渡す', () => {
  const history = [
    { q: '猫を飼うには何が必要？', a: 'えさ、水、トイレ、爪とぎが必要です。' },
    { q: 'ゲームでおすすめのジャンルは？', a: 'パズルやアクションが人気です。' },
  ];
  assert.equal(selectHistory('扇風機の掃除のしかたは？', history).past.length, 0);
  assert.deepEqual(selectHistory('それって初心者向け？', history).past.map((p) => p.q), ['ゲームでおすすめのジャンルは？']);
  assert.deepEqual(selectHistory('なるほど', history).past.map((p) => p.q), ['ゲームでおすすめのジャンルは？']);
  assert.deepEqual(selectHistory('猫のトイレは何を選べばいい？', history).past.map((p) => p.q), ['猫を飼うには何が必要？']);
});

test('否定された答えは、以後の根拠から外す。訂正は最優先の事実として残す', () => {
  const history = [{ q: '私の名前は田中です', a: 'よろしくお願いします、田中さん。' }, { q: 'ゲームとは？', a: 'ゲームとは扇風機の一種です。' }];
  applyCorrection(history, '違う');
  assert.equal(history[1].rejected, true);
  assert.equal(selectHistory('それって何？', history).past.length, 0, '直前が否定されていれば、続きとしても渡さない');
  history.push({ q: '違います。正しくは佐藤です', a: '佐藤さんですね。', correction: true });
  const { facts, past } = selectHistory('私の名前を覚えてる？', history);
  assert.deepEqual(facts, ['私の名前は田中です', '違います。正しくは佐藤です']);
  assert.ok(!past.some((p) => p.rejected));
  const messages = buildConversation('私の名前を覚えてる？', history, [], PROFILES.mobile);
  assert.match(messages[0].content, /最優先/);
  assert.match(messages[0].content, /正しくは佐藤です/);
  assert.ok(!messages.some((m) => m.content.includes('扇風機の一種')), '否定された答えはモデルに渡さない');
});

test('端末の情報・辞書・フレーズの答えは、モデルの文脈に入れない', () => {
  const history = [{ q: '今は何時？', a: 'いまは7時05分です', source: 'device' }, { q: 'オフラインとは？', a: 'ネットにつながない状態。', source: 'dictionary' }];
  assert.equal(selectHistory('さっき何て言った？', history).past.length, 0);
});

test('1回の送信の複数の依頼を分ける（用語の意味／おすすめ）', () => {
  assert.deepEqual(splitRequests('いわゆるってどうゆう意味？あと、扇風機ってどのメーカーがおすすめ？').map((p) => [p.kind, p.term || p.topic]), [['define', 'いわゆる'], ['recommend', '扇風機']]);
  assert.deepEqual(splitRequests('いわゆるの意味と扇風機のおすすめ').map((p) => [p.kind, p.term || p.topic]), [['define', 'いわゆる'], ['recommend', '扇風機']]);
  assert.deepEqual(splitRequests('光合成とは？').map((p) => p.kind), ['define']);
  assert.deepEqual(splitRequests('こんにちは').map((p) => p.kind), ['chat']);
  assert.equal(classify('おすすめの扇風機は？').kind, 'recommend');
  assert.equal(classify('死ぬとは何？').term, '死ぬ');
});
