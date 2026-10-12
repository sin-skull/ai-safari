const PREFIX = 'conversation-thread-v2:';
const ACTIVE = 'conversation-active-v2';
const MIGRATED = 'conversation-migrated-v2';
const cleanHistory = rows => (Array.isArray(rows) ? rows : []).filter(h => typeof h?.q === 'string' && typeof h?.a === 'string').slice(-40);
const create = (history = []) => ({ id: crypto.randomUUID(), title: history[0]?.q?.slice(0, 28) || '新しい会話', customTitle: false, history, draft: '', createdAt: Date.now(), updatedAt: Date.now() });
const transact = (db, work) => AI.db.tx(db, 'settings', 'readwrite', t => work(t.objectStore('settings')));
const read = (store, key) => AI.db.rq(store.get(key));
const put = (store, name, value) => AI.db.rq(store.put({ name, value }));

export async function openChats(db) {
  return transact(db, async store => {
    let chats = (await AI.db.rq(store.getAll())).filter(r => r.name.startsWith(PREFIX)).map(r => r.value);
    if (!chats.length) {
      const migrated = await read(store, MIGRATED);
      const old = migrated ? null : await read(store, 'conversation-v1');
      const first = create(cleanHistory(old?.value));
      first.legacySource = !!old;
      await put(store, PREFIX + first.id, first);
      chats = [first];
    }
    await put(store, MIGRATED, true); // Keep the legacy transcript as a recovery copy.
    const selected = (await read(store, ACTIVE))?.value;
    const current = chats.find(c => c.id === selected) || chats[0];
    await put(store, ACTIVE, current.id);
    return { chats, current };
  });
}
export async function listChats(db) {
  return AI.db.tx(db, 'settings', 'readonly', async t => (await AI.db.rq(t.objectStore('settings').getAll()))
    .filter(r => r.name.startsWith(PREFIX)).map(r => r.value).sort((a, b) => a.createdAt - b.createdAt));
}
export async function updateChat(db, id, patch) {
  return transact(db, async store => {
    const row = await read(store, PREFIX + id);
    if (!row) throw new Error('この会話は別の画面で削除されました。新しい会話を作ってください。');
    const next = { ...row.value, ...patch, id, updatedAt: Date.now() };
    if (patch.history) {
      next.history = cleanHistory(patch.history);
      if (!next.customTitle && next.history[0]?.q) next.title = next.history[0].q.slice(0, 28);
    }
    await put(store, PREFIX + id, next);
    return next;
  });
}
export async function selectChat(db, id) {
  return transact(db, async store => {
    const row = await read(store, PREFIX + id);
    if (!row) throw new Error('この会話は見つかりませんでした。');
    await put(store, ACTIVE, id); return row.value;
  });
}
export async function addChat(db) {
  return transact(db, async store => {
    const keys = await AI.db.rq(store.getAllKeys());
    if (keys.filter(k => k.startsWith(PREFIX)).length >= 50) throw new Error('会話は50件まで保存できます。不要な会話をメニューから削除してください。');
    const chat = create();
    await put(store, PREFIX + chat.id, chat); await put(store, ACTIVE, chat.id);
    return chat;
  });
}
export async function removeChat(db, id) {
  return transact(db, async store => {
    const removed = await read(store, PREFIX + id);
    if (removed?.value?.legacySource) await AI.db.rq(store.delete('conversation-v1'));
    await AI.db.rq(store.delete(PREFIX + id));
    let chats = (await AI.db.rq(store.getAll())).filter(r => r.name.startsWith(PREFIX)).map(r => r.value);
    if (!chats.length) { chats = [create()]; await put(store, PREFIX + chats[0].id, chats[0]); }
    await put(store, ACTIVE, chats[0].id); return chats[0];
  });
}
