import { PROFILES, ConversationEngine, buildConversation } from './conversation-core.mjs';
import { NamespacedOPFSBackend } from '../lab/storage.js';
import { configureRuntime } from './runtime-compat.mjs';

const VERSION = '0.12.7';
const $ = (id) => document.getElementById(id);
const KEY = 'ai-safari-conversation';
const STEP = KEY + '-step';
const DB_KEY = 'conversation-v1';
const storage = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
};
let db, history = [], pending = false, lockRelease = null, cacheManager, lib;
let events = storage.read(KEY + '-events', []);
if (!Array.isArray(events)) events = [];
const previousStep = storage.read(STEP, null);
const log = (event, extra = {}) => {
  events = [...events, { at: new Date().toISOString(), event, ...extra }].slice(-30);
  storage.write(KEY + '-events', events); // No prompts or answers in diagnostics.
};
const setStatus = (text) => { $('status').textContent = text; };
const selected = () => PROFILES[$('profile').value];
const asset = (path) => new URL(path, import.meta.url).href;
async function vendor() {
  lib ||= await import('../lab/vendor/wllama-3.6.1/index.js');
  cacheManager ||= new lib.CacheManager([new NamespacedOPFSBackend('ai-safari-conversation-models')]);
  return lib;
}
async function factory() {
  await vendor();
  const w = new lib.Wllama({ default: asset('../lab/vendor/wllama-3.6.1/wasm/wllama.wasm') }, {
    cacheManager, allowOffline: true, parallelDownloads: 1, logger: lib.LoggerWithoutDebug,
  });
  w.setCompat({ worker: asset('../lab/vendor/wllama-compat-3.6.1/wasm/wllama.js'), wasm: asset('../lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm') });
  // A complete saved model is opened directly. No HEAD request to Hugging Face
  // is needed to use it, even if navigator.onLine incorrectly reports true.
  return {
    async loadModelFromUrl(url, options) {
      let model = (await w.modelManager.getModels()).find((m) => m.url === url);
      if (!model) {
        if (navigator.onLine === false) throw new Error('このモデルはまだ保存されていません。オンラインで一度準備してください。');
        model = await w.modelManager.downloadModel(url, options);
      }
      setStatus('保存済みモデルをメモリに読み込んでいます…');
      $('progress').hidden = true;
      configureRuntime(w, { worker: asset('../lab/vendor/wllama-compat-3.6.1/wasm/wllama.js'), wasm: asset('../lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm') }, options.n_gpu_layers === 0);
      await w.loadModel(await model.open(), options);
    },
    createChatCompletion: (options) => w.createChatCompletion(options),
    exit: () => w.exit(),
  };
}
const engine = new ConversationEngine(factory, (state) => {
  storage.write(STEP, ['loading', 'generating', 'unloading'].includes(state) ? { state, profile: $('profile').value, at: Date.now() } : null);
  log(state, { profile: $('profile').value });
  if (state === 'generating') setStatus('答えを作っています…');
  if (state === 'idle') setStatus('待機中です。「会話を準備」で再開できます。');
  renderControls();
});

function renderControls() {
  const active = pending || ['loading', 'generating', 'unloading'].includes(engine.state);
  $('prepare').disabled = !db || active || engine.state === 'ready';
  $('profile').disabled = !db || active;
  $('release').disabled = active || !engine.worker;
  $('send').disabled = !db || active || engine.state !== 'ready';
  $('input').disabled = !db || active || engine.state !== 'ready';
  $('new-chat').disabled = !db || active;
  $('export-chat').disabled = !db || active;
  $('diagnostics').disabled = !db;
  $('delete-models').disabled = !db || active;
  $('stop').hidden = engine.state !== 'generating';
  $('connection').textContent = navigator.onLine === false ? 'オフライン' : '端末内で会話';
  const p = selected();
  $('model-note').textContent = $('profile').value !== 'pc'
    ? `CPUで省メモリ動作。初回約${p.mb}MBを取得します。${p.license}。`
    : `WebGPUを使用。初回約${p.mb}MBを取得します。${p.license}。`;
  if ($('profile').value === 'tiny') $('model-note').textContent += ' 日本語の品質は低めです。会話にはスマホ用を選んでください。';
}
function releaseLock() { lockRelease?.(); lockRelease = null; }
async function acquireLock() {
  if (lockRelease) return;
  if (!navigator.locks) throw new Error('このSafariではタブ間の安全な実行管理を利用できません。Safariを更新してください。');
  await new Promise((resolve, reject) => {
    navigator.locks.request('ai-safari-inference', { ifAvailable: true }, async (lock) => {
      if (!lock) return reject(new Error('別のai Safariタブがモデルを使っています。そのタブでメモリを解放するか、閉じてください。'));
      await new Promise((done) => { lockRelease = done; resolve(); });
    }).catch(reject);
  });
}
async function action(work) {
  if (pending) return;
  pending = true;
  renderControls();
  try { await work(); }
  catch (error) { setStatus(error.message); log('error', { message: String(error.message).slice(0, 250) }); }
  finally { pending = false; $('progress').hidden = true; renderControls(); }
}
async function unload() {
  await engine.unload();
  releaseLock();
  setStatus('メモリを解放しました。保存したモデルは残っています。');
}
async function saveHistory() {
  history = history.slice(-40);
  await AI.db.tx(db, 'settings', 'readwrite', (t) => AI.db.rq(t.objectStore('settings').put({ name: DB_KEY, value: history })));
}
function append(role, text, note = '') {
  $('welcome').hidden = true;
  const box = document.createElement('article');
  box.className = 'message ' + role;
  const label = document.createElement('div'); label.className = 'speaker'; label.textContent = role === 'user' ? 'YOU' : 'AI';
  const body = document.createElement('div'); body.className = 'text'; body.textContent = text;
  const sub = document.createElement('small'); sub.textContent = note;
  box.append(label, body, sub);
  if (role === 'user') {
    const button = document.createElement('button'); button.className = 'remember'; button.textContent = 'この発言を記憶に保存';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await AI.passages.add(db, text, { title: text.slice(0, 30) }); button.textContent = '保存しました'; }
      catch (error) { setStatus(error.message); button.disabled = false; }
    });
    box.append(button);
  }
  $('messages').append(box);
  // Keep the DOM bounded as well as the prompt and persisted transcript.
  while ($('messages').children.length > 80) $('messages').firstElementChild.remove();
  return { body, sub };
}
function showHistory() {
  $('messages').replaceChildren();
  $('welcome').hidden = !!history.length;
  for (const h of history) {
    append('user', h.q);
    if (h.a) append('assistant', h.a, h.interrupted ? '途中で停止' : '');
  }
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('prepare').addEventListener('click', () => action(async () => {
  if ($('profile').value === 'pc') {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPUを使えません。スマホ用モデルを選んでください。');
  }
  await acquireLock();
  try {
    await navigator.storage?.persist?.().catch(() => false);
    setStatus('モデルを確認しています。初回はダウンロードします…');
    const start = performance.now();
    await engine.load(selected(), ({ loaded, total }) => {
      $('progress').hidden = false;
      if (total) $('progress').value = Math.min(100, loaded / total * 100);
      else $('progress').removeAttribute('value');
      setStatus(`モデルを保存中… ${Math.round(loaded / 1048576)}${total ? ' / ' + Math.round(total / 1048576) : ''} MB`);
    });
    log('load-complete', { seconds: Math.round((performance.now() - start) / 1000) });
    if (document.hidden) { await unload(); return; }
    setStatus('会話できます。モデルは端末に保存済みです。');
  } catch (error) { if (!engine.worker) releaseLock(); throw error; }
}));
$('release').addEventListener('click', () => action(unload));
$('delete-models').addEventListener('click', () => action(async () => {
  if (!window.confirm('この会話画面で取得したモデルを削除しますか？ 会話と記憶は残ります。次回は再ダウンロードが必要です。')) return;
  await unload();
  await acquireLock();
  try { await vendor(); await cacheManager.clear(); setStatus('会話用モデルを削除しました。'); }
  finally { releaseLock(); }
}));
$('profile').addEventListener('change', () => action(async () => {
  await unload();
  storage.write(KEY + '-profile', $('profile').value);
  setStatus('モデルを切り替えました。「会話を準備」を押してください。');
}));
$('stop').addEventListener('click', () => { engine.stop(); setStatus('停止しています…'); });
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (engine.state !== 'ready' || !$('input').value.trim()) return;
  action(async () => {
    const query = $('input').value.trim();
    const hits = await AI.passages.search(db, query, { limit: 2 }); // lexical lookup, no embedding model
    const memories = hits.map((h) => h.passage.body);
    const messages = buildConversation(query, history, memories, selected());
    $('input').value = '';
    append('user', query);
    const reply = append('assistant', '考えています…');
    window.scrollTo(0, document.documentElement.scrollHeight);
    const pair = { q: query, a: '', interrupted: true, at: Date.now() };
    history.push(pair);
    try { await saveHistory(); }
    catch (error) { history.pop(); $('input').value = query; reply.body.textContent = '会話を保存できませんでした。'; throw error; }
    const start = performance.now(); let first = null;
    try {
      const result = await engine.generate(messages, (text) => {
        if (text && first === null) first = performance.now();
        const atEnd = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 260;
        reply.body.textContent = text || '考えています…';
        if (atEnd) window.scrollTo(0, document.documentElement.scrollHeight);
      });
      pair.a = result.text;
      pair.interrupted = result.interrupted;
      reply.body.textContent = result.text || (result.interrupted ? '停止しました。' : '答えが空でした。言い方を変えて試してください。');
      const seconds = ((performance.now() - start) / 1000).toFixed(1);
      reply.sub.textContent = `${result.interrupted ? '途中で停止 · ' : ''}${seconds}秒${memories.length ? ' · 保存メモを参照（内容は記憶画面で確認できます）' : ''}`;
      log('reply-complete', { seconds: Number(seconds), firstSeconds: first === null ? null : (first - start) / 1000, chars: result.text.length, interrupted: result.interrupted });
      setStatus(result.interrupted ? '停止してメモリを解放しました。「会話を準備」で再開できます。' : '会話できます。');
    } catch (error) { reply.body.textContent = '回答を作れませんでした。' + error.message; throw error; }
    finally { await saveHistory(); if (!engine.worker) releaseLock(); }
  });
});
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('new-chat').addEventListener('click', () => action(async () => {
  if (!window.confirm('この端末の現在の会話履歴を消しますか？ 必要なら先に書き出してください。記憶に保存した内容は残ります。')) return;
  history = []; await saveHistory(); showHistory();
}));
$('export-chat').addEventListener('click', () => download('ai-safari-conversation.json', { format: 'ai-safari-conversation', version: 1, history }));
$('diagnostics').addEventListener('click', () => download('ai-safari-diagnostics.json', { version: VERSION, userAgent: navigator.userAgent, profile: $('profile').value, events }));
for (const id of ['memory-link', 'lab-link']) $(id).addEventListener('click', (event) => {
  event.preventDefault();
  const href = $(id).href;
  if (pending) { setStatus('処理を止めてから移動してください。'); return; }
  action(async () => { await unload(); location.href = href; });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  engine.stop();
  // Serial release happens after an in-flight generation; never during WASM use.
  if (engine.state === 'ready' || engine.state === 'generating') engine.unload().then(releaseLock).catch(() => {});
});
window.addEventListener('online', renderControls);
window.addEventListener('offline', renderControls);
window.addEventListener('pageshow', () => {
  if (db && engine.state === 'idle') setStatus('「会話を準備」を押してください。保存済みモデルから再開します。');
});

async function prepareOffline() {
  if (!navigator.serviceWorker) throw new Error('このブラウザはオフライン起動に対応していません。');
  const reg = await navigator.serviceWorker.register('sw.js');
  const showReady = async () => {
    if (await caches.has('ai-safari-app-' + VERSION)) {
      const cache = await caches.open('ai-safari-app-' + VERSION);
      if (await cache.match(new URL('../lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm', import.meta.url))) {
        $('offline').textContent = '画面と実行用ファイルを保存済み。モデル準備後、機内モードで再起動を試してください。';
      }
    }
  };
  const watch = (worker) => worker?.addEventListener('statechange', () => {
    if (worker.state === 'activated') showReady();
    if (worker.state === 'redundant') $('offline').textContent = 'オフライン用ファイルの保存に失敗しました。オンラインで再読み込みしてください。';
  });
  watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
  if (reg.active) await showReady();
}
try {
  db = await AI.db.open();
  const row = await AI.db.tx(db, 'settings', 'readonly', (t) => AI.db.rq(t.objectStore('settings').get(DB_KEY)));
  history = (Array.isArray(row?.value) ? row.value : []).filter((h) => typeof h?.q === 'string' && typeof h?.a === 'string').slice(-40);
  const profile = storage.read(KEY + '-profile', 'mobile');
  $('profile').value = PROFILES[profile] ? profile : 'mobile';
  showHistory(); renderControls();
  const locks = await navigator.locks?.query?.().catch(() => null);
  const anotherTab = locks?.held?.some((lock) => lock.name === 'ai-safari-inference');
  setStatus(anotherTab ? '別のタブでモデルが動いています。そちらでメモリを解放してから準備してください。' : previousStep ? '前回の処理が途中で終了しました。自動再実行はせず待機しています。スマホ用で「会話を準備」を試してください。' : '「会話を準備」を押すと、選んだモデルを用意します。');
  if (!anotherTab) {
    if (previousStep) log('previous-interruption', previousStep);
    storage.write(STEP, null);
  }
} catch (error) { setStatus('保存領域を開けませんでした。' + error.message); }
prepareOffline().catch((error) => { $('offline').textContent = 'オフライン起動の準備ができませんでした。' + error.message; });
