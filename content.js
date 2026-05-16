(() => {
  const SOURCE = 'enemy-location-logger';

  // inject.js is now loaded as a `world: "MAIN"` content script via the
  // manifest, so it runs synchronously at document_start in the page world,
  // guaranteed to execute before any page JavaScript. No script-tag injection
  // is needed here — this content.js stays in the isolated world and only
  // bridges window.postMessage events to the background service worker.

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;

    if (data.type === 'sample') {
      const payload = data.payload;
      console.log('[2D Shooter Position Logger]', payload);
      chrome.runtime.sendMessage({ type: 'sample', payload }).catch?.(() => {});
    } else if (data.type === 'status') {
      console.log('[2D Shooter Position Logger][status]', { frameUrl: location.href, payload: data.payload });
      chrome.runtime.sendMessage({ type: 'status', payload: data.payload }).catch?.(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'clear-page-log') {
      window.postMessage({ source: SOURCE, type: 'clear-page-log' }, '*');
    }
  });
})();
