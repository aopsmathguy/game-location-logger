let samples = [];
let lastStatus = null;
const MAX_SAMPLES = 20000;

function updateBadge() {
  const text = samples.length > 999 ? '999+' : String(samples.length || '');
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sample' && message.payload) {
    samples.push({
      tabId: sender.tab?.id ?? null,
      tabUrl: sender.tab?.url ?? null,
      ...message.payload
    });

    if (samples.length > MAX_SAMPLES) {
      samples = samples.slice(samples.length - MAX_SAMPLES);
    }

    updateBadge();
    sendResponse?.({ ok: true, count: samples.length });
    return true;
  }

  if (message?.type === 'status') {
    lastStatus = {
      tabId: sender.tab?.id ?? null,
      tabUrl: sender.tab?.url ?? null,
      at: Date.now(),
      ...message.payload
    };
    sendResponse?.({ ok: true });
    return true;
  }

  if (message?.type === 'export-log') {
    exportLog();
    sendResponse?.({ ok: true });
    return true;
  }

  if (message?.type === 'clear-log') {
    samples = [];
    updateBadge();
    sendResponse?.({ ok: true });
    return true;
  }
});

function exportLog() {
  const payload = {
    exportedAt: new Date().toISOString(),
    sampleCount: samples.length,
    lastStatus,
    samples
  };

  const json = JSON.stringify(payload, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  const filename = `position-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });
}

chrome.action.onClicked.addListener(() => {
  exportLog();
});
