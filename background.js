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
let connectionRetryCount = 0;
const MAX_CONNECTION_RETRIES = 5;

// 用于存储每个 tab 当前页面的打开时间
const pageSessions = {};

// Try to connect to native host (if user has one installed). Replace name per your native host manifest.
function connectNative() {
  // 避免重复连接和过多重试
  if (nativePort || isConnectingNative || connectionRetryCount >= MAX_CONNECTION_RETRIES) {
    return Promise.resolve(nativePort);
  }
  
  isConnectingNative = true;
  
  return new Promise((resolve) => {
    try {
      nativePort = chrome.runtime.connectNative('private_assistant');
      
      nativePort.onMessage.addListener((msg) => {
        console.log('Native msg:', msg);
        connectionRetryCount = 0; // 重置重试计数
      });
      
      nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.warn('Native disconnected:', error ? error.message : 'Unknown error');
        nativePort = null;
        isConnectingNative = false;
        connectionRetryCount++;
        
        // 实现指数退避重连机制
        if (connectionRetryCount < MAX_CONNECTION_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, connectionRetryCount), 30000);
          setTimeout(() => {
            connectNative();
          }, delay);
        }
      });
      
      isConnectingNative = false;
      connectionRetryCount = 0; // 成功连接后重置重试计数
      resolve(nativePort);
    } catch (err) {
      console.warn('connectNative failed (likely no native host installed).', err);
      nativePort = null;
      isConnectingNative = false;
      connectionRetryCount++;
      resolve(null);
    }
  });
}

async function postToNative(payload) {
  // 检查参数有效性
  if (!payload || typeof payload !== 'object') {
    console.error('Invalid payload for postToNative');
    return false;
  }
  
  // 尝试连接（如果尚未连接）
  if (!nativePort) {
    await connectNative();
    // 如果仍然无法连接，返回false
    if (!nativePort) return false;
  }
  
  try {
    nativePort.postMessage(payload);
    return true;
  } catch (err) {
    console.error('postToNative failed:', err);
    // 清理失效的连接
    if (nativePort) {
      try {
        nativePort.disconnect();
      } catch (e) {
        // 忽略断开连接时的错误
      }
      nativePort = null;
    }
    return false;
  }
}

// Accept events from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'record_event' && msg.event) {
    // Ensure minimal sanitization (no form values should be present by design)
    try {
      msg.event.received_ts = Date.now();
      idbAdd(msg.event).catch(e => {
        console.error('idbAdd error', e);
        // 可以考虑添加本地存储失败的处理逻辑
      });
    } catch (e) {
      console.error('Error processing record_event', e);
    }
    // no need to block sender
  } else if (msg && msg.type === 'flush_now') {
    flushBatch()
      .then(() => sendResponse({ status: 'ok' }))
      .catch(e => {
        console.error('flush_now error:', e);
        sendResponse({ status: 'error', message: e.toString() });
      });
    return true; // will sendResponse asynchronously
  } else if (msg && msg.type === 'export_all') {
    idbGetAll()
      .then(all => sendResponse({ status: 'ok', data: all || [] }))
      .catch(e => {
        console.error('export_all error:', e);
        sendResponse({ status: 'error', message: e.toString() });
      });
    return true;
  } else if (msg && msg.type === 'compute_stats') {
    computeStats()
      .then(st => sendResponse({ status: 'ok', stats: st }))
      .catch(e => {
        console.error('compute_stats error:', e);
        sendResponse({ status: 'error', message: e.toString() });
      });
    return true;
  }
});

// Compute simple stats: counts and total active time per URL (basic example)
async function computeStats() {
  try {
    const all = await idbGetAll();
    const stats = {
      total_events: all ? all.length : 0,
      events_by_type: {},
      active_time_by_url: {}
    };
    
    if (!all || !Array.isArray(all)) {
      return stats;
    }
    
    for (const e of all) {
      if (!e) continue; // 跳过空值
      
      const t = (e.type || 'unknown').toString();
      stats.events_by_type[t] = (stats.events_by_type[t] || 0) + 1;
      
      if (t === 'active_period' && typeof e.duration === 'number') {
        const u = (e.url || 'unknown').toString();
        stats.active_time_by_url[u] = (stats.active_time_by_url[u] || 0) + e.duration;
      }
    }
    return stats;
  } catch (e) {
    console.error('Error computing stats:', e);
    throw new Error(`Failed to compute stats: ${e.message}`);
  }
}

// Flush a batch: get BATCH_SIZE events, attempt to post to native host; on success remove them from DB
async function flushBatch() {
  try {
    const batch = await idbGetBatch(BATCH_SIZE);
    
    // 检查批次数据有效性
    if (!batch || !Array.isArray(batch) || batch.length === 0) {
      return;
    }
    
    // prepare the payload without internal _id
    const events = batch
      .filter(x => x) // 过滤掉无效项
      .map(x => {
        const copy = Object.assign({}, x);
        delete copy._id;
        return copy;
      })
      .filter(x => Object.keys(x).length > 0); // 过滤掉空对象
    
    // 如果处理后没有有效事件，则直接返回
    if (events.length === 0) {
      return;
    }
    
    const payload = {
      batch_id: 'batch-' + new Date().toISOString(),
      client: { 
        ua: navigator.userAgent, 
        ext_version: chrome.runtime.getManifest()?.version || 'unknown' 
      },
      events
    };

    const sent = await postToNative(payload);
    if (sent) {
      // remove from idb by primary keys
      const keys = batch
        .filter(x => x && x._id !== undefined)
        .map(x => x._id);
      
      if (keys.length > 0) {
        await idbDeleteBatchByKeys(keys);
      }
    } else {
      // not sent - keep in DB (will retry next interval)
      // but to avoid DB growing forever you may implement local pruning/aggregation in production
      console.warn('Failed to send batch to native host, will retry later');
    }
  } catch (e) {
    console.error('Error in flushBatch:', e);
    throw new Error(`Batch flush failed: ${e.message}`);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === "loading") {
      const now = Date.now();

      // 1. 如果 tabId 已有旧记录 → 表示旧页面正在关闭（跳转）
      if (pageSessions[tabId]) {
        const old = pageSessions[tabId];
        
        // 确保必要字段存在
        if (old.url) {
          sendEvent({
            type: "page_close",
            url: old.url,
            title: old.title,
            ts: now
          });
        }
      }

      // 2. 新页面开始（确保tab对象有效）
      if (tab && tab.url) {
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
    }
  } catch (e) {
    console.error('Error in tabs.onUpdated listener:', e);
  }
});

// 当 tab 被关闭时
chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    const now = Date.now();
    if (pageSessions[tabId]) {
      const old = pageSessions[tabId];
      
      // 确保必要字段存在
      if (old.url) {
        sendEvent({
          type: "page_close",
          url: old.url,
          title: old.title,
          ts: now
        });
      }
      
      delete pageSessions[tabId];
    }
  } catch (e) {
    console.error('Error in tabs.onRemoved listener:', e);
  }
});

// 发送到桌面应用
function sendEvent(evt) {
  try {
    // 验证事件对象
    if (!evt || typeof evt !== 'object') {
      console.warn('Invalid event object passed to sendEvent');
      return;
    }
    
    evt.event_id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() + Math.random().toString(36);
    
    chrome.runtime.sendNativeMessage("private_assistant", evt, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Error sending native message:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.error('Error in sendEvent:', e);
  }
}

// Periodic flush with error handling
setInterval(() => {
  flushBatch().catch(e => {
    console.error('flushBatch err', e);
    // 可以在这里添加更复杂的错误处理逻辑，例如通知用户或记录到远程服务器
  });
}, FLUSH_INTERVAL_MS);

// On startup try to connect to native if possible
connectNative().catch(e => {
  console.error('Initial connectNative failed:', e);
});

// Expose a startup log
console.log('Activity Monitor background worker started');