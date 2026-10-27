(() => {
  'use strict';
  const FF = window.FF;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------------- state ----------------
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('framecut') || '{}'); } catch { return {}; } })();
  const savePrefs = () => {
    try {
      localStorage.setItem('framecut', JSON.stringify({
        fmt: $('fmt').value, codec: $('codec').value, quality: $('quality').value,
        merge: $('merge').checked, outDir: S.outDir, trimMode: S.trimMode,
      }));
    } catch {}
  };

  const S = {
    file: null,
    info: null,
    segs: [],
    sel: 0,
    edit: freshEdit(),
    aspect: 'free',
    view: 'edit',
    trimMode: prefs.trimMode === 'keyframe' ? 'keyframe' : 'precise',
    encoders: { h264: [], hevc: [] },
    outDir: prefs.outDir || null,
    exporting: false,
    tl: { start: 0, dur: 1 },
  };
  function freshEdit() {
    return { crop: { x: 0, y: 0, w: 1, h: 1 }, rotate: 0, flipH: false, flipV: false, size: { mode: 'crop' }, fit: 'stretch' };
  }

  const video = $('video');
  const stage = $('stage');
  const viewport = $('viewport');
  const cropBox = $('cropBox');
  const canvas = $('previewCanvas');
  const ctx = canvas.getContext('2d');
  const timeline = $('timeline');
  const track = $('track');

  // ---------------- formatting ----------------
  function fmtTime(t, short) {
    if (!isFinite(t)) t = 0;
    const neg = t < 0; t = Math.abs(t);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const ss = short ? String(Math.floor(s)).padStart(2, '0') : s.toFixed(2).padStart(5, '0');
    return (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`);
  }
  const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

  // ---------------- toast ----------------
  let toastTimer;
  function toast(msg, opts = {}) {
    const t = $('toast');
    t.innerHTML = '';
    t.className = 'toast' + (opts.error ? ' err' : '');
    const m = document.createElement('div');
    m.className = 'tmsg';
    m.textContent = msg;
    t.appendChild(m);
    const a = document.createElement('div');
    a.className = 'tact';
    for (const act of opts.actions || []) {
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = act.label;
      b.onclick = () => { act.run(); };
      a.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'link';
    x.textContent = 'Dismiss';
    x.onclick = () => (t.hidden = true);
    a.appendChild(x);
    t.appendChild(a);
    t.hidden = false;
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(() => (t.hidden = true), opts.error ? 15000 : 8000);
  }

  // ---------------- geometry ----------------
  const src = () => FF.orientedSize(S.info); // oriented source pixel size
  const frameAspect = () => { const s = src(); return (s.w * (S.info.sar || 1)) / s.h; }; // display aspect
  // Ratio of normalized width/height that gives a display aspect `a`.
  const normRatio = (a) => a / frameAspect();
  function aspectValue(key) {
    if (key === 'free') return null;
    if (key === 'orig') return frameAspect();
    const [a, b] = key.split(':').map(Number);
    // The crop lives in source space, so a 90° turn swaps the shape needed.
    return S.edit.rotate % 180 ? b / a : a / b;
  }
  function plan() {
    const p = FF.buildVideoFilters(S.info, S.edit);
    p.reencode = p.filters.length > 0;
    return p;
  }
  function contentAspect(p) {
    const sar = S.info.sar || 1;
    let w = p.crop.w * sar, h = p.crop.h;
    if (S.edit.rotate % 180) [w, h] = [h, w];
    return w / h;
  }

  // ---------------- layout ----------------
  function layout() {
    if (!S.info) return;
    const r = stage.getBoundingClientRect();
    const pad = 18;
    const bottom = 56;
    const aw = r.width - pad * 2;
    const ah = r.height - pad - bottom;
    const fit = (aspect) => {
      let w = aw, h = aw / aspect;
      if (h > ah) { h = ah; w = ah * aspect; }
      return { w: Math.max(10, w), h: Math.max(10, h), x: (r.width - w) / 2, y: pad + (ah - h) / 2 };
    };
    if (S.view === 'edit') {
      const v = fit(frameAspect());
      Object.assign(viewport.style, { left: '0px', top: '0px', width: `${v.w}px`, height: `${v.h}px` });
      if (!S.dragging) fitView(v.w, v.h, fit, r.width / 2, pad + ah / 2);
      drawCrop();
    } else {
      const p = plan();
      const c = fit(p.outW / p.outH);
      Object.assign(canvas.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(Math.min(c.w * dpr, p.outW));
      canvas.height = Math.round(Math.min(c.h * dpr, p.outH));
      drawPreview();
    }
  }
  new ResizeObserver(layout).observe(stage);

  // Edit view is a viewfinder: rotate/flip the frame like the export and scale it so the crop fills the stage.
  let view = new DOMMatrix();
  function fitView(bw, bh, fit, cx, cy) {
    const c = S.edit.crop, r90 = S.edit.rotate % 180 !== 0;
    const boxW = c.w * bw, boxH = c.h * bh;
    const t = fit(r90 ? boxH / boxW : boxW / boxH);
    // Once zoomed in, shrink the box a little so some surrounding picture stays visible.
    const k = 1 - 0.15 * clamp((Math.min(1 / c.w, 1 / c.h) - 1) * 2, 0, 1);
    const s = (k * t.w) / (r90 ? boxH : boxW);
    view = new DOMMatrix().translate(cx, cy)
      .scale(S.edit.flipH ? -1 : 1, S.edit.flipV ? -1 : 1)
      .rotate(S.edit.rotate)
      .scale(s)
      .translate(-(c.x + c.w / 2) * bw, -(c.y + c.h / 2) * bh);
    viewport.style.transform = view.toString();
    viewport.style.setProperty('--inv', 1 / s); // keeps handles and outline a constant screen size
  }
  // Pointer position -> normalized source-frame coords (undoes the view transform).
  function toNorm(e) {
    const r = stage.getBoundingClientRect();
    const p = view.inverse().transformPoint(new DOMPoint(e.clientX - r.left, e.clientY - r.top));
    return { x: p.x / viewport.offsetWidth, y: p.y / viewport.offsetHeight };
  }

  // ---------------- crop overlay ----------------
  function drawCrop() {
    const c = S.edit.crop;
    Object.assign(cropBox.style, {
      left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%`,
    });
    const p = plan();
    $('cropLabel').textContent = `${p.crop.w} × ${p.crop.h}`;
    // ponytail: label hidden when rotated/flipped (it would turn with the frame); counter-rotate it if wanted.
    $('cropLabel').hidden = p.crop.full || S.edit.rotate !== 0 || S.edit.flipH || S.edit.flipV;
    // Handles turn with the frame, so swap their resize cursors to match the on-screen direction.
    const r90 = S.edit.rotate % 180 !== 0;
    cropBox.classList.toggle('swapEdges', r90);
    cropBox.classList.toggle('swapCorners', r90 !== (S.edit.flipH !== S.edit.flipV));
  }

  function setCrop(c, fromZoom) {
    const s = src();
    const minW = Math.min(1, 16 / s.w), minH = Math.min(1, 16 / s.h);
    const w = clamp(c.w, minW, 1), h = clamp(c.h, minH, 1);
    S.edit.crop = { x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, 1 - h), w, h };
    if (!fromZoom) syncZoom();
    refresh(!S.dragging); // refit the view, except mid-drag so the box doesn't slide under the pointer
  }

  function maxRectFor(rn) {
    // Largest normalized rect with w/h = rn that fits the frame.
    return rn >= 1 ? { w: 1, h: 1 / rn } : { w: rn, h: 1 };
  }
  function syncZoom() {
    const c = S.edit.crop;
    const m = maxRectFor(c.w / c.h);
    const z = clamp(m.w / c.w, 1, 8);
    $('zoom').value = z;
    $('zoomOut').textContent = `${z.toFixed(2)}×`;
  }

  function applyAspect(key) {
    S.aspect = key;
    document.querySelectorAll('#aspectBtns button').forEach((b) => b.classList.toggle('on', b.dataset.a === key));
    const a = aspectValue(key);
    if (!a) return refresh();
    const rn = normRatio(a);
    const m = maxRectFor(rn);
    const c = S.edit.crop;
    // Keep roughly the same zoom and center.
    const z = clamp(Math.min(m.w / c.w, m.h / c.h, 8), 1, 8);
    const zoomKeep = z > 1.02 ? z : 1;
    const w = m.w / zoomKeep, h = m.h / zoomKeep;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    setCrop({ x: cx - w / 2, y: cy - h / 2, w, h });
  }

  $('zoom').addEventListener('input', () => {
    const z = Number($('zoom').value);
    const c = S.edit.crop;
    const m = maxRectFor(c.w / c.h);
    const w = m.w / z, h = m.h / z;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    $('zoomOut').textContent = `${z.toFixed(2)}×`;
    setCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, true);
  });

  // Mouse wheel over the picture zooms the crop around the cursor.
  stage.addEventListener('wheel', (e) => {
    if (!S.info || S.view !== 'edit') return;
    e.preventDefault();
    const { x: px, y: py } = toNorm(e);
    const c = S.edit.crop;
    const f = Math.exp(e.deltaY * 0.0015);
    const m = maxRectFor(c.w / c.h);
    let w = clamp(c.w * f, m.w / 8, m.w), h = (w * c.h) / c.w;
    const k = w / c.w;
    setCrop({ x: px - (px - c.x) * k, y: py - (py - c.y) * k, w, h });
  }, { passive: false });

  cropBox.addEventListener('pointerdown', (e) => {
    if (!S.info) return;
    e.preventDefault();
    e.stopPropagation();
    cropBox.setPointerCapture(e.pointerId);
    cropBox.classList.add('active');
    const handle = e.target.dataset.h || 'move';
    S.dragging = true;
    const start = { ...S.edit.crop };
    const p0 = toNorm(e);
    const a = aspectValue(S.aspect);
    const rn = a ? normRatio(a) : null;
    const s = src();
    const minW = 16 / s.w, minH = 16 / s.h;

    const move = (ev) => {
      const n = toNorm(ev);
      const px = clamp(n.x, 0, 1), py = clamp(n.y, 0, 1);
      if (handle === 'move') {
        setCrop({ x: start.x + px - p0.x, y: start.y + py - p0.y, w: start.w, h: start.h });
        return;
      }
      let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
      if (handle.includes('w')) x0 = Math.min(px, x1 - minW);
      if (handle.includes('e')) x1 = Math.max(px, x0 + minW);
      if (handle.includes('n')) y0 = Math.min(py, y1 - minH);
      if (handle.includes('s')) y1 = Math.max(py, y0 + minH);
      let w = x1 - x0, h = y1 - y0;
      if (rn) {
        if (handle.length === 2) {
          h = w / rn;
          const avail = handle.includes('n') ? y1 : 1 - y0;
          if (h > avail) { h = avail; w = h * rn; }
          if (handle.includes('w')) x0 = x1 - w; else x1 = x0 + w;
          if (handle.includes('n')) y0 = y1 - h; else y1 = y0 + h;
        } else if (handle === 'e' || handle === 'w') {
          const cy = start.y + start.h / 2;
          h = w / rn;
          const avail = 2 * Math.min(cy, 1 - cy);
          if (h > avail) { h = avail; w = h * rn; if (handle === 'w') x0 = x1 - w; else x1 = x0 + w; }
          y0 = cy - h / 2;
        } else {
          const cx = start.x + start.w / 2;
          w = h * rn;
          const avail = 2 * Math.min(cx, 1 - cx);
          if (w > avail) { w = avail; h = w / rn; if (handle === 'n') y0 = y1 - h; else y1 = y0 + h; }
          x0 = cx - w / 2;
        }
      }
      setCrop({ x: x0, y: y0, w, h });
    };
    const up = () => {
      cropBox.removeEventListener('pointermove', move);
      cropBox.removeEventListener('pointerup', up);
      cropBox.classList.remove('active');
      // Ease the view onto the new crop.
      S.dragging = false;
      viewport.classList.add('ease');
      layout();
      setTimeout(() => viewport.classList.remove('ease'), 250);
    };
    cropBox.addEventListener('pointermove', move);
    cropBox.addEventListener('pointerup', up);
  });

  // Numeric crop fields (source pixels).
  for (const id of ['cx', 'cy', 'cw', 'ch']) {
    $(id).addEventListener('change', () => {
      if (!S.info) return;
      const s = src();
      const p = plan().crop;
      let x = Number($('cx').value), y = Number($('cy').value), w = Number($('cw').value), h = Number($('ch').value);
      const a = aspectValue(S.aspect);
      if (a) {
        const sar = S.info.sar || 1;
        if (id === 'cw') h = (w * sar) / a;
        if (id === 'ch') w = (h * a) / sar;
      }
      if (!isFinite(x)) x = p.x; if (!isFinite(y)) y = p.y;
      setCrop({ x: x / s.w, y: y / s.h, w: w / s.w, h: h / s.h });
    });
  }

  document.querySelectorAll('#aspectBtns button').forEach((b) => b.addEventListener('click', () => applyAspect(b.dataset.a)));
  $('resetCrop').addEventListener('click', () => {
    S.edit.crop = { x: 0, y: 0, w: 1, h: 1 };
    S.edit.rotate = 0; S.edit.flipH = false; S.edit.flipV = false;
    S.edit.size = { mode: 'crop' }; $('sizeMode').value = 'crop';
    applyAspect('free');
    syncZoom();
    refresh(true);
  });

  // Re-apply a locked aspect after turning, since the source-space shape flips.
  $('rotL').addEventListener('click', () => { S.edit.rotate = (S.edit.rotate + 270) % 360; applyAspect(S.aspect); refresh(true); });
  $('rotR').addEventListener('click', () => { S.edit.rotate = (S.edit.rotate + 90) % 360; applyAspect(S.aspect); refresh(true); });
  $('flipH').addEventListener('click', () => { S.edit.flipH = !S.edit.flipH; refresh(true); });
  $('flipV').addEventListener('click', () => { S.edit.flipV = !S.edit.flipV; refresh(true); });

  $('sizeMode').addEventListener('change', () => {
    const v = $('sizeMode').value;
    if (v === 'custom') {
      const p = plan();
      S.edit.size = { mode: 'custom', customW: p.outW, customH: p.outH };
      $('ow').value = p.outW; $('oh').value = p.outH;
    } else if (v.startsWith('h')) {
      S.edit.size = { mode: 'height', height: Number(v.slice(1)) };
    } else {
      S.edit.size = { mode: v };
    }
    refresh(true);
  });
  for (const id of ['ow', 'oh']) {
    $(id).addEventListener('change', () => {
      S.edit.size = { mode: 'custom', customW: Math.max(16, Number($('ow').value) || 16), customH: Math.max(16, Number($('oh').value) || 16) };
      refresh(true);
    });
  }
  document.querySelectorAll('#fitBtns button').forEach((b) => b.addEventListener('click', () => { S.edit.fit = b.dataset.f; refresh(true); }));

  // ---------------- preview (what the export will look like) ----------------
  function drawPreview() {
    if (S.view !== 'preview' || !S.info) return;
    const Cw = canvas.width, Ch = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, Cw, Ch);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const p = plan();
    const sx = (p.crop.x / p.crop.W) * vw, sy = (p.crop.y / p.crop.H) * vh;
    const sw = (p.crop.w / p.crop.W) * vw, sh = (p.crop.h / p.crop.H) * vh;
    const ca = contentAspect(p);
    let dw = Cw, dh = Ch;
    const sameAspect = Math.abs(ca - Cw / Ch) < 0.01;
    if (!sameAspect && S.edit.fit === 'fit') {
      const k = Math.min(Cw / ca, Ch); dw = k * ca; dh = k;
    } else if (!sameAspect && S.edit.fit === 'fill') {
      const k = Math.max(Cw / ca, Ch); dw = k * ca; dh = k;
    }
    const rot = S.edit.rotate;
    const r90 = rot % 180 !== 0;
    const rw = r90 ? dh : dw, rh = r90 ? dw : dh;
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(Cw / 2, Ch / 2);
    ctx.scale(S.edit.flipH ? -1 : 1, S.edit.flipV ? -1 : 1);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(video, sx, sy, sw, sh, -rw / 2, -rh / 2, rw, rh);
    ctx.restore();
  }
  (function loop() {
    if (S.view === 'preview') drawPreview();
    requestAnimationFrame(loop);
  })();

  function setView(v) {
    S.view = v;
    document.querySelectorAll('#viewToggle button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    // The <video> keeps playing underneath; the canvas paints the result on top.
    viewport.style.visibility = v === 'edit' ? 'visible' : 'hidden';
    canvas.hidden = v !== 'preview';
    layout();
  }
  document.querySelectorAll('#viewToggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ---------------- side panel refresh ----------------
  function refresh(relayout) {
    if (!S.info) return;
    const p = plan();
    const s = src();
    $('cx').value = p.crop.x; $('cy').value = p.crop.y; $('cw').value = p.crop.w; $('ch').value = p.crop.h;
    $('cx').max = s.w; $('cy').max = s.h; $('cw').max = s.w; $('ch').max = s.h;
    $('flipH').classList.toggle('on', S.edit.flipH);
    $('flipV').classList.toggle('on', S.edit.flipV);
    $('customSize').hidden = S.edit.size.mode !== 'custom';
    const aspectDiffers = Math.abs(contentAspect(p) - p.outW / p.outH) > 0.01;
    $('fitWrap').hidden = !aspectDiffers;
    document.querySelectorAll('#fitBtns button').forEach((b) => b.classList.toggle('on', b.dataset.f === S.edit.fit));

    $('sumSize').textContent = `${p.outW} × ${p.outH}`;
    if (!p.reencode && S.trimMode === 'keyframe') {
      $('sumMode').innerHTML = '<b class="copy">Lossless copy</b> — instant, no quality loss. Cuts snap to the nearest keyframe.';
    } else if (!p.reencode && FF.canSmartCut(S.info)) {
      $('sumMode').innerHTML = '<b class="copy">Smart cut</b> — frame-exact. Only the frames between each cut and the next keyframe are re-encoded; everything else is copied losslessly.';
    } else if (!p.reencode) {
      const enc = currentEncoder();
      const where = enc && !/^lib/.test(enc) ? `on GPU (${encLabel(enc)})` : 'on CPU';
      $('sumMode').innerHTML = `<b class="enc">Re-encode ${where}</b> — frame-exact cuts of ${S.info.videoCodec.toUpperCase()} video need a full re-encode. Pick <i>Keyframe only</i> for an instant lossless copy.`;
    } else {
      const enc = currentEncoder();
      const where = enc && !/^lib/.test(enc) ? `on GPU (${encLabel(enc)})` : 'on CPU';
      $('sumMode').innerHTML = `<b class="enc">Re-encode ${where}</b> — frame-accurate cuts. Audio is copied when possible.`;
    }
    document.querySelectorAll('#trimBtns button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.trimMode));
    if (S.view === 'edit') drawCrop();
    if (relayout || S.view === 'preview') layout();
    updateExportState();
  }

  // ---------------- encoders ----------------
  function encLabel(id) {
    for (const c of Object.values(FF.ENCODERS)) for (const e of c) if (e.id === id) return e.label;
    return id;
  }
  function currentEncoder() {
    return $('encoder').value || (S.encoders[$('codec').value][0] || {}).id;
  }
  function fillEncoders() {
    const list = S.encoders[$('codec').value] || [];
    const sel = $('encoder');
    sel.innerHTML = '';
    list.forEach((e, i) => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = (i === 0 ? 'Auto · ' : '') + e.label;
      sel.appendChild(o);
    });
    refresh();
  }
  async function detect() {
    try {
      S.encoders = await window.api.detectEncoders();
    } catch {
      S.encoders = { h264: FF.ENCODERS.h264.slice(-1), hevc: FF.ENCODERS.hevc.slice(-1) };
    }
    const best = S.encoders.h264[0];
    const chip = $('encChip');
    if (best && best.hw) { chip.textContent = `GPU: ${best.label}`; chip.className = 'chip hw'; }
    else { chip.textContent = 'No GPU encoder · using CPU'; chip.className = 'chip cpu'; }
    fillEncoders();
  }
  $('codec').addEventListener('change', () => { fillEncoders(); savePrefs(); });
  $('encoder').addEventListener('change', () => refresh());
  for (const id of ['fmt', 'quality', 'merge']) $(id).addEventListener('change', savePrefs);

  // ---------------- loading a file ----------------
  async function openFile(file) {
    if (!file || S.exporting) return;
    showLoading('Reading video…');
    let info;
    try {
      info = await window.api.probe(file);
    } catch (e) {
      hideLoading();
      toast(`Couldn't open this file.\n${cleanErr(e)}`, { error: true });
      return;
    }
    S.file = file;
    S.info = info;
    S.edit = freshEdit();
    S.aspect = 'free';
    $('sizeMode').value = 'crop';
    document.querySelectorAll('#aspectBtns button').forEach((b) => b.classList.toggle('on', b.dataset.a === 'free'));
    S.segs = [{ start: 0, end: info.duration }];
    S.sel = 0;
    S.tl = { start: 0, dur: info.duration || 1 };
    $('fileName').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = info.name;
    $('fileName').append(b, ` · ${info.width}×${info.height} · ${info.videoCodec.toUpperCase()} · ${info.fps.toFixed(info.fps % 1 ? 2 : 0)} fps · ${fmtBytes(info.size)}`);
    $('empty').hidden = true;
    viewport.hidden = false;
    $('viewToggle').hidden = false;
    $('panel').classList.remove('disabled');
    $('timelineArea').classList.remove('disabled');
    setView('edit');
    syncZoom();
    usedProxy = false;
    video.src = info.url;
    refresh(true);
    renderTimeline();
  }

  let usedProxy = false;
  async function useProxy() {
    if (usedProxy || !S.file) return;
    usedProxy = true;
    showLoading('This format can\'t be previewed directly — making a quick preview copy…');
    try {
      const url = await window.api.makeProxy(S.file);
      video.src = url;
    } catch (e) {
      hideLoading();
      toast(`Couldn't preview this file, but you can still export it.\n${cleanErr(e)}`, { error: true });
    }
  }
  video.addEventListener('error', () => useProxy());
  video.addEventListener('loadedmetadata', () => {
    if (!video.videoWidth) return useProxy();
    hideLoading();
    layout();
  });
  video.addEventListener('loadeddata', () => { hideLoading(); drawPreview(); });
  video.addEventListener('seeked', drawPreview);

  function showLoading(t) { $('loadingText').textContent = t; $('loading').hidden = false; }
  function hideLoading() { $('loading').hidden = true; }
  const cleanErr = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  $('openBtn').addEventListener('click', async () => openFile(await window.api.openDialog()));
  window.api.onOpenPath((p) => openFile(p));

  window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('drag'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) openFile(window.api.pathForFile(f));
  });

  // ---------------- playback ----------------
  const dur = () => (S.info ? S.info.duration : 0);
  const fps = () => (S.info && S.info.fps) || 30;
  // Frame shown at time t (the player shows the last frame that starts at or before t).
  const frameOf = (t) => Math.floor(t * fps() + 1e-3);
  const lastFrame = () => Math.max(0, Math.ceil(dur() * fps() - 1e-3) - 1);
  // Snap a cut time to the nearest frame boundary.
  const snap = (t) => {
    const v = Math.round(t * fps()) / fps();
    return v >= dur() - 0.5 / fps() ? dur() : clamp(v, 0, dur());
  };
  function seek(t) {
    if (!S.info) return;
    video.currentTime = clamp(t, 0, dur());
    updateTime();
  }
  // Land squarely inside frame n so that exact frame is displayed.
  function seekFrame(n) {
    n = clamp(n, 0, lastFrame());
    seek((n + 0.02) / fps());
  }
  function stepFrames(k) {
    if (!S.info) return;
    video.pause();
    seekFrame(frameOf(video.currentTime) + k);
  }
  function togglePlay() {
    if (!S.info) return;
    if (video.paused) video.play(); else video.pause();
  }
  video.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; tick(); });
  video.addEventListener('pause', () => { $('playBtn').textContent = '▶'; updateTime(); });
  $('playBtn').addEventListener('click', togglePlay);
  function tick() {
    updateTime();
    if (!video.paused) requestAnimationFrame(tick);
  }
  function updateTime() {
    const t = video.currentTime;
    $('tCur').textContent = fmtTime(t);
    $('tDur').textContent = fmtTime(dur());
    $('tFrame').textContent = S.info ? `frame ${frameOf(t)}` : '';
    // Keep playhead visible when zoomed in.
    if (!video.paused && (t > S.tl.start + S.tl.dur || t < S.tl.start)) {
      S.tl.start = clamp(t - S.tl.dur * 0.1, 0, Math.max(0, dur() - S.tl.dur));
      renderTimeline();
    }
    const w = timeline.clientWidth;
    $('playhead').style.left = `${((t - S.tl.start) / S.tl.dur) * w}px`;
  }
  video.addEventListener('timeupdate', updateTime);

  // ---------------- segments ----------------
  const seg = () => S.segs[S.sel];
  // Start = the frame on screen is the first one kept.
  function setIn() {
    const s = seg(); if (!s) return addSegment();
    const t = frameOf(video.currentTime) / fps();
    s.start = Math.min(t, s.end - 1 / fps());
    sortSegs(s);
  }
  // End = the frame on screen is the last one kept.
  function setOut() {
    const s = seg(); if (!s) return addSegment();
    const t = snap((frameOf(video.currentTime) + 1) / fps());
    s.end = Math.max(t, s.start + 1 / fps());
    sortSegs(s);
  }
  function addSegment() {
    const t = frameOf(video.currentTime) / fps();
    const s = { start: t, end: snap(Math.min(dur(), t + Math.max(1, Math.min(10, dur() * 0.1)))) };
    if (s.end - s.start < 0.1) s.start = Math.max(0, s.end - 1);
    // The untouched whole-video segment gets replaced instead of overlapped.
    const only = S.segs.length === 1 && S.segs[0];
    if (only && only.start < 0.01 && only.end > dur() - 0.01) S.segs = [];
    S.segs.push(s);
    sortSegs(s);
  }
  function removeSegment() {
    if (S.segs.length <= 1) { S.segs = [{ start: 0, end: dur() }]; S.sel = 0; }
    else { S.segs.splice(S.sel, 1); S.sel = clamp(S.sel, 0, S.segs.length - 1); }
    renderTimeline();
  }
  function sortSegs(keep) {
    S.segs.sort((a, b) => a.start - b.start);
    S.sel = Math.max(0, S.segs.indexOf(keep));
    renderTimeline();
  }
  $('setIn').addEventListener('click', setIn);
  $('prevFrame').addEventListener('click', () => stepFrames(-1));
  $('nextFrame').addEventListener('click', () => stepFrames(1));
  document.querySelectorAll('#trimBtns button').forEach((b) => b.addEventListener('click', () => {
    S.trimMode = b.dataset.t;
    savePrefs();
    refresh();
  }));
  $('setOut').addEventListener('click', setOut);
  $('addSeg').addEventListener('click', addSegment);
  $('delSeg').addEventListener('click', removeSegment);

  // ---------------- timeline ----------------
  const tToX = (t) => ((t - S.tl.start) / S.tl.dur) * timeline.clientWidth;
  const xToT = (x) => S.tl.start + (x / timeline.clientWidth) * S.tl.dur;

  function renderTimeline() {
    if (!S.info) return;
    const W = timeline.clientWidth;
    // ticks
    const ticks = $('ticks');
    ticks.innerHTML = '';
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => (s / S.tl.dur) * W >= 80) || 3600;
    for (let t = Math.ceil(S.tl.start / step) * step; t <= S.tl.start + S.tl.dur; t += step) {
      const d = document.createElement('div');
      d.className = 'tick';
      d.style.left = `${tToX(t)}px`;
      d.textContent = step < 1 ? fmtTime(t) : fmtTime(t, true);
      ticks.appendChild(d);
    }
    // segments
    track.innerHTML = '';
    S.segs.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'segment' + (i === S.sel ? ' sel' : '');
      d.style.left = `${tToX(s.start)}px`;
      d.style.width = `${Math.max(2, tToX(s.end) - tToX(s.start))}px`;
      d.dataset.i = i;
      d.innerHTML = `<div class="sh l" data-edge="start"></div><div class="sh r" data-edge="end"></div>${S.segs.length > 1 ? `<span class="num">${i + 1}</span>` : ''}`;
      track.appendChild(d);
    });
    const s = seg();
    const total = S.segs.reduce((a, x) => a + (x.end - x.start), 0);
    $('segInfo').textContent = s
      ? `${S.segs.length > 1 ? `Segment ${S.sel + 1}/${S.segs.length} · ` : ''}${fmtTime(s.start)} → ${fmtTime(s.end)} (${(s.end - s.start).toFixed(2)}s · ${Math.round((s.end - s.start) * fps())} frames)${S.segs.length > 1 ? ` · total ${fmtTime(total)}` : ''}`
      : '';
    updateTime();
    updateExportState();
  }
  new ResizeObserver(renderTimeline).observe(timeline);

  timeline.addEventListener('pointerdown', (e) => {
    if (!S.info) return;
    e.preventDefault();
    timeline.setPointerCapture(e.pointerId);
    const r = timeline.getBoundingClientRect();
    const segEl = e.target.closest('.segment');
    const edge = e.target.dataset.edge;
    if (segEl) { S.sel = Number(segEl.dataset.i); }
    const s = seg();
    let mode = edge ? 'edge' : 'scrub';
    const wasPlaying = !video.paused;
    if (mode === 'scrub') { video.pause(); seek(xToT(e.clientX - r.left)); }
    renderTimeline();
    const move = (ev) => {
      const t = clamp(xToT(ev.clientX - r.left), 0, dur());
      if (mode === 'edge') {
        const f = 1 / fps();
        if (edge === 'start') { s.start = Math.min(snap(t), s.end - f); seekFrame(Math.round(s.start * fps())); }
        else { s.end = Math.max(snap(t), s.start + f); seekFrame(Math.round(s.end * fps()) - 1); }
        renderTimeline();
      } else {
        seek(t);
      }
    };
    const up = () => {
      timeline.removeEventListener('pointermove', move);
      timeline.removeEventListener('pointerup', up);
      if (mode === 'edge') sortSegs(s);
      if (wasPlaying && mode === 'scrub') video.play();
    };
    timeline.addEventListener('pointermove', move);
    timeline.addEventListener('pointerup', up);
  });

  // Wheel = zoom timeline around cursor, Shift+wheel = pan.
  timeline.addEventListener('wheel', (e) => {
    if (!S.info) return;
    e.preventDefault();
    const r = timeline.getBoundingClientRect();
    const D = dur();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.deltaX || e.deltaY) / r.width * S.tl.dur;
      S.tl.start = clamp(S.tl.start + d, 0, Math.max(0, D - S.tl.dur));
    } else {
      const tAt = xToT(e.clientX - r.left);
      const nd = clamp(S.tl.dur * Math.exp(e.deltaY * 0.002), Math.min(D, 0.5), D);
      const frac = (e.clientX - r.left) / r.width;
      S.tl.dur = nd;
      S.tl.start = clamp(tAt - frac * nd, 0, Math.max(0, D - nd));
    }
    renderTimeline();
  }, { passive: false });

  // ---------------- export ----------------
  function updateExportState() {
    $('exportBtn').disabled = !S.info || S.exporting;
    $('merge').closest('label').style.display = S.segs.length > 1 ? '' : 'none';
  }

  $('outDirBtn').addEventListener('click', async () => {
    const d = await window.api.chooseFolder();
    S.outDir = d || null;
    setOutDirLabel();
    savePrefs();
  });
  $('outDirBtn').addEventListener('contextmenu', (e) => { e.preventDefault(); S.outDir = null; setOutDirLabel(); savePrefs(); });
  function setOutDirLabel() {
    $('outDirBtn').textContent = S.outDir ? `Save to: ${S.outDir.split(/[\\/]/).pop() || S.outDir}` : 'Save next to source';
    $('outDirBtn').title = S.outDir ? `${S.outDir}\n(right-click to save next to the source again)` : 'Choose an output folder';
  }

  async function doExport() {
    if (!S.info || S.exporting) return;
    video.pause();
    const p = plan();
    const job = {
      input: S.file,
      info: S.info,
      edit: S.edit,
      segments: S.segs.map((s) => ({ start: s.start, end: s.end })),
      merge: $('merge').checked,
      encoder: currentEncoder() || 'libx264',
      quality: $('quality').value,
      ext: $('fmt').value,
      outDir: S.outDir,
      trimMode: S.trimMode,
      smartEncoders: FF.smartEncoderIds(S.info, S.encoders),
    };
    S.exporting = true;
    updateExportState();
    $('progress').hidden = false;
    $('progBar').style.width = '0%';
    $('progText').textContent = p.reencode ? 'Encoding…' : S.trimMode === 'keyframe' ? 'Copying…' : 'Cutting…';
    const t0 = performance.now();
    const res = await window.api.exportVideo(job);
    S.exporting = false;
    $('progress').hidden = true;
    updateExportState();
    if (res.ok) {
      const secs = res.seconds < 10 ? res.seconds.toFixed(1) : Math.round(res.seconds);
      const names = res.outputs.map((o) => o.split(/[\\/]/).pop()).join(', ');
      let how = res.reencode ? '' : ' (lossless)';
      if (res.smart) {
        how = res.encodedSeconds > 0.001
          ? ` · frame-exact (re-encoded ${res.encodedSeconds.toFixed(1)}s at the cuts, copied ${res.copiedSeconds.toFixed(1)}s losslessly)`
          : ' · frame-exact and fully lossless (cuts landed on keyframes)';
      }
      toast(`Saved ${names}\nDone in ${secs}s${how}`, {
        actions: [{ label: 'Show in folder', run: () => window.api.showInFolder(res.outputs[0]) }],
      });
    } else if (res.cancelled) {
      toast('Export cancelled.');
    } else {
      let hint = '';
      if (res.error && !p.reencode && S.trimMode === 'precise') hint = '\n\nTip: set Trim to "Keyframe only" for a plain lossless copy.';
      else if (!p.reencode && $('fmt').value !== 'same') hint = '\n\nTip: try Format → "Same as source" for lossless cuts.';
      else if (p.reencode && !/^lib/.test(job.encoder)) hint = '\n\nTip: try picking the CPU encoder in the Encoder menu.';
      toast(`Export failed.\n${res.error}${hint}`, { error: true, sticky: true });
    }
    void t0;
  }
  window.api.onProgress((m) => {
    const pct = Math.round((m.progress || 0) * 100);
    $('progBar').style.width = `${pct}%`;
    $('progText').textContent = m.phase === 'merge' ? 'Joining…' : `${m.count > 1 ? `Part ${m.index + 1}/${m.count} · ` : ''}${pct}%`;
  });
  $('exportBtn').addEventListener('click', doExport);
  $('cancelBtn').addEventListener('click', () => window.api.cancelExport());

  // ---------------- keyboard ----------------
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select') { if (e.key === 'Escape') e.target.blur(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); $('openBtn').click(); return; }
    if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); doExport(); return; }
    if (!S.info) return;
    const fps = S.info.fps || 30;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'i': case 'I': setIn(); break;
      case 'o': case 'O': setOut(); break;
      case '+': case '=': addSegment(); break;
      case 'Delete': case 'Backspace': removeSegment(); break;
      case 'p': case 'P': setView(S.view === 'edit' ? 'preview' : 'edit'); break;
      case 'ArrowLeft': case ',': e.preventDefault(); stepFrames(e.shiftKey ? -Math.round(fps) : -1); break;
      case 'ArrowRight': case '.': e.preventDefault(); stepFrames(e.shiftKey ? Math.round(fps) : 1); break;
      case 'ArrowUp': e.preventDefault(); video.pause(); if (seg()) seekFrame(Math.round(seg().start * fps)); break;
      case 'ArrowDown': e.preventDefault(); video.pause(); if (seg()) seekFrame(Math.round(seg().end * fps) - 1); break;
      case 'Home': seek(0); break;
      case 'End': seek(dur()); break;
      case 'Tab':
        e.preventDefault();
        if (S.segs.length > 1) { S.sel = (S.sel + (e.shiftKey ? S.segs.length - 1 : 1)) % S.segs.length; seek(seg().start); renderTimeline(); }
        break;
      default:
    }
  });

  // ---------------- init ----------------
  if (prefs.fmt) $('fmt').value = prefs.fmt;
  if (prefs.codec) $('codec').value = prefs.codec;
  if (prefs.quality) $('quality').value = prefs.quality;
  if (typeof prefs.merge === 'boolean') $('merge').checked = prefs.merge;
  setOutDirLabel();
  $('panel').classList.add('disabled');
  $('timelineArea').classList.add('disabled');
  updateExportState();
  detect();

  // Exposed for automated tests only.
  window.__fc = { S, applyAspect, setCrop, setView, refresh, plan, seek };
})();
