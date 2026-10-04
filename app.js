'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $('fileInput'), docTitle: $('docTitle'),
    pageInput: $('pageInput'), pageCount: $('pageCount'),
    btnPrev: $('btnPrev'), btnNext: $('btnNext'),
    btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), zoomSelect: $('zoomSelect'),
    btnSidebar: $('btnSidebar'), btnFullscreen: $('btnFullscreen'),
    viewer: $('viewer'), pages: $('pages'), thumbs: $('thumbs'), toc: $('toc'),
    searchForm: $('searchForm'), searchInput: $('searchInput'),
    searchStatus: $('searchStatus'), searchResults: $('searchResults'),
    recent: $('recent'), recentList: $('recentList'),
    dropOverlay: $('dropOverlay'), loading: $('loading'), loadingText: $('loadingText'), toast: $('toast'),
  };

  const CSS_DPI = 96;
  const PAGE_GAP = 14;
  const PAGES_PADDING = 16;
  const MAX_RENDERED = 16;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
  const STORE_PREFIX = 'djvu-reader:';
  const RECENT_MAX = 10;

  const worker = new DjVu.Worker();

  const state = {
    docId: 0,          // bumps on each opened file so stale async results are ignored
    fileKey: null,
    fileName: '',
    sizes: [],         // [{width, height, dpi}]
    pages: [],         // per-page view records
    zoomMode: 'fit-width',
    zoom: 1,
    current: 0,        // 0-based page index
    rendered: [],      // indices of pages that hold an image, oldest first
    visible: new Set(),
    texts: [],         // cached page texts for search
    search: null,      // {query, matches: [{page, start}], active}
    thumbQueue: [],
    thumbBusy: false,
  };

  // ---------- storage (best effort) ----------
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(STORE_PREFIX + key)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  // ---------- small UI helpers ----------
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
  }
  function setLoading(text) {
    els.loading.hidden = !text;
    if (text) els.loadingText.textContent = text;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pageDpi = (i) => {
    const dpi = state.sizes[i].dpi;
    return dpi >= 25 && dpi <= 2400 ? dpi : 300;
  };
  const baseScale = (i) => CSS_DPI / pageDpi(i);

  // ---------- opening files ----------
  async function openFile(file) {
    if (!file) return;
    const docId = ++state.docId;
    setLoading('กำลังเปิดไฟล์…');
    try {
      worker.cancelAllTasks();
      revokeAll();
      const buffer = await file.arrayBuffer();
      await worker.createDocument(buffer);
      const sizes = await worker.doc.getPagesSizes().run();
      if (docId !== state.docId) return;
      if (!sizes || !sizes.length) throw new Error('no pages');

      state.fileKey = `${file.name}|${file.size}|${file.lastModified}`;
      state.fileName = file.name;
      state.sizes = sizes;
      state.texts = new Array(sizes.length);
      state.search = null;
      state.rendered = [];
      state.visible.clear();
      state.thumbQueue = [];

      const saved = store.get('pos:' + state.fileKey);
      state.zoomMode = saved ? saved.zoomMode : 'fit-width';
      state.zoom = saved && typeof saved.zoom === 'number' ? saved.zoom : 1;

      document.body.classList.add('has-doc');
      document.title = `${file.name} — DjVu Reader`;
      els.docTitle.textContent = file.name;
      els.docTitle.title = file.name;
      els.pageCount.textContent = sizes.length;
      els.pageInput.max = sizes.length;
      els.searchResults.innerHTML = '';
      els.searchStatus.textContent = '';

      buildPages();
      buildThumbs();
      applyZoom(state.zoomMode === 'custom' ? state.zoom : state.zoomMode, { keepPosition: false });
      const startPage = saved ? clamp(saved.page, 0, sizes.length - 1) : 0;
      goToPage(startPage, saved ? saved.frac || 0 : 0);
      if (saved && startPage > 0) toast(`กลับไปยังหน้าที่อ่านค้างไว้: หน้า ${startPage + 1}`);
      savePosition();
      loadContents(docId);
      els.viewer.focus({ preventScroll: true });
    } catch (err) {
      console.error(err);
      if (docId === state.docId) toast('เปิดไฟล์ไม่ได้ — ไฟล์อาจไม่ใช่ DjVu หรือเสียหาย');
    } finally {
      if (docId === state.docId) setLoading(null);
      els.fileInput.value = '';
    }
  }

  function revokeAll() {
    for (const p of state.pages) {
      if (p.url) URL.revokeObjectURL(p.url);
    }
    state.pages = [];
    pageObserver.disconnect();
    thumbObserver.disconnect();
  }

  // ---------- page elements ----------
  function buildPages() {
    els.pages.innerHTML = '';
    const frag = document.createDocumentFragment();
    state.pages = state.sizes.map((size, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.index = i;
      const num = document.createElement('div');
      num.className = 'page-num';
      num.textContent = i + 1;
      el.appendChild(num);
      frag.appendChild(el);
      return { el, img: null, textLayer: null, zones: null, url: null, task: null, status: 'empty', thumb: null, thumbDone: false };
    });
    els.pages.appendChild(frag);
    state.pages.forEach((p) => pageObserver.observe(p.el));
  }

  function layoutPages() {
    const z = state.zoom;
    state.pages.forEach((p, i) => {
      const s = baseScale(i) * z;
      const { width, height } = state.sizes[i];
      p.el.style.width = `${Math.max(1, Math.round(width * s))}px`;
      p.el.style.height = `${Math.max(1, Math.round(height * s))}px`;
      p.el.style.setProperty('--s', s);
    });
  }

  const pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.index);
      if (e.isIntersecting) state.visible.add(i);
      else state.visible.delete(i);
    }
    scheduleRender();
  }, { root: els.viewer, rootMargin: '100% 0px' });

  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      // cancel queued work for pages that scrolled far away
      state.pages.forEach((p, i) => {
        if (p.status === 'loading' && !state.visible.has(i) && !worker.isTaskInProcess(p.task)) {
          worker.cancelTask(p.task);
          p.task = null;
          p.status = 'empty';
        }
      });
      const wanted = [...state.visible].sort((a, b) => Math.abs(a - state.current) - Math.abs(b - state.current));
      for (const i of wanted) {
        if (state.pages[i].status === 'empty') renderPage(i);
      }
    });
  }

  async function renderPage(i) {
    const p = state.pages[i];
    const docId = state.docId;
    p.status = 'loading';
    const task = worker.run(
      worker.doc.getPage(i + 1).createPngObjectUrl(),
      worker.doc.getPage(i + 1).getNormalizedTextZones(),
    );
    p.task = task;
    let result;
    try {
      result = await task;
    } catch (err) {
      if (docId !== state.docId || p.task !== task) return;
      console.error(`page ${i + 1}`, err);
      p.status = 'error';
      p.el.querySelector('.page-num').textContent = `หน้า ${i + 1}: แสดงผลไม่ได้`;
      return;
    }
    const [png, zones] = result;
    if (docId !== state.docId || p.task !== task) {
      if (png && png.url) URL.revokeObjectURL(png.url);
      return;
    }
    p.task = null;
    p.status = 'done';
    p.url = png.url;
    p.imgW = png.width;
    p.imgH = png.height;
    p.zones = zones || [];

    const img = document.createElement('img');
    img.alt = `หน้า ${i + 1}`;
    img.decoding = 'async';
    img.src = png.url;
    img.onload = () => { if (!p.thumbDone) drawThumb(i, img); };
    p.img = img;
    p.el.appendChild(img);
    buildTextLayer(i);

    state.rendered.push(i);
    evictPages();
  }

  function buildTextLayer(i) {
    const p = state.pages[i];
    if (p.textLayer) p.textLayer.remove();
    const layer = document.createElement('div');
    layer.className = 'text-layer';
    const W = p.imgW, H = p.imgH;
    for (const z of p.zones) {
      if (!z.text) continue;
      const span = document.createElement('span');
      span.textContent = z.text;
      span.style.left = `${(z.x / W) * 100}%`;
      span.style.top = `${(z.y / H) * 100}%`;
      span.style.fontSize = `calc(var(--s) * ${z.height * 0.85}px)`;
      layer.appendChild(span);
    }
    p.textLayer = layer;
    p.el.appendChild(layer);
    drawHighlights(i);
  }

  function evictPages() {
    while (state.rendered.length > MAX_RENDERED) {
      // drop the page farthest from the current one that is not on screen
      let best = -1, bestDist = -1;
      state.rendered.forEach((idx, k) => {
        if (state.visible.has(idx)) return;
        const d = Math.abs(idx - state.current);
        if (d > bestDist) { bestDist = d; best = k; }
      });
      if (best < 0) return;
      const [idx] = state.rendered.splice(best, 1);
      const p = state.pages[idx];
      if (p.url) URL.revokeObjectURL(p.url);
      p.img && p.img.remove();
      p.textLayer && p.textLayer.remove();
      Object.assign(p, { url: null, img: null, textLayer: null, zones: null, status: 'empty' });
    }
  }

  // ---------- thumbnails ----------
  const THUMB_W = 120;
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.index);
      const p = state.pages[i];
      if (!p) continue;
      if (e.isIntersecting && !p.thumbDone && !state.thumbQueue.includes(i)) state.thumbQueue.push(i);
      if (!e.isIntersecting) state.thumbQueue = state.thumbQueue.filter((x) => x !== i);
    }
    pumpThumbs();
  }, { root: $('tab-thumbs'), rootMargin: '200px 0px' });

  function buildThumbs() {
    els.thumbs.innerHTML = '';
    const frag = document.createDocumentFragment();
    state.pages.forEach((p, i) => {
      const t = document.createElement('div');
      t.className = 'thumb';
      t.dataset.index = i;
      const ph = document.createElement('div');
      ph.className = 'thumb-ph';
      const { width, height } = state.sizes[i];
      ph.style.height = `${Math.round(THUMB_W * height / width)}px`;
      const label = document.createElement('span');
      label.textContent = i + 1;
      t.append(ph, label);
      t.addEventListener('click', () => goToPage(i));
      p.thumb = t;
      frag.appendChild(t);
    });
    els.thumbs.appendChild(frag);
    state.pages.forEach((p) => thumbObserver.observe(p.thumb));
  }

  function drawThumb(i, img) {
    const p = state.pages[i];
    if (!p || p.thumbDone) return;
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(THUMB_W * ratio);
    canvas.height = Math.round(canvas.width * img.naturalHeight / img.naturalWidth);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const ph = p.thumb.querySelector('.thumb-ph, canvas');
    ph.replaceWith(canvas);
    p.thumbDone = true;
  }

  // Thumbnails are rendered one at a time and only while the main view is idle.
  async function pumpThumbs() {
    if (state.thumbBusy) return;
    const mainBusy = state.pages.some((p) => p.status === 'loading');
    if (mainBusy) { setTimeout(pumpThumbs, 300); return; }
    const i = state.thumbQueue.shift();
    if (i === undefined) return;
    const p = state.pages[i];
    if (!p || p.thumbDone) { pumpThumbs(); return; }
    if (p.img && p.img.complete) { drawThumb(i, p.img); pumpThumbs(); return; }
    state.thumbBusy = true;
    const docId = state.docId;
    try {
      const png = await worker.doc.getPage(i + 1).createPngObjectUrl().run();
      if (docId === state.docId) {
        const img = new Image();
        img.src = png.url;
        await img.decode();
        drawThumb(i, img);
      }
      URL.revokeObjectURL(png.url);
    } catch (err) {
      console.warn('thumb', i + 1, err);
    } finally {
      state.thumbBusy = false;
      pumpThumbs();
    }
  }

  // ---------- navigation ----------
  function pageTop(i) {
    return state.pages[i].el.offsetTop;
  }

  function goToPage(i, frac = 0) {
    if (!state.pages.length) return;
    i = clamp(i, 0, state.pages.length - 1);
    const el = state.pages[i].el;
    els.viewer.scrollTop = pageTop(i) - PAGES_PADDING + frac * el.offsetHeight;
    setCurrent(i);
  }

  function setCurrent(i) {
    if (i === state.current && els.pageInput.value == i + 1) return;
    const prev = state.pages[state.current];
    if (prev && prev.thumb) prev.thumb.classList.remove('current');
    state.current = i;
    els.pageInput.value = i + 1;
    const cur = state.pages[i];
    if (cur && cur.thumb) {
      cur.thumb.classList.add('current');
      const panel = $('tab-thumbs');
      const t = cur.thumb;
      if (panel.classList.contains('active') && (t.offsetTop < panel.scrollTop || t.offsetTop + t.offsetHeight > panel.scrollTop + panel.clientHeight)) {
        panel.scrollTop = t.offsetTop - panel.clientHeight / 2 + t.offsetHeight / 2;
      }
    }
    savePositionSoon();
  }

  // Which page sits at ~30% of the viewport height?
  function pageAtScroll() {
    const y = els.viewer.scrollTop + els.viewer.clientHeight * 0.3;
    let lo = 0, hi = state.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pageTop(mid) <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function currentFrac() {
    if (!state.pages.length) return 0;
    const i = state.current;
    const el = state.pages[i].el;
    return clamp((els.viewer.scrollTop + PAGES_PADDING - el.offsetTop) / el.offsetHeight, 0, 1);
  }

  els.viewer.addEventListener('scroll', () => {
    if (!state.pages.length) return;
    setCurrent(pageAtScroll());
  }, { passive: true });

  // ---------- zoom ----------
  function computeZoom(mode) {
    const availW = els.viewer.clientWidth - PAGES_PADDING * 2 - 2;
    const availH = els.viewer.clientHeight - PAGES_PADDING * 2;
    if (mode === 'fit-width') {
      const maxW = Math.max(...state.sizes.map((s, i) => s.width * baseScale(i)));
      return availW / maxW;
    }
    if (mode === 'fit-page') {
      const i = state.current;
      const s = state.sizes[i];
      return Math.min(availW / (s.width * baseScale(i)), availH / (s.height * baseScale(i)));
    }
    return Number(mode);
  }

  function applyZoom(mode, { keepPosition = true } = {}) {
    if (!state.pages.length) return;
    const page = state.current;
    const frac = keepPosition ? currentFrac() : 0;
    const scrollXFrac = els.viewer.scrollWidth > els.viewer.clientWidth
      ? (els.viewer.scrollLeft + els.viewer.clientWidth / 2) / els.viewer.scrollWidth : 0.5;

    if (mode === 'fit-width' || mode === 'fit-page') {
      state.zoomMode = mode;
    } else {
      state.zoomMode = 'custom';
    }
    state.zoom = clamp(computeZoom(mode), MIN_ZOOM, MAX_ZOOM);
    layoutPages();
    updateZoomSelect();

    if (keepPosition) {
      goToPage(page, frac);
      els.viewer.scrollLeft = scrollXFrac * els.viewer.scrollWidth - els.viewer.clientWidth / 2;
    }
    savePositionSoon();
  }

  function updateZoomSelect() {
    const sel = els.zoomSelect;
    const custom = sel.querySelector('option[value=custom]');
    if (state.zoomMode !== 'custom') {
      sel.value = state.zoomMode;
      custom.hidden = true;
      return;
    }
    const preset = [...sel.options].find((o) => Number(o.value) && Math.abs(Number(o.value) - state.zoom) < 0.001);
    if (preset) {
      sel.value = preset.value;
      custom.hidden = true;
    } else {
      custom.textContent = `${Math.round(state.zoom * 100)}%`;
      custom.hidden = false;
      sel.value = 'custom';
    }
  }

  function zoomStep(dir) {
    const z = state.zoom;
    const next = dir > 0
      ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM
      : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
    applyZoom(next);
  }

  els.zoomSelect.addEventListener('change', () => {
    if (els.zoomSelect.value !== 'custom') applyZoom(els.zoomSelect.value);
  });
  els.btnZoomIn.addEventListener('click', () => zoomStep(1));
  els.btnZoomOut.addEventListener('click', () => zoomStep(-1));

  let wheelZoom = null;
  els.viewer.addEventListener('wheel', (e) => {
    if (!state.pages.length || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    wheelZoom = (wheelZoom ?? state.zoom) * Math.exp(-e.deltaY * 0.01);
    requestAnimationFrame(() => {
      if (wheelZoom === null) return;
      const z = wheelZoom;
      wheelZoom = null;
      applyZoom(clamp(z, MIN_ZOOM, MAX_ZOOM));
    });
  }, { passive: false });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') applyZoom(state.zoomMode);
    }, 120);
  });

  // ---------- remembering position ----------
  let saveTimer;
  function savePositionSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 400);
  }
  function savePosition() {
    if (!state.fileKey) return;
    const pos = {
      page: state.current,
      frac: Math.round(currentFrac() * 1000) / 1000,
      zoomMode: state.zoomMode,
      zoom: state.zoom,
    };
    store.set('pos:' + state.fileKey, pos);
    const recent = (store.get('recent') || []).filter((r) => r.key !== state.fileKey);
    recent.unshift({ key: state.fileKey, name: state.fileName, page: state.current + 1, pages: state.pages.length, ts: Date.now() });
    store.set('recent', recent.slice(0, RECENT_MAX));
  }
  window.addEventListener('pagehide', savePosition);

  function renderRecent() {
    const recent = store.get('recent') || [];
    els.recent.hidden = !recent.length;
    els.recentList.innerHTML = '';
    for (const r of recent) {
      const li = document.createElement('li');
      const d = new Date(r.ts);
      li.textContent = `${r.name} — หน้า ${r.page}/${r.pages} `;
      const when = document.createElement('span');
      when.className = 'muted small';
      when.textContent = `(${d.toLocaleDateString('th-TH')})`;
      li.appendChild(when);
      els.recentList.appendChild(li);
    }
  }

  // ---------- table of contents ----------
  async function loadContents(docId) {
    els.toc.innerHTML = '<p class="muted pad">กำลังโหลด…</p>';
    let contents;
    try {
      contents = await worker.doc.getContents().run();
    } catch (err) {
      console.warn(err);
    }
    if (docId !== state.docId) return;
    if (!contents || !contents.length) {
      els.toc.innerHTML = '<p class="muted pad">ไฟล์นี้ไม่มีสารบัญ</p>';
      return;
    }
    // resolve every bookmark url to a page number in one batch
    const flat = [];
    (function walk(list) { for (const b of list) { flat.push(b); if (b.children) walk(b.children); } })(contents);
    let numbers = [];
    try {
      numbers = await worker.run(...flat.map((b) => worker.doc.getPageNumberByUrl(b.url)));
      if (flat.length === 1) numbers = [numbers];
    } catch (err) {
      console.warn(err);
    }
    if (docId !== state.docId) return;
    flat.forEach((b, k) => { b.page = numbers[k]; });
    // grouping bookmarks often have no url: use their first child's page
    const firstPage = (b) => b.page || (b.children && b.children.length ? firstPage(b.children[0]) : null);
    flat.forEach((b) => { b.page = firstPage(b); });

    const build = (list) => {
      const ul = document.createElement('ul');
      for (const b of list) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        const tw = document.createElement('span');
        tw.className = 'twisty';
        const title = document.createElement('span');
        title.textContent = b.description || '(ไม่มีชื่อ)';
        const pg = document.createElement('span');
        pg.className = 'toc-page';
        pg.textContent = b.page ? b.page : '';
        row.append(tw, title, pg);
        li.appendChild(row);
        if (b.children && b.children.length) {
          tw.textContent = '▼';
          tw.addEventListener('click', (e) => {
            e.stopPropagation();
            li.classList.toggle('collapsed');
            tw.textContent = li.classList.contains('collapsed') ? '▶' : '▼';
          });
          li.appendChild(build(b.children));
        }
        row.addEventListener('click', () => {
          if (b.page) goToPage(b.page - 1);
          else if (/^https?:/i.test(b.url)) window.open(b.url, '_blank', 'noopener');
        });
        ul.appendChild(li);
      }
      return ul;
    };
    els.toc.innerHTML = '';
    els.toc.appendChild(build(contents));
  }

  // ---------- search ----------
  const norm = (s) => s.toLocaleLowerCase('th').replace(/\s+/g, ' ');
  let searchRun = 0;

  async function runSearch(rawQuery) {
    const query = norm(rawQuery).trim();
    const run = ++searchRun;
    const docId = state.docId;
    els.searchResults.innerHTML = '';
    clearHighlights();
    state.search = null;
    if (!query) { els.searchStatus.textContent = ''; return; }

    const total = state.pages.length;
    const matches = [];
    let pagesWithText = 0;
    const MAX_RESULTS = 500;
    const BATCH = 8;
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn';
    stopBtn.textContent = 'หยุด';
    stopBtn.style.marginLeft = '8px';
    stopBtn.onclick = () => { searchRun++; };

    for (let start = 0; start < total; start += BATCH) {
      if (run !== searchRun || docId !== state.docId) break;
      els.searchStatus.textContent = `กำลังค้นหา… หน้า ${Math.min(start + BATCH, total)}/${total} (พบ ${matches.length})`;
      els.searchStatus.appendChild(stopBtn);
      const idx = [];
      for (let i = start; i < Math.min(start + BATCH, total); i++) if (state.texts[i] === undefined) idx.push(i);
      if (idx.length) {
        try {
          let res = await worker.run(...idx.map((i) => worker.doc.getPage(i + 1).getText()));
          if (idx.length === 1) res = [res];
          idx.forEach((i, k) => { state.texts[i] = res[k] || ''; });
        } catch (err) {
          console.warn(err);
          idx.forEach((i) => { if (state.texts[i] === undefined) state.texts[i] = ''; });
        }
      }
      if (run !== searchRun || docId !== state.docId) break;
      for (let i = start; i < Math.min(start + BATCH, total); i++) {
        const text = state.texts[i];
        if (text) pagesWithText++;
        const hay = norm(text);
        let pos = hay.indexOf(query);
        while (pos !== -1 && matches.length < MAX_RESULTS) {
          const m = { page: i, start: pos };
          matches.push(m);
          addResult(m, hay, query, matches.length - 1);
          pos = hay.indexOf(query, pos + query.length);
        }
      }
      if (matches.length >= MAX_RESULTS) break;
    }
    if (docId !== state.docId) return;
    const stopped = run !== searchRun;
    if (!stopped) searchRun++;
    state.search = { query, matches, active: -1 };
    if (!matches.length) {
      els.searchStatus.textContent = pagesWithText === 0 && !stopped
        ? 'ไม่พบชั้นข้อความในไฟล์นี้ (ไฟล์สแกนที่ไม่มี OCR จึงค้นหาไม่ได้)'
        : 'ไม่พบคำที่ค้นหา';
    } else {
      els.searchStatus.textContent = `พบ ${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} ตำแหน่ง${stopped ? ' (หยุดค้นหาแล้ว)' : ''}`;
    }
    state.pages.forEach((_, i) => drawHighlights(i));
  }

  function addResult(m, hay, query, k) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = `หน้า ${m.page + 1}: `;
    const before = hay.slice(Math.max(0, m.start - 40), m.start);
    const after = hay.slice(m.start + query.length, m.start + query.length + 60);
    const mark = document.createElement('mark');
    mark.textContent = hay.substr(m.start, query.length);
    li.append(b, (m.start > 40 ? '…' : '') + before, mark, after + '…');
    li.addEventListener('click', () => activateResult(k));
    els.searchResults.appendChild(li);
  }

  function activateResult(k) {
    if (!state.search) {
      // search still running: results are clickable, jump to the page
      const li = els.searchResults.children[k];
      const page = Number(li.querySelector('b').textContent.match(/\d+/)[0]) - 1;
      goToPage(page);
      return;
    }
    const m = state.search.matches[k];
    state.search.active = k;
    [...els.searchResults.children].forEach((li, j) => li.classList.toggle('active', j === k));
    goToPage(m.page);
    drawHighlights(m.page);
    // scroll the first highlight of this page into view once it exists
    const reveal = () => {
      const hl = state.pages[m.page].el.querySelector('.hl.active') || state.pages[m.page].el.querySelector('.hl');
      if (hl) {
        const v = els.viewer;
        v.scrollTop = state.pages[m.page].el.offsetTop + hl.offsetTop - v.clientHeight / 3;
      }
      return !!hl || state.pages[m.page].status === 'done';
    };
    if (!reveal()) {
      const iv = setInterval(() => { if (reveal()) clearInterval(iv); }, 150);
      setTimeout(() => clearInterval(iv), 30000);
    }
  }

  function clearHighlights() {
    els.pages.querySelectorAll('.hl').forEach((n) => n.remove());
  }

  // Find the text zones that cover each occurrence of the query on page i.
  function matchZones(zones, query) {
    const hits = [];
    for (const joiner of [' ', '']) {
      let text = '';
      const ranges = zones.map((z) => {
        const t = norm(z.text || '').trim();
        const startPos = text.length;
        text += t + joiner;
        return [startPos, startPos + t.length];
      });
      let pos = text.indexOf(query);
      while (pos !== -1) {
        const end = pos + query.length;
        const hit = [];
        ranges.forEach(([a, b], k) => { if (a < end && b > pos) hit.push(k); });
        if (hit.length) hits.push(hit);
        pos = text.indexOf(query, end);
      }
      if (hits.length) break;
    }
    return hits;
  }

  function drawHighlights(i) {
    const p = state.pages[i];
    if (!p) return;
    p.el.querySelectorAll('.hl').forEach((n) => n.remove());
    if (!state.search || !state.search.matches.length || p.status !== 'done' || !p.zones.length) return;
    const pageMatches = state.search.matches.filter((m) => m.page === i);
    if (!pageMatches.length) return;
    const activeM = state.search.matches[state.search.active];
    const activeOrdinal = activeM && activeM.page === i ? pageMatches.indexOf(activeM) : -1;
    const hits = matchZones(p.zones, state.search.query);
    hits.forEach((hit, ordinal) => {
      for (const k of hit) {
        const z = p.zones[k];
        const d = document.createElement('div');
        d.className = 'hl' + (ordinal === activeOrdinal ? ' active' : '');
        d.style.left = `${(z.x / p.imgW) * 100}%`;
        d.style.top = `${(z.y / p.imgH) * 100}%`;
        d.style.width = `${(z.width / p.imgW) * 100}%`;
        d.style.height = `${(z.height / p.imgH) * 100}%`;
        p.el.insertBefore(d, p.textLayer);
      }
    });
  }

  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(els.searchInput.value);
  });

  // ---------- sidebar & tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'thumbs') setCurrent(state.current);
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  function toggleSidebar(force) {
    const hidden = document.body.classList.toggle('sidebar-hidden', force === undefined ? undefined : !force);
    store.set('sidebarHidden', hidden);
    if (state.zoomMode !== 'custom') applyZoom(state.zoomMode);
  }
  els.btnSidebar.addEventListener('click', () => toggleSidebar());
  if (store.get('sidebarHidden') || window.matchMedia('(max-width: 700px)').matches) {
    document.body.classList.add('sidebar-hidden');
  }

  // ---------- toolbar wiring ----------
  els.fileInput.addEventListener('change', () => openFile(els.fileInput.files[0]));
  els.btnPrev.addEventListener('click', () => goToPage(state.current - 1));
  els.btnNext.addEventListener('click', () => goToPage(state.current + 1));
  els.pageInput.addEventListener('change', () => {
    const n = parseInt(els.pageInput.value, 10);
    if (Number.isFinite(n)) goToPage(n - 1);
    else els.pageInput.value = state.current + 1;
    els.viewer.focus({ preventScroll: true });
  });
  els.btnFullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });

  document.addEventListener('keydown', (e) => {
    if (!state.pages.length) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === '0') { e.preventDefault(); applyZoom('fit-width'); return; }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleSidebar(true);
      showTab('search');
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (typing || mod || e.altKey) return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); goToPage(state.current - 1); break;
      case 'ArrowRight': e.preventDefault(); goToPage(state.current + 1); break;
      case 'Home': e.preventDefault(); goToPage(0); break;
      case 'End': e.preventDefault(); goToPage(state.pages.length - 1); break;
    }
  });

  // ---------- drag & drop ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropOverlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });

  renderRecent();
})();
