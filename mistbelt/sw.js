/* THE MISTBELT SERVICE WORKER (T7, owner GO: "Painting the forest" was 30-60 s of revalidation
   round-trips on a phone -- 148 pack files x max-age=600 expiry, every warm load past ten minutes,
   even though nothing re-downloaded). Cache-first for the art: the pack is 18.9 MB of PNGs that
   change rarely, so after the first visit the hill paints instantly and works OFFLINE -- which is
   not a luxury where Hogsback's connectivity is the constraint the whole project honours.
   BUMP THE VERSION when the pack's art changes, or stale sprites are the bug you shipped. */
var CACHE = 'mistbelt-pack-v1';
var CORE = ['index.html'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.pathname.indexOf('/mistbelt/') !== 0 && url.pathname.indexOf('/mistbelt/') !== url.pathname.indexOf('mistbelt')) {
    if (url.pathname.indexOf('mistbelt') < 0) return;
  }
  var isPack = url.pathname.indexOf('/pack/') >= 0;
  var isIndex = /\/mistbelt\/(index\.html)?$/.test(url.pathname);
  if (isPack) {
    /* ART: cache-first. Immutable in practice -- bump CACHE above when the pack changes. */
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        return hit || fetch(e.request).then(function (resp) {
          if (resp && resp.ok) { var copy = resp.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
          return resp;
        });
      })
    );
    return;
  }
  if (isIndex) {
    /* THE GAME: network-first, cache as the fallback. Updates land on the next load; offline still
       boots from the last good copy instead of the browser's error page. */
    e.respondWith(
      fetch(e.request).then(function (resp) {
        if (resp && resp.ok) { var copy = resp.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
        return resp;
      }).catch(function () { return caches.match(e.request); })
    );
  }
});
