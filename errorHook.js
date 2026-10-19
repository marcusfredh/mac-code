// First script in renderer.html: catches window errors from the very start, before the
// notes store has loaded. Records are logged to errors.log via main right away and handed
// to notesView's sink once it exists (until then they wait in window.__macErrorQueue).
// Never throws.
(function () {
  'use strict';
  try {
    if (window.__macErrorHook) return;
    window.__macErrorHook = true;
    const queue = window.__macErrorQueue = [];
    const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

    function handle(rec) {
      try {
        if (/^ResizeObserver loop/.test(rec.message)) return;
        rec.at = Date.now();
        try { if (window.errorsApi) window.errorsApi.log(rec); } catch (_) {}
        const sink = window.__macErrorSink;
        if (typeof sink === 'function') sink(rec);
        else if (queue.length < 100) queue.push(rec);
      } catch (_) {}
    }

    window.addEventListener('error', (e) => {
      try {
        const err = e && e.error;
        handle({
          source: 'renderer',
          name: cut(err && err.name || 'Error', 100),
          message: cut(err && err.message || (e && e.message), 2000),
          stack: cut(err && err.stack, 16384),
          filename: cut(e && e.filename, 500),
          hasError: !!err
        });
      } catch (_) {}
    });

    window.addEventListener('unhandledrejection', (e) => {
      try {
        const r = e && e.reason;
        const isObj = r && typeof r === 'object';
        handle({
          source: 'renderer (promise)',
          name: cut(isObj && r.name || 'UnhandledRejection', 100),
          message: cut(isObj ? r.message : r, 2000),
          stack: cut(isObj && r.stack, 16384),
          filename: '',
          hasError: true
        });
      } catch (_) {}
    });
  } catch (_) {}
})();
