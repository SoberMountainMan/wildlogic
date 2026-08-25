/* Hog Convert — shared helpers */
(function () {
  'use strict';

  var Hog = {};

  Hog.fmtBytes = function (n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  Hog.stampYear = function () {
    document.querySelectorAll('.year').forEach(function (el) {
      el.textContent = new Date().getFullYear();
    });
  };

  Hog.status = function (msg, cls) {
    var el = document.getElementById('status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status-line' + (cls ? ' ' + cls : '');
  };

  Hog.showProgress = function (on) {
    var w = document.getElementById('progressWrap');
    if (w) w.classList.toggle('on', !!on);
    var r = document.getElementById('result');
    if (r && on) r.classList.remove('on');
  };

  Hog.setProgress = function (pct) {
    var b = document.querySelector('#progressBar > div');
    if (b) b.style.width = Math.max(0, Math.min(100, pct * 100)) + '%';
  };

  Hog.showResult = function (blobOrUrl, name, metaMsg) {
    var r = document.getElementById('result');
    if (!r) return;
    var a = r.querySelector('a.dl');
    var url = blobOrUrl instanceof Blob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    a.href = url;
    a.download = name;
    r.querySelector('.meta').textContent = metaMsg || '';
    r.classList.add('on');
    a.click();
  };

  /* Wire a .dropzone element + hidden file input. Calls onFiles(FileList). */
  Hog.dropzone = function (onFiles, opts) {
    opts = opts || {};
    var zone = document.getElementById('dropzone');
    var input = document.getElementById('fileInput');
    var list = document.getElementById('filelist');
    input.multiple = !!opts.multiple;
    if (opts.accept) input.accept = opts.accept;
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('over');
      if (e.dataTransfer.files.length) Hog.picked(e.dataTransfer.files, onFiles, list);
    });
    input.addEventListener('change', function () {
      if (input.files.length) Hog.picked(input.files, onFiles, list);
    });
  };

  Hog.picked = function (files, onFiles, list) {
    var items = Array.prototype.slice.call(files);
    if (list) {
      list.innerHTML = '';
      items.forEach(function (f) {
        var li = document.createElement('li');
        li.innerHTML = '<b></b><span></span>';
        li.querySelector('b').textContent = f.name;
        li.querySelector('span').textContent = Hog.fmtBytes(f.size);
        list.appendChild(li);
      });
    }
    onFiles(items);
    var btn = document.getElementById('runBtn');
    if (btn) btn.disabled = false;
  };

  Hog.loadScript = function (src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  };

  /* Lazy FFmpeg singleton (single-threaded core: no COOP/COEP needed).
     Glue libs are vendored locally (/convert/vendor/) so ad-blockers and
     flaky CDN responses can't half-break the suite; only the ~31 MB core
     comes from a CDN, with a mirror fallback. */
  var _ff = null;
  var _ffLoading = null;
  function blobURL(url, mime) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching engine');
      return r.blob();
    }).then(function (b) { return URL.createObjectURL(new Blob([b], { type: mime })); });
  }
  function firstOK(urls, mime) {
    return urls.reduce(function (chain, u) {
      return chain.catch(function () { return blobURL(u, mime); });
    }, Promise.reject());
  }
  Hog.getFFmpeg = function () {
    if (_ff) return Promise.resolve(_ff);
    if (_ffLoading) return _ffLoading;
    _ffLoading = Hog.loadScript('vendor/ffmpeg.js').then(function () {
      if (!window.FFmpegWASM || !FFmpegWASM.FFmpeg)
        throw new Error('Video engine was blocked by this browser (ad-blocker or privacy mode). Allow this site and reload.');
      var ff = new FFmpegWASM.FFmpeg();
      ff.on('progress', function (e) { Hog.setProgress(e.progress); });
      var core = ['https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/',
                  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/'];
      return Promise.all([
        firstOK(core.map(function (m) { return m + 'ffmpeg-core.js'; }), 'text/javascript'),
        firstOK(core.map(function (m) { return m + 'ffmpeg-core.wasm'; }), 'application/wasm')
      ]).then(function (urls) {
        return ff.load({ coreURL: urls[0], wasmURL: urls[1] });
      }).then(function () { return ff; });
    }).then(function (ff) { _ff = ff; return ff; })
      .catch(function (e) { _ffLoading = null; throw e; });
    return _ffLoading;
  };

  /* pdf-lib from local vendor copy, verified before use — PDFDocument methods
     are only trustworthy if the whole file parsed. */
  Hog.needPdfLib = function () {
    return Hog.loadScript('vendor/pdf-lib.min.js').then(function () {
      var ok = window.PDFLib && PDFLib.PDFDocument &&
               PDFLib.PDFDocument.prototype.copyPages &&
               PDFLib.PDFDocument.prototype.embedJpg;
      if (!ok) throw new Error('PDF engine failed to initialise — reload the page and try again.');
      return true;
    });
  };

  Hog.readAsUint8 = function (file) {
    return file.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  };

  window.Hog = Hog;
})();
