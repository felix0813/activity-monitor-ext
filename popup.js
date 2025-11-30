/*
 * @Author: felix 1306332027@qq.com
 * @Date: 2025-11-30 11:41:24
 * @LastEditors: felix 1306332027@qq.com
 * @LastEditTime: 2025-11-30 11:41:28
 * @FilePath: \activity-monitor-ext\popup.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const totalEl = document.getElementById('total');
  const activeEl = document.getElementById('active');
  const statusEl = document.getElementById('status');

  function setStatus(t) {
    statusEl.textContent = t;
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
  }

  // Compute quick stats from background
  chrome.runtime.sendMessage({ type: 'compute_stats' }, (resp) => {
    if (!resp || resp.status !== 'ok') {
      setStatus('无法计算统计信息');
      totalEl.textContent = '-';
      activeEl.textContent = '-';
      return;
    }
    const st = resp.stats;
    totalEl.textContent = st.total_events ?? 0;
    // sum active_time_by_url
    let totalActive = 0;
    if (st.active_time_by_url) {
      for (const k in st.active_time_by_url) totalActive += st.active_time_by_url[k];
    }
    activeEl.textContent = totalActive;
  });

  document.getElementById('btnFlush').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'flush_now' }, (r) => {
      if (r && r.status === 'ok') setStatus('Flush triggered');
      else setStatus('Flush failed');
    });
  });

  document.getElementById('btnStats').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'compute_stats' }, (resp) => {
      if (!resp || resp.status !== 'ok') {
        setStatus('统计失败');
        return;
      }
      const pretty = JSON.stringify(resp.stats, null, 2);
      // show in new window/tab for easy copy
      const w = window.open('', '_blank');
      w.document.write('<pre>' + pretty + '</pre>');
    });
  });

  document.getElementById('btnExport').addEventListener('click', () => {
    setStatus('导出中...');
    chrome.runtime.sendMessage({ type: 'export_all' }, (resp) => {
      if (!resp || resp.status !== 'ok') {
        setStatus('导出失败');
        return;
      }
      const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'activity_events.json';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('导出完成');
    });
  });
});
