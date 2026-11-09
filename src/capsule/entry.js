// Capsule entry — bundles every capsule module and defers mountCapsule()
// until the Host document has a head (the parser has processed the Host's
// html language declaration) and the DOM is ready.
import { mountCapsule } from './main.js';

function initializeCapsule() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!document.head) {
    const headObserver = new window.MutationObserver(() => {
      if (!document.head) return;
      headObserver.disconnect();
      initializeCapsule();
    });
    headObserver.observe(document, { childList: true, subtree: true });
    return;
  }
  if (document.readyState === 'loading' || !document.body) {
    window.addEventListener('DOMContentLoaded', mountCapsule, { once: true });
  } else {
    mountCapsule();
  }
}

initializeCapsule();
