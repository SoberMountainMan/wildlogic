/* THE MISTBELT SERVICE WORKER (T7, owner GO: "Painting the forest" was 30-60 s of revalidation
   round-trips on a phone -- 148 pack files x max-age=600 expiry, every warm load past ten minutes,
   even though nothing re-downloaded). Cache-first for the art: the pack is 18.9 MB of PNGs that
   change rarely, so after the first visit the hill paints instantly and works OFFLINE -- which is
   not a luxury where Hogsback's connectivity is the constraint the whole project honours.
   BUMP THE VERSION when the pack's art changes, or stale sprites are the bug you shipped.

   2026-11-06: registration was DEAD CODE -- it sat in the PACK-MANIFEST.js fallback branch that
   start() never reaches when the inline manifest adopts. Live measurement: getRegistration() null
   on two loads, while a manual register('sw.js') worked. Fixed in index.html; v2 is the first
   cache that ever actually activates, so no stale v1 art can be served to anyone. */
/* The page registers this worker during HEAD parse (see the head script in index.html), so the
   148-image burst cannot starve the sw.js fetch. Measured on live: burst blocked = active in <3 s;
   burst firing = registration stuck in 'new/starting' for 60 s. */
var CACHE = 'mistbelt-pack-v2';
/* INSTALL FETCHES NOTHING. addAll(['index.html']) used to pull a 899 KB page at the exact moment
   adopt() fires 148 image requests over the same radio -- the install lost that race on a slow
   connection. The network-first isIndex branch below caches the page on the first successful
   navigation anyway, so offline boot is unchanged and the worker activates immediately. */
var CORE = [];

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
       boots from the last good copy instead of the browser's error page.
       AND THIS IS THE ART VERSION SIGNAL. Cache-first /pack/ files never revalidate, so a PNG
       re-encoded at the SAME url would be served stale for the life of the cache. The page itself
       is already fetched on every load, so compare its ETag with the copy we cached last time: a
       new deploy means a new ETag, which purges the art cache ONCE. No version bump to remember,
       no extra request, and warm loads still cost zero pack bytes between deploys.
       The old code called caches.open().then(put) without awaiting it inside respondWith -- a
       detached promise a terminating worker can drop. It is now part of the response chain. */
    var job = fetch(e.request).then(function (resp) {
      if (!resp || !resp.ok) return resp;
      var tag = resp.headers.get('etag') || resp.headers.get('last-modified') || '';
      var copy = resp.clone();
      return caches.match(e.request).then(function (old) {
        var oldTag = old ? (old.headers.get('etag') || old.headers.get('last-modified') || '') : null;
        if (old && tag && oldTag && oldTag !== tag) return caches.delete(CACHE);
        return null;
      }).then(function () {
        return caches.open(CACHE).then(function (c) { return c.put(e.request, copy); });
      }).then(function () { return resp; });
    }).catch(function () { return caches.match(e.request); });
    e.respondWith(job);
  }
});
