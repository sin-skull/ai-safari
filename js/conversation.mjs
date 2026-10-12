import { PROFILES, ConversationEngine, buildConversation, withReplyPreferences } from './conversation-core.mjs';
import { NamespacedOPFSBackend } from '../lab/storage.js';
import { configureRuntime } from './runtime-compat.mjs';
import { PHRASE_EXAMPLE, phraseKey, findPhrase, parsePhraseTeaching } from './phrases.mjs';
import { dictionaryMatches, definitionQuery } from './knowledge.mjs';
import { createKnowledgeUI } from './knowledge-ui.mjs';
import { openChats, listChats, updateChat, selectChat, addChat, removeChat } from './chat-tabs.mjs';
import { closeMenu } from './menu.mjs';

const VERSION = '0.14.0';
const $ = (id) => document.getElementById(id);
const KEY = 'ai-safari-conversation';
const STEP = KEY + '-step';
const PHRASE_KEY = 'phrase-replies-v1';
let phrases = [];
const storage = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
};
let db, history = [], pending = false, lockRelease = null, cacheManager, lib, knowledge;
let currentChat, chats = [], draftTimer, tabsSignature = '';
let events = storage.read(KEY + '-events', []);
if (!Array.isArray(events)) events = [];
const previousStep = storage.read(STEP, null);
const log = (event, extra = {}) => {
  events = [...events, { at: new Date().toISOString(), event, ...extra }].slice(-30);
  storage.write(KEY + '-events', events); // No prompts or answers in diagnostics.
};
const setStatus = (text) => { $('status').textContent = text; $('menu-status').textContent = text; };
const selected = () => PROFILES[$('profile').value];
const replyPreferences = () => ({ tone: $('reply-tone').value, length: $('reply-length').value });
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
        if (AI.net.isOffline() || navigator.onLine === false) throw new Error('このモデルはまだ保存されていません。オンラインモードで一度準備してください。');
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
  $('reply-tone').disabled = active;
  $('reply-length').disabled = active;
  $('release').disabled = active || !engine.worker;
  $('send').disabled = !db || active;
  $('input').disabled = !db || active;
  $('new-chat').disabled = !db || active;
  $('new-chat-top').disabled = !currentChat || active;
  $('prepare-shortcut').disabled = $('prepare').disabled;
  $('prepare-shortcut').textContent = engine.state === 'ready' ? '準備できました' : '会話を準備';
  for (const id of ['rename-chat', 'delete-chat', 'export-all']) $(id).disabled = !currentChat || active;
  renderTabs(active);
  $('export-chat').disabled = !db || active;
  $('diagnostics').disabled = !db;
  $('delete-models').disabled = !db || active;
  $('stop').hidden = engine.state !== 'generating';
  $('network-mode').disabled = !db || active;
  $('network-mode').value = AI.net.isOffline() ? 'offline' : 'online';
  knowledge?.render(active);
  const mode = AI.net.isOffline() || navigator.onLine === false ? '外部取得なし' : '外部取得を許可';
  $('connection').textContent = mode;
  $('chat-mode').textContent = '端末内AI · ' + mode;
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
  knowledge?.assertReleased();
  await engine.unload();
  releaseLock();
  setStatus('メモリを解放しました。保存したモデルは残っています。');
}
async function saveHistory() {
  history = history.slice(-40);
  clearTimeout(draftTimer);
  currentChat = await updateChat(db, currentChat.id, { history, draft: $('input').value });
  await refreshChats();
}
async function refreshChats() { chats = await listChats(db); renderTabs(pending); }
function renderTabs(active) {
  if (!currentChat) return;
  $('chat-title').textContent = currentChat.title;
  const signature = JSON.stringify([currentChat.id, chats.map(c => [c.id, c.title])]);
  if (signature !== tabsSignature) {
    tabsSignature = signature;
    $('chat-tabs').replaceChildren(); $('chat-list').replaceChildren();
    for (const chat of chats) {
      for (const [container, tab] of [['chat-tabs', true], ['chat-list', false]]) {
        const button = document.createElement('button'); button.textContent = chat.title; button.title = chat.title;
        button.dataset.chatId = chat.id;
        if (tab) {
          button.id = 'tab-' + chat.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'thread');
          button.setAttribute('aria-selected', String(chat.id === currentChat.id)); button.tabIndex = chat.id === currentChat.id ? 0 : -1;
        } else if (chat.id === currentChat.id) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => switchChat(chat.id));
        $(container).append(button);
      }
    }
    $('thread').setAttribute('aria-labelledby', 'tab-' + currentChat.id);
    $('chat-name').value = currentChat.title;
  }
  document.querySelectorAll('[data-chat-id]').forEach(button => { button.disabled = active; });
}
async function flushDraft() {
  clearTimeout(draftTimer);
  if (currentChat) await updateChat(db, currentChat.id, { draft: $('input').value });
}
function activateChat(chat) {
  currentChat = chat; history = chat.history; $('input').value = chat.draft || '';
  showHistory();
  setStatus(engine.state === 'ready' ? '会話できます。' : '通常の会話は「会話を準備」から始められます。');
}
async function switchChat(id) {
  if (pending || id === currentChat?.id) return;
  await action(async () => { await flushDraft(); activateChat(await selectChat(db, id)); await refreshChats(); });
  $('tab-' + currentChat.id)?.focus();
}
$('chat-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || pending) return;
  event.preventDefault();
  const index = chats.findIndex(c => c.id === currentChat.id);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? chats.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + chats.length) % chats.length;
  switchChat(chats[next].id);
});
$('input').addEventListener('input', () => {
  clearTimeout(draftTimer);
  if (!currentChat) return;
  const id = currentChat.id, draft = $('input').value;
  draftTimer = setTimeout(() => updateChat(db, id, { draft }).catch(error => setStatus('入力文を保存できませんでした。' + error.message)), 250);
});
document.addEventListener('ai-before-update', event => { event.detail.waitUntil(flushDraft()); });
async function savePhrases(next) {
  await AI.db.tx(db, 'settings', 'readwrite', t => AI.db.rq(t.objectStore('settings').put({ name: PHRASE_KEY, value: next })));
  phrases = next;
  renderPhrases();
}
function renderPhrases() {
  $('phrase-summary').textContent = `フレーズを教える（${phrases.length}件）`;
  $('phrase-list').replaceChildren();
  for (const pair of phrases) {
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = `${pair.q} → ${pair.a}`;
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '編集';
    edit.addEventListener('click', () => { $('phrase-question').value = pair.q; $('phrase-answer').value = pair.a; $('phrase-question').focus(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '削除';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await savePhrases(phrases.filter(p => phraseKey(p.q) !== phraseKey(pair.q))); $('phrase-status').textContent = '削除しました。'; }
      catch (_) { remove.disabled = false; $('phrase-status').textContent = '削除できませんでした。'; }
    });
    li.append(text, edit, remove); $('phrase-list').append(li);
  }
}
$('phrase-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!db || $('phrase-save').disabled) return;
  const q = $('phrase-question').value.trim(), a = $('phrase-answer').value.trim();
  if (!phraseKey(q) || !a) { $('phrase-status').textContent = 'フレーズと返答を入力してください。'; return; }
  $('phrase-save').disabled = true;
  try {
    const next = phrases.filter(p => phraseKey(p.q) !== phraseKey(q));
    if (next.length >= 100) throw new Error('100件まで保存できます。不要なフレーズを削除してください。');
    await savePhrases([...next, { q, a }]);
    $('phrase-status').textContent = '覚えました。会話欄にフレーズを入力すると返答します。';
    $('phrase-form').reset();
  } catch (error) { $('phrase-status').textContent = error.message || '保存できませんでした。'; }
  finally { $('phrase-save').disabled = false; }
});
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
    if (h.a) {
      const reply = append('assistant', h.a, h.interrupted ? '途中で停止' : h.source === 'phrase' ? '教えてもらったフレーズから返答' : h.source === 'dictionary' ? '保存した辞書から返答' : '');
      if (h.referenceText) showReference(reply, h.referenceText);
    }
  }
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function showReference(reply, text) {
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '参照した内容';
  const body = document.createElement('p'); body.className = 'reference-text'; body.textContent = text;
  details.append(summary, body); reply.body.parentElement.append(details);
}
async function localReply(query, answer, source, label, referenceText = '') {
  const pair = { q: query, a: answer, source, referenceText, interrupted: false, at: Date.now() };
  history.push(pair);
  $('input').value = '';
  try { await saveHistory(); } catch (error) { history.pop(); $('input').value = query; throw error; }
  append('user', query); const reply = append('assistant', answer, label);
  if (referenceText) showReference(reply, referenceText);
  setStatus(label + 'しました。');
  window.scrollTo(0, document.documentElement.scrollHeight);
}
knowledge = createKnowledgeUI({ getDB: () => db, action, unload, acquireLock, releaseLock, setStatus });
$('network-mode').addEventListener('change', () => {
  const offline = $('network-mode').value === 'offline';
  action(async () => {
    await AI.net.setOffline(db, offline);
    setStatus(AI.net.isOffline() ? '外部検索とモデル取得を止めました。端末に保存した内容で使えます。' : '情報の取得を許可しました。会話の生成は引き続き端末内です。');
    if (!AI.net.isOffline()) await prepareOffline();
  });
});
async function prepareConversation() {
  knowledge?.assertReleased();
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
}
$('prepare').addEventListener('click', () => action(prepareConversation));
$('prepare-shortcut').addEventListener('click', () => action(prepareConversation));
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
for (const id of ['reply-tone', 'reply-length']) $(id).addEventListener('change', () => {
  storage.write(KEY + '-reply', replyPreferences());
  $('reply-note').textContent = $('reply-length').value === 'detailed'
    ? '次の回答から詳しく説明します。生成に時間がかかり、読み返せる過去の会話は短くなります。'
    : '次の回答から反映します。モデルの再取得は不要です。';
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!db || !$('input').value.trim()) return;
  action(async () => {
    const query = $('input').value.trim();
    const teaching = parsePhraseTeaching(query);
    if (teaching) {
      const next = phrases.filter(p => phraseKey(p.q) !== phraseKey(teaching.q));
      if (next.length >= 100) throw new Error('フレーズは100件まで保存できます。不要なものを削除してください。');
      await savePhrases([...next, teaching]);
      await localReply(query, `覚えました。「${teaching.q}」には「${teaching.a}」と返します。`, 'teaching', 'この端末にフレーズを保存');
      return;
    }
    const known = findPhrase(query, phrases);
    if (known) {
      await localReply(query, known.a, 'phrase', '教えてもらったフレーズから返答');
      return;
    }
    const exactTerm = (await dictionaryMatches(db, query)).find(t => t.key === AI.normalizeTerm(definitionQuery(query)));
    if (exactTerm) {
      await localReply(query, exactTerm.definition, 'dictionary', '保存した辞書から返答', `辞書「${exactTerm.term}」\n${exactTerm.sources.map(s => [s.title, s.url, s.license].filter(Boolean).join(' ')).join('\n')}`);
      return;
    }
    if (engine.state !== 'ready') { setStatus('覚えたフレーズにはありません。通常の会話は「会話を準備」を押してから送ってください。'); return; }
    const retrieved = await knowledge.retrieve(query);
    if (document.hidden) return;
    if (engine.state !== 'ready') await prepareConversation();
    if (engine.state !== 'ready') return;
    const memories = retrieved.notes;
    const preferences = replyPreferences();
    const messages = buildConversation(query, history, memories, withReplyPreferences(selected(), preferences));
    $('input').value = '';
    append('user', query);
    const reply = append('assistant', '考えています…');
    if (messages.referenceText) showReference(reply, messages.referenceText);
    window.scrollTo(0, document.documentElement.scrollHeight);
    const pair = { q: query, a: '', interrupted: true, at: Date.now(), referenceText: messages.referenceText };
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
      }, preferences);
      pair.a = result.text;
      pair.interrupted = result.interrupted;
      reply.body.textContent = result.text || (result.interrupted ? '停止しました。' : '答えが空でした。言い方を変えて試してください。');
      const seconds = ((performance.now() - start) / 1000).toFixed(1);
      reply.sub.textContent = `${result.interrupted ? '途中で停止 · ' : ''}${seconds}秒${messages.referenceText ? ' · 辞書・保存資料を参照' : ''}${retrieved.semanticError ? ' · 意味検索失敗、言葉の一致で検索' : ''}`;
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
  await flushDraft(); activateChat(await addChat(db)); await refreshChats(); closeMenu(); $('input').focus();
}));
$('new-chat-top').addEventListener('click', () => $('new-chat').click());
$('rename-chat').addEventListener('click', () => {
  const title = $('chat-name').value.trim();
  if (!title) return;
  action(async () => { currentChat = await updateChat(db, currentChat.id, { title: title.slice(0, 60), customTitle: true }); await refreshChats(); });
});
$('delete-chat').addEventListener('click', () => action(async () => {
  if (!window.confirm(`「${currentChat.title}」を削除しますか？ 他の会話・辞書・フレーズは残ります。`)) return;
  clearTimeout(draftTimer); activateChat(await removeChat(db, currentChat.id)); await refreshChats(); closeMenu();
}));
$('export-chat').addEventListener('click', () => download('ai-safari-conversation.json', { format: 'ai-safari-conversation', version: 1, title: currentChat.title, history }));
$('export-all').addEventListener('click', () => action(async () => { await flushDraft(); download('ai-safari-chats.json', { format: 'ai-safari-chats', version: 2, chats: await listChats(db) }); }));
$('diagnostics').addEventListener('click', () => download('ai-safari-diagnostics.json', { version: VERSION, userAgent: navigator.userAgent, profile: $('profile').value, events }));
for (const id of ['memory-link', 'lab-link']) $(id).addEventListener('click', (event) => {
  event.preventDefault();
  const href = $(id).href;
  if (pending) { setStatus('処理を止めてから移動してください。'); return; }
  action(async () => { await flushDraft(); await unload(); location.href = href; });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  flushDraft().catch(() => {});
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
  const reg = AI.net.isOffline() ? await navigator.serviceWorker.getRegistration() : await navigator.serviceWorker.register('sw.js');
  if (!reg) { $('offline').textContent = 'オンラインモードに切り替えると、オフライン起動用のファイルを保存します。'; return; }
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
  await AI.net.load(db);
  await knowledge.initialize();
  const savedPhrases = await AI.db.tx(db, 'settings', 'readonly', t => AI.db.rq(t.objectStore('settings').get(PHRASE_KEY)));
  if (!savedPhrases) await savePhrases([{ ...PHRASE_EXAMPLE }]);
  else { phrases = (Array.isArray(savedPhrases.value) ? savedPhrases.value : []).filter(p => typeof p?.q === 'string' && typeof p?.a === 'string').slice(0, 100); renderPhrases(); }
  $('phrase-save').disabled = false;
  const savedChats = await openChats(db);
  chats = savedChats.chats; currentChat = savedChats.current; history = currentChat.history;
  // The update module may already have restored an unsent draft from the old UI.
  if (!$('input').value) $('input').value = currentChat.draft || '';
  const profile = storage.read(KEY + '-profile', 'mobile');
  $('profile').value = PROFILES[profile] ? profile : 'mobile';
  const reply = storage.read(KEY + '-reply', {}) || {};
  $('reply-tone').value = ['standard', 'friendly', 'polite'].includes(reply.tone) ? reply.tone : 'standard';
  $('reply-length').value = ['short', 'standard', 'detailed'].includes(reply.length) ? reply.length : 'standard';
  if ($('reply-length').value === 'detailed') $('reply-note').textContent = '次の回答から詳しく説明します。生成に時間がかかり、読み返せる過去の会話は短くなります。';
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
