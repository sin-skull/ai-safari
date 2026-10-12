// Service Worker：アプリ本体をキャッシュして、電波が無くても開けるようにする。
// VERSION は index.html のスクリプトの ?v= と同じにする（tests で食い違いを検出）。
// 外部（Wikipedia など）の通信はここでは扱わない。同じオリジンのファイルだけを対象にする。
const VERSION = '0.11.4-safari.1';
const CACHE = `ai-safari-app-${VERSION}`;
const FILES = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  ...['normalize', 'db', 'terms', 'chat', 'wiki', 'passages', 'feedback', 'net', 'queue', 'backup', 'store', 'embed', 'llm', 'rag', 'growth', 'sentiment', 'vectors', 'hybrid', 'app'].map(
    (n) => `./js/${n}.js?v=${VERSION}`
  ),
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

// この改修版のアプリキャッシュだけを更新する。元のaiとモデル保存先には触れない
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ai-safari-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 試験室（lab/）はアプリとは別のページ。ここでは扱わない（アプリの画面のキャッシュを上書きしないため）
  if (url.pathname.includes('/lab/')) return;

  // 画面（index.html）：繋がるなら最新を取り、無理ならキャッシュ。更新が届くようにする
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.open(CACHE).then((cache) => cache.match('./index.html')))
    );
    return;
  }

  // それ以外（版番号つきのJS・画像など）：キャッシュ優先
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(request)).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
