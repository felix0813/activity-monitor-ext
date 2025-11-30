/*
 * @Author: felix 1306332027@qq.com
 * @Date: 2025-11-30 11:40:28
 * @LastEditors: felix 1306332027@qq.com
 * @LastEditTime: 2025-11-30 11:40:34
 * @FilePath: \activity-monitor-ext\idb.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
// idb.js - tiny IndexedDB helper for storing events
const IDB_DB_NAME = 'activity_monitor_db';
const IDB_STORE = 'events_v1';
const IDB_VERSION = 1;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAdd(eventObj) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const r = store.add(eventObj);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGetBatch(limit = 100) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.openCursor();
    const out = [];
    req.onsuccess = function (e) {
      const cursor = e.target.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(Object.assign({ _id: cursor.primaryKey }, cursor.value));
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function idbDeleteBatchByKeys(keys) {
  if (!keys || keys.length === 0) return;
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    let pending = keys.length;
    keys.forEach(k => {
      const r = store.delete(k);
      r.onsuccess = () => {
        pending--;
        if (pending === 0) resolve();
      };
      r.onerror = (e) => reject(e.target.error);
    });
  });
}

async function idbGetAll() {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
