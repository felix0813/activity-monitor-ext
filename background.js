// background.js (MV3 service worker)
// Responsibilities remain the same but Native Messaging removed

importScripts('idb.js') // load idb helper

const FLUSH_INTERVAL_MS = 15000 // batch flush interval
const BATCH_SIZE = 200

let ws = null
let wsConnected = false
let wsUrl = 'ws://127.0.0.1:5000/ws'
let httpUrl = 'http://127.0.0.1:5000/events'

// 用于存储每个 tab 当前页面的打开时间
const pageSessions = {}

// --------------------- WebSocket 连接 ---------------------
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const BASE_RECONNECT_DELAY = 1000

function connectWebSocket () {
  if (wsConnected || ws || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return

  try {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      console.log('WebSocket connected')
      wsConnected = true
      reconnectAttempts = 0
    }

    ws.onmessage = (event) => {
      console.log('WS message from server:', event.data)
    }

    ws.onclose = () => {
      console.warn('WebSocket disconnected')
      ws = null
      wsConnected = false

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 30000)
        console.log(`Attempting to reconnect WebSocket in ${delay}ms (attempt ${reconnectAttempts})`)
        setTimeout(connectWebSocket, delay)
      } else {
        console.error('Max WebSocket reconnection attempts reached')
      }
    }

    ws.onerror = (err) => {
      console.error('WebSocket error', err)
      if (ws) {
        ws.close()
      }
    }
  } catch (error) {
    console.error('Failed to create WebSocket connection', error)
    ws = null
    wsConnected = false
  }
}

// --------------------- 发送批次 ---------------------
async function postBatch (payload) {
  let lastError = null

  try {
    // 优先使用 WebSocket
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload))
        return { success: true, method: 'websocket' }
      } catch (wsError) {
        console.error('WebSocket send failed', wsError)
        lastError = wsError
        // WebSocket发送失败后尝试HTTP
      }
    }

    // WebSocket 不可用则使用 HTTP POST
    try {
      const resp = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!resp.ok) {
        const errorMsg = `HTTP POST failed: ${resp.status} ${resp.statusText}`
        console.warn(errorMsg)
        lastError = new Error(errorMsg)
        return { success: false, error: lastError, method: 'http' }
      }

      return { success: true, method: 'http' }
    } catch (httpError) {
      console.error('HTTP POST error:', httpError)
      lastError = httpError
      return { success: false, error: httpError, method: 'http' }
    }
  } catch (err) {
    console.error('postBatch unexpected error:', err)
    lastError = err
    return { success: false, error: err, method: 'unknown' }
  }
}

// --------------------- flushBatch ---------------------
const BATCH_RETRY_LIMIT = 3
const batchRetryCounts = new Map()

async function flushBatch () {
  try {
    const batch = await idbGetBatch(BATCH_SIZE)
    if (!batch || !Array.isArray(batch) || batch.length === 0) return

    const events = batch
      .filter((x) => x)
      .map((x) => {
        const copy = Object.assign({}, x)
        delete copy._id
        return copy
      })
      .filter((x) => Object.keys(x).length > 0)

    if (events.length === 0) return

    // 为批次创建唯一标识符用于重试跟踪
    const batchKey = batch.map(x => x._id).join(',')

    const payload = {
      batch_id: 'batch-' + new Date().toISOString(),
      client: {
        ua: navigator.userAgent,
        ext_version: chrome.runtime.getManifest()?.version || 'unknown',
      },
      events,
    }

    const result = await postBatch(payload)

    if (result.success) {
      // 发送成功，删除数据并重置重试计数
      const keys = batch
        .filter((x) => x && x._id !== undefined)
        .map((x) => x._id)

      if (keys.length > 0) {
        await idbDeleteBatchByKeys(keys)
        batchRetryCounts.delete(batchKey)
      }
      console.log(`Batch of ${events.length} events sent via ${result.method} and deleted from IDB`)
    } else {
      // 发送失败，增加重试计数
      const currentRetries = batchRetryCounts.get(batchKey) || 0
      const newRetries = currentRetries + 1

      if (newRetries >= BATCH_RETRY_LIMIT) {
        console.error(`Batch failed after ${BATCH_RETRY_LIMIT} retries, marking as permanently failed`, result.error)
        batchRetryCounts.delete(batchKey)
        // 可以考虑将失败的数据移动到单独的"失败队列"表中
      } else {
        batchRetryCounts.set(batchKey, newRetries)
        console.warn(`Failed to send batch (attempt ${newRetries}/${BATCH_RETRY_LIMIT}), will retry later`, result.error)
      }
    }
  } catch (e) {
    console.error('Error in flushBatch:', e)
    // 不抛出异常以免中断定时任务
  }
}
// --------------------- 内容脚本消息监听 ---------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'record_event' && msg.event) {
    try {
      msg.event.received_ts = Date.now()
      idbAdd(msg.event).catch((e) => console.error('idbAdd error', e))
    } catch (e) {
      console.error('Error processing record_event', e)
    }
  } else if (msg && msg.type === 'flush_now') {
    flushBatch()
      .then(() => sendResponse({ status: 'ok' }))
      .catch((e) => sendResponse({ status: 'error', message: e.toString() }))
    return true
  } else if (msg && msg.type === 'export_all') {
    idbGetAll()
      .then((all) => sendResponse({ status: 'ok', data: all || [] }))
      .catch((e) => sendResponse({ status: 'error', message: e.toString() }))
    return true
  } else if (msg && msg.type === 'compute_stats') {
    computeStats()
      .then((st) => sendResponse({ status: 'ok', stats: st }))
      .catch((e) => sendResponse({ status: 'error', message: e.toString() }))
    return true
  }
})
// 检测网络状态变化
let isOnline = navigator.onLine

window.addEventListener('online', () => {
  console.log('Network connection restored')
  isOnline = true
  // 网络恢复时立即尝试重连
  if (!wsConnected) {
    reconnectAttempts = 0
    connectWebSocket()
  }
})

window.addEventListener('offline', () => {
  console.log('Network connection lost')
  isOnline = false
  // 断开WebSocket连接
  if (ws) {
    ws.close()
  }
})
// --------------------- 页面 session 监听 ---------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === 'loading') {
      const now = Date.now()
      if (pageSessions[tabId]) {
        const old = pageSessions[tabId]
        if (old.url)
          sendEvent({
            type: 'page_close',
            url: old.url,
            title: old.title,
            ts: now,
          })
      }
      if (tab && tab.url) {
        pageSessions[tabId] = { url: tab.url, title: tab.title, start: now }
        sendEvent({
          type: 'page_open',
          url: tab.url,
          title: tab.title,
          ts: now,
        })
      }
    }
  } catch (e) {
    console.error('tabs.onUpdated error', e)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    const now = Date.now()
    if (pageSessions[tabId]) {
      const old = pageSessions[tabId]
      if (old.url)
        sendEvent({
          type: 'page_close',
          url: old.url,
          title: old.title,
          ts: now,
        })
      delete pageSessions[tabId]
    }
  } catch (e) {
    console.error('tabs.onRemoved error', e)
  }
})

// --------------------- 事件存储 ---------------------
function sendEvent (evt) {
  try {
    if (!evt || typeof evt !== 'object') return
    evt.event_id = crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString() + Math.random().toString(36)
    idbAdd(evt).catch((e) => console.error('idbAdd error in sendEvent', e))
  } catch (e) {
    console.error('sendEvent error', e)
  }
}

// --------------------- 周期 flush ---------------------
setInterval(() => {
  flushBatch().catch((e) => console.error('flushBatch err', e))
}, FLUSH_INTERVAL_MS)

// --------------------- 启动 WebSocket ---------------------
// 启动时的初始化和健康检查
async function initializeBackgroundWorker () {
  console.log('Initializing Activity Monitor background worker...')

  // 检查网络状态
  isOnline = navigator.onLine
  console.log('Network status:', isOnline ? 'Online' : 'Offline')

  // 启动WebSocket连接
  if (isOnline) {
    connectWebSocket()
  }

  // 检查待发送数据
  try {
    const pendingCount = await idbGetAll().then(events => events ? events.length : 0)
    console.log(`Found ${pendingCount} pending events in database`)
  } catch (error) {
    console.warn('Could not check pending events count:', error)
  }

  console.log('Activity Monitor background worker initialized (HTTP/WebSocket mode)')
}

// 使用初始化函数替代直接调用
initializeBackgroundWorker()

console.log('Activity Monitor background worker started (HTTP/WebSocket mode)')
