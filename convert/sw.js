/* Hog Convert offline shell — pages fresh-when-online, cached-when-offline;
   heavy assets cache-first after first use (incl. CDN cores as opaque entries). */
var CACHE = 'hog-convert-v3';
var PRECACHE = ['./', 'hog.css', 'hog.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* only these third-party hosts are worth keeping offline — the ffmpeg core
   is the big one (~31 MB) and comes from unpkg with a jsdelivr mirror */
var CACHEABLE_HOSTS = ['unpkg.com', 'jsdelivr.net', 'docs.opencv.org'];

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;
  var url = new URL(req.url);
  var sameOrigin = url.origin === location.origin;
  if (!sameOrigin && CACHEABLE_HOSTS.indexOf(url.hostname) === -1) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('./'); });
      })
    );
    return;
  }

  /* Our OWN files (hog.js, hog.css, anything else on this origin) are small and change
     every time we ship, so they are NETWORK-FIRST with a cache fallback: online always
     yields the current bytes, offline still works from the cache. Serving them
     cache-first is how a returning visitor got a NEW page against a STALE hog.js and hit
     "Hog.needPdfJs is not a function" — a shared library must not be able to pin itself,
     because forgetting to bump CACHE is silent and this trap has now fired twice.
     Third-party CDN cores stay cache-first below: re-downloading the 31 MB ffmpeg core
     on every visit is exactly what the cache is for, and those bytes never change. */
  if (sameOrigin) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
