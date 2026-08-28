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
    /* the wrapper stays display:none until a run starts, but pick-time errors
       must be readable too — reveal it whenever there is something to say */
    var w = document.getElementById('progressWrap');
    if (w && msg) w.classList.add('on');
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

  /* onFiles returns false to reject the pick — the run button then stays
     disabled and the file is not listed. The plain list is rendered BEFORE
     onFiles so a tool that draws its own richer list there is not clobbered. */
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
    var ok = onFiles(items);
    var btn = document.getElementById('runBtn');
    if (btn) btn.disabled = ok === false;
    if (ok === false && list) list.innerHTML = '';
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

  /* Measured from the shipped core: ffmpeg-core.wasm declares linear memory
     with a maximum of 32768 pages of 64 KiB — exactly 2 GiB. Source bytes, the
     encoded result and ffmpeg's own buffers all share that one budget, and
     nothing uploads, so no device can go bigger than the browser's ceiling. */
  Hog.MEM_LIMIT = 2 * 1024 * 1024 * 1024;
  Hog.MAX_VIDEO_INPUT = 1 * 1024 * 1024 * 1024;          // the result needs the other half
  Hog.MAX_AUDIO_INPUT = Hog.MEM_LIMIT - 256 * 1024 * 1024; // an audio result is tens of MB

  function gib(n) { return (n / 1073741824).toFixed(1); }

  /* Returns rejection copy, or null when the file may proceed. Checks
     file.size only — it reads no bytes and downloads no engine, so a job that
     cannot possibly finish is refused the instant it is picked. */
  Hog.guardInput = function (file, maxBytes) {
    if (!file || !file.size || file.size <= maxBytes) return null;
    return 'That file is ' + gib(file.size) + ' GB, and this tool takes sources up to ' +
      gib(maxBytes) + ' GB. Hog Convert keeps the source and the result together inside ' +
      '2 GB of in-browser memory, and nothing uploads here — so no device can process a ' +
      'file this size. Trim or split it first, then run the piece you need.';
  };

  /* Read the input BEFORE loading the engine. Hog.getFFmpeg() pulls a 31 MB
     core, and a file picked on a phone is a temporary link into another app's
     storage — that gap is long enough for the link to lapse or for the bytes
     to be evicted, which surfaces as a "could not be read" permission error. */
  Hog.prepareInput = function (file) {
    return Hog.readAsUint8(file).then(function (data) {
      return Hog.getFFmpeg().then(function (ff) { return { ff: ff, data: data }; });
    });
  };

  /* offline shell: pages network-first, assets cache-first (convert/sw.js) */
  var secure = location.protocol === 'https:' ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && secure) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  window.Hog = Hog;
})();
