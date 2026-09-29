// Static hosts can't send COOP/COEP headers, so a tiny service worker adds them.
// That makes the page cross-origin isolated, which lets onnxruntime use WASM threads.
// It only rewrites headers on same-origin GETs; no media ever passes through it.
(() => {
  if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const flag = 'bgm-isolation-attempt';
  const script = new URL('./isolation-worker.js', document.currentScript.src);
  navigator.serviceWorker.register(script).then(async () => {
    await navigator.serviceWorker.ready;
    const reloadOnce = () => {
      if (sessionStorage.getItem(flag)) return;
      sessionStorage.setItem(flag, '1');
      location.reload();
    };
    if (navigator.serviceWorker.controller) reloadOnce();
    else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  }).catch(() => {});
})();
