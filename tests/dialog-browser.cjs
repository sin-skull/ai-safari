// 会話画面の前処理の確認：端末の情報で答える・訂正で前の答えを外す・複数の依頼を分ける・おすすめは条件を聞く。
// モデルは制御できるテスト用の偽物（回答の品質の試験ではない）。渡したメッセージを window.testMessages に残す。
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const modelFixture = `
import {PROFILES} from '/js/conversation-core.mjs';
export const LoggerWithoutDebug = {};
export class CacheManager {}
export class Wllama {
 constructor(){this.modelManager={getModels:async()=>[{url:PROFILES.mobile.url,open:async()=>[]}]} }
 setCompat(){} async loadModel(){} async exit(){}
 async *createChatCompletion(options){
  window.testMessages=options.messages; window.testCalls=(window.testCalls||0)+1;
  yield {choices:[{delta:{content:window.nextAnswer||'テストの答えです。'}}]};
 }
}`;
(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      const body = pathname === '/lab/vendor/wllama-3.6.1/index.js' ? modelFixture : await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    const chrome = process.env.BROWSER_ENGINE === 'chromium';
    browser = await (chrome ? pw.chromium : pw.webkit).launch({});
    const page = await browser.newPage({ ...pw.devices['iPhone 13'] });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/');
    await page.waitForFunction(() => !document.querySelector('#new-chat-top').disabled);
    const send = async (text) => {
      const before = await page.locator('#messages .message.assistant').count();
      await page.locator('#input').fill(text);
      await page.locator('#send').click();
      await page.waitForFunction((n) => document.querySelectorAll('#messages .message.assistant').length > n && !document.querySelector('#send').disabled, before);
      return page.locator('#messages .message.assistant').last().innerText();
    };
    const calls = () => page.evaluate(() => window.testCalls || 0);

    // 1. 時刻・通信状態：モデルを準備していなくても答える
    assert.match(await send('今は何時？'), /時\d\d分です（この端末の時計/);
    assert.match(await send('これはオンライン？'), /外部取得|オフライン/);
    assert.equal(await calls(), 0, 'モデルは使わない');

    // 3. 複数の依頼：用語は辞書、おすすめは条件を聞く（モデルなし）
    const multi = await send('いわゆるってどうゆう意味？あと、扇風機ってどのメーカーがおすすめ？');
    assert.match(multi, /「いわゆる」：世間で一般に/);
    assert.match(multi, /扇風機のおすすめですね。条件を教えてください/);
    assert.equal(await calls(), 0);

    // おすすめの条件を答える → 送信だけで準備してから、商品名を作らせない指示つきでモデルへ
    await send('6畳の寝室で、静かなのがいい。予算は1万円');
    const sys = await page.evaluate(() => window.testMessages[0].content);
    assert.match(sys, /「扇風機」のおすすめ/);
    assert.match(sys, /作らない/);

    // 2. 誤った答え → 否定 → 以後の文脈から外す
    await page.evaluate(() => { window.nextAnswer = 'ゲームとは扇風機の一種です。'; });
    await send('ゲームとは？');
    const neg = await send('違う、意味わからない');
    assert.match(neg, /前の答えは間違っていました/);
    assert.ok((await page.locator('#messages .message.rejected').count()) >= 1, '取り消した答えを薄く表示');
    await page.evaluate(() => { window.nextAnswer = 'はい。'; });
    await send('それってどういうこと？');
    const msgs = await page.evaluate(() => window.testMessages.map((m) => m.content).join('\n'));
    assert.ok(!msgs.includes('扇風機の一種'), '否定された答えはモデルに渡さない');

    // 訂正の内容は最優先の事実として渡す
    await send('私の名前は田中です');
    await send('違います。正しくは佐藤です');
    await send('私の名前を覚えてる？');
    const sys2 = await page.evaluate(() => window.testMessages[0].content);
    assert.match(sys2, /最優先/);
    assert.match(sys2, /正しくは佐藤です/);

    // 話題が変わったら、関係のない過去の答えを渡さない
    await send('扇風機の掃除のしかたは？');
    const msgs3 = await page.evaluate(() => window.testMessages);
    assert.equal(msgs3.length, 2, 'system と今の質問だけ');

    // 再読み込みしても、取り消しの印は残る
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#new-chat-top').disabled);
    assert.ok((await page.locator('#messages .message.rejected').count()) >= 1);
    assert.deepEqual(errors, []);
    console.log('PASS: 端末の情報で答える、複数の依頼を分ける、おすすめは条件を聞く、否定された答えを外す、訂正を最優先、話題の切り替え、再読み込み後も保持。');
  } finally {
    await browser?.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
