// Independent of model/DB initialization, so a stuck model cannot block updates.
const button = document.getElementById('update-app');
const status = document.getElementById('update-status');
const DRAFT = 'ai-safari-update-draft';
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('更新を確認できませんでした。通信を確認して、もう一度押してください。')), 30000);
    })]);
  } finally { clearTimeout(timer); }
}
try {
  const draft = sessionStorage.getItem(DRAFT);
  if (draft !== null) { document.getElementById('input').value = draft; sessionStorage.removeItem(DRAFT); }
} catch (_) { /* Storage may be unavailable. */ }

function activated(worker) {
  return new Promise((resolve, reject) => {
    const changed = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('更新ファイルを保存できませんでした。通信を確認して、もう一度押してください。'));
    };
    const timer = setTimeout(() => finish(new Error('更新に時間がかかっています。通信を確認して、もう一度押してください。')), 60000);
    function finish(error) {
      clearTimeout(timer); worker.removeEventListener('statechange', changed);
      error ? reject(error) : resolve();
    }
    worker.addEventListener('statechange', changed); changed();
  });
}

button.addEventListener('click', async () => {
  if (button.disabled) return;
  if (!navigator.onLine) { status.textContent = '更新にはインターネット接続が必要です。接続後にもう一度押してください。'; return; }
  if (globalThis.AI?.net?.isOffline()) { status.textContent = '通信モードをオンラインに切り替えてから更新してください。'; return; }
  button.disabled = true;
  status.textContent = '最新版を確認しています… 更新後に再起動し、実行中の処理は中断します。';
  try {
    if (!navigator.serviceWorker) throw new Error('このブラウザではアプリの更新を確認できません。');
    const registration = await bounded(navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }));
    // Unlike an ordinary reload, update() checks the worker on the network.
    await bounded(registration.update());
    const worker = registration.installing || registration.waiting || registration.active;
    if (!worker) throw new Error('更新の準備ができませんでした。もう一度押してください。');
    if (worker.state !== 'activated') {
      status.textContent = '更新ファイルを保存しています…';
      await activated(worker); // Existing workers automatically skipWaiting and claim.
    }
    // Do not reload while a new worker is still installing the offline files.
    const input = document.getElementById('input');
    try { sessionStorage.setItem(DRAFT, input.value); }
    catch (_) {
      if (input.value) throw new Error('入力中の文章を保存できません。文章をコピーしてから更新してください。');
    }
    status.textContent = '読み込み直しています…';
    location.reload();
  } catch (error) {
    status.textContent = error.message || '更新できませんでした。通信を確認して、もう一度押してください。';
    button.disabled = false;
  }
});
