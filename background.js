// background.js (MV3 service worker)
// Responsibilities:
// - Accept events from content scripts
// - Store events safely in IndexedDB (idb.js)
// - Periodically batch-send to native host if available (postToNative), otherwise keep cached
// - Provide export / stats via messages (used by popup)

importScripts('idb.js'); // load idb helper

const FLUSH_INTERVAL_MS = 15000; // batch flush interval
const BATCH_SIZE = 200;
let nativePort = null;
let isConnectingNative = false;

// Try to connect to native host (if user has one installed). Replace name per your native host manifest.
function connectNative() {
  if (nativePort || isConnectingNative) return;
  isConnectingNative = true;
  try {
    nativePort = chrome.runtime.connectNative('private_assistant');
    nativePort.onMessage.addListener((msg) => {
      console.log('Native msg:', msg);
    });
    nativePort.onDisconnect.addListener(() => {
      console.warn('Native disconnected:', chrome.runtime.lastError);
      nativePort = null;
      isConnectingNative = false;
    });
    isConnectingNative = false;
  } catch (err) {
    console.warn('connectNative failed (likely no native host installed).', err);
    nativePort = null;
    isConnectingNative = false;
  }
}

async function postToNative(payload) {
  if (!nativePort) {
    connectNative();
    // If still not available, return false to indicate not sent
    if (!nativePort) return false;
  }
  try {
    nativePort.postMessage(payload);
    return true;
  } catch (err) {
    console.error('postToNative failed:', err);
    nativePort = null;
    return false;
  }
}

// Accept events from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'record_event' && msg.event) {
    // Ensure minimal sanitization (no form values should be present by design)
    msg.event.received_ts = Date.now();
    idbAdd(msg.event).catch(e => console.error('idbAdd error', e));
    // no need to block sender
  } else if (msg && msg.type === 'flush_now') {
    flushBatch().then(() => sendResponse({ status: 'ok' })).catch(e => sendResponse({ status: 'error', e: String(e) }));
    return true; // will sendResponse asynchronously
  } else if (msg && msg.type === 'export_all') {
    idbGetAll().then(all => sendResponse({ status: 'ok', data: all })).catch(e => sendResponse({ status: 'error', e: String(e) }));
    return true;
  } else if (msg && msg.type === 'compute_stats') {
    computeStats().then(st => sendResponse({ status: 'ok', stats: st })).catch(e => sendResponse({ status: 'error', e: String(e) }));
    return true;
  }
});

// Compute simple stats: counts and total active time per URL (basic example)
async function computeStats() {
  const all = await idbGetAll();
  const stats = {
    total_events: all.length,
    events_by_type: {},
    active_time_by_url: {}
  };
  for (const e of all) {
    const t = e.type || 'unknown';
    stats.events_by_type[t] = (stats.events_by_type[t] || 0) + 1;
    if (t === 'active_period' && typeof e.duration === 'number') {
      const u = e.url || 'unknown';
      stats.active_time_by_url[u] = (stats.active_time_by_url[u] || 0) + e.duration;
    }
  }
  return stats;
}

// Flush a batch: get BATCH_SIZE events, attempt to post to native host; on success remove them from DB
async function flushBatch() {
  const batch = await idbGetBatch(BATCH_SIZE);
  if (!batch || batch.length === 0) return;
  // prepare the payload without internal _id
  const events = batch.map(x => {
    const copy = Object.assign({}, x);
    delete copy._id;
    return copy;
  });
  const payload = {
    batch_id: 'batch-' + new Date().toISOString(),
    client: { ua: navigator.userAgent, ext_version: chrome.runtime.getManifest().version },
    events
  };

  const sent = await postToNative(payload);
  if (sent) {
    // remove from idb by primary keys
    const keys = batch.map(x => x._id);
    await idbDeleteBatchByKeys(keys);
  } else {
    // not sent - keep in DB (will retry next interval)
    // but to avoid DB growing forever you may implement local pruning/aggregation in production
  }
}
// 用于存储每个 tab 当前页面的打开时间
const pageSessions = {};

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {

    const now = Date.now();

    // 1. 如果 tabId 已有旧记录 → 表示旧页面正在关闭（跳转）
    if (pageSessions[tabId]) {
      const old = pageSessions[tabId];

      sendEvent({
        type: "page_close",
        url: old.url,
        title: old.title,
        ts: now
      });
    }

    // 2. 新页面开始
    pageSessions[tabId] = {
      url: tab.url,
      title: tab.title,
      start: now
    };

    sendEvent({
      type: "page_open",
      url: tab.url,
      title: tab.title,
      ts: now
    });
  }
});

// 当 tab 被关闭时
chrome.tabs.onRemoved.addListener((tabId) => {
  const now = Date.now();
  if (pageSessions[tabId]) {
    const old = pageSessions[tabId];
    sendEvent({
      type: "page_close",
      url: old.url,
      title: old.title,
      ts: now
    });
    delete pageSessions[tabId];
  }
});

// 发送到桌面应用
function sendEvent(evt) {
  evt.event_id = crypto.randomUUID();
  chrome.runtime.sendNativeMessage("private_assistant", evt);
}

// Periodic flush
setInterval(() => {
  flushBatch().catch(e => console.error('flushBatch err', e));
}, FLUSH_INTERVAL_MS);

// On startup try to connect to native if possible
connectNative();

// Expose a startup log
console.log('Activity Monitor background worker started');
