// Registers the service worker after the page has settled.
// Guarded so nothing happens on unsupported browsers (Safari private, older
// WebViews) — the site simply behaves as a normal website.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}
