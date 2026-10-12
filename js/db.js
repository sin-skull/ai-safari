// IndexedDB の土台。版管理・全ストアの作成・トランザクション補助だけを持つ。
// ストアの設計は docs/DATA_DESIGN.md を参照。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const DB_NAME = 'ai-safari';
  // スキーマの版。IndexedDB の version と settings.schemaVersion の両方に使う。
  // 上げるときは migrations に同じ番号の移行処理を足す（既存の番号は書き換えない）。
  const SCHEMA_VERSION = 1;

  const migrations = {
    1(db) {
      db.createObjectStore('terms', { keyPath: 'key' }).createIndex('updatedAt', 'updatedAt');

      db.createObjectStore('passages', { keyPath: 'id', autoIncrement: true }).createIndex(
        'fetchedAt',
        'fetchedAt'
      );
      db.createObjectStore('vectors', { keyPath: 'passageId' });
      db.createObjectStore('ngram', { keyPath: 'gram' });

      db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }).createIndex(
        'status',
        'status'
      );
      db.createObjectStore('feedback', { keyPath: 'id', autoIncrement: true }).createIndex(
        'target',
        ['targetType', 'targetId']
      );
      db.createObjectStore('settings', { keyPath: 'name' });
    },
  };

  // IDBRequest を Promise にする。トランザクション内で await してよいのはこれだけ。
  function rq(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function open(name = DB_NAME) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, SCHEMA_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        for (let v = event.oldVersion + 1; v <= SCHEMA_VERSION; v++) {
          migrations[v](db, request.transaction);
        }
        request.transaction
          .objectStore('settings')
          .put({ name: 'schemaVersion', value: SCHEMA_VERSION });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('他のタブがデータベースを開いたままです。閉じてからやり直してください。'));
    });
  }

  // work(tx) の中で行った読み書きを、1つのトランザクションとして確定する。
  // work が例外を投げたら全体を取り消す（途中までの書き込みは残らない）。
  // 注意: work の中で await してよいのは IndexedDB のリクエスト（rq）だけ。
  function tx(db, storeNames, mode, work) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('トランザクションが取り消されました'));
      Promise.resolve(work(t)).then(
        (value) => {
          result = value;
        },
        (error) => {
          try {
            t.abort();
          } catch (_) {
            /* すでに終了している */
          }
          reject(error);
        }
      );
    });
  }

  function deleteDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }

  AI.db = { DB_NAME, SCHEMA_VERSION, open, tx, rq, deleteDatabase };
})(typeof globalThis !== 'undefined' ? globalThis : window);
