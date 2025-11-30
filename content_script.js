// content_script.js
// Minimal, privacy-conscious collector: no form values captured, no cookies, no session/tab ids.
// Collects: page_open, page_close, visibility_change, focus, blur, click, scroll, keydown (sampled)
// Sends events to background via chrome.runtime.sendMessage

(function () {
  function makeEvent(type, extra = {}) {
    return Object.assign({
      event_id: uuidv4(),
      type,
      ts: Date.now(),
      url: location.href,
      title: document.title || ''
    }, extra);
  }
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
  // Send to background
  function send(e) {
    try {
      chrome.runtime.sendMessage({ type: 'record_event', event: e });
    } catch (err) {
      // silent fallback
      console.error('send event failed', err);
    }
  }

  // Track "active" periods using visibility + focus
  let activeStart = null;
  function startActiveIfNeeded() {
    if (document.visibilityState === 'visible' && document.hasFocus() && !activeStart) {
      activeStart = Date.now();
    }
  }
  function stopActiveIfRunning() {
    if (activeStart) {
      const duration = Date.now() - activeStart;
      send(makeEvent('active_period', { duration })); // duration in ms
      activeStart = null;
    }
  }

  // page_open
  send(makeEvent('page_open'));

  // setup initial active state
  startActiveIfNeeded();

  // visibilitychange
  document.addEventListener('visibilitychange', () => {
    send(makeEvent('visibility_change', { state: document.visibilityState }));
    if (document.visibilityState === 'hidden') {
      stopActiveIfRunning();
    } else {
      // when becomes visible, maybe start active if focused
      startActiveIfNeeded();
    }
  });

  // focus / blur
  window.addEventListener('focus', () => {
    send(makeEvent('focus'));
    startActiveIfNeeded();
  });
  window.addEventListener('blur', () => {
    send(makeEvent('blur'));
    // blur usually implies not active
    stopActiveIfRunning();
  });

  // beforeunload -> page_close (ensure we flush active period)
  window.addEventListener('beforeunload', () => {
    // send active period if running
    if (activeStart) {
      const duration = Date.now() - activeStart;
      // Use navigator.sendBeacon if available for reliability
      const ev = makeEvent('active_period', { duration });
      try {
        chrome.runtime.sendMessage({ type: 'record_event', event: ev });
      } catch (e) { /* ignore */ }
      activeStart = null;
    }
    try {
      const closeEvt = makeEvent('page_close');
      chrome.runtime.sendMessage({ type: 'record_event', event: closeEvt });
    } catch (e) {}
  });

  // low-frequency interaction sampling
  let lastInteraction = 0;
  function sampleInteraction(e) {
    const now = Date.now();
    if (now - lastInteraction < 1000) return; // 1s downsample
    lastInteraction = now;

    const payload = { subtype: e.type };
    if (e.type === 'click') {
      // minimal selector: tagName + classes (no ids, to reduce privacy)
      const t = e.target;
      if (t && t.tagName) {
        const cls = (t.className && typeof t.className === 'string') ? (' ' + t.className.trim()) : '';
        payload.selector = `${t.tagName.toLowerCase()}${cls}`;
      }
    } else if (e.type === 'scroll') {
      // approximate scroll depth (percentage) for page
      try {
        const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
        const height = document.documentElement.scrollHeight || document.body.scrollHeight;
        const viewH = window.innerHeight || document.documentElement.clientHeight;
        const depth = Math.min(100, Math.round((scrollTop + viewH) / Math.max(1, height) * 100));
        payload.scroll_depth = depth;
      } catch (err) {}
    }
    send(makeEvent(e.type, payload));
  }

  ['click', 'scroll', 'keydown'].forEach(evt => {
    window.addEventListener(evt, sampleInteraction, { passive: true });
  });

})();
