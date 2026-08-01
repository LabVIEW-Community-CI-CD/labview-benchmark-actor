// frame-correlator.mjs — the LabVIEW-launch FRAME CORRELATOR webview (rebuilt to the operator's spec).
//
// Upper half: CPU / RAM / disk curves over the capture's frame timeline (each normalized to its own range so
// all three are visible), with a RED vertical line you GRAB and drag left/right (or arrow keys). Lower half:
// the REAL captured screenshot at the scrubbed frame index. Fed a launch-capture@1 record whose frames carry a
// webview `imageSrc` (a webview URI for the VM-local PNG long-packet payload) so nothing is embedded here.
//
// Pure builder (no VS Code API): model + nonce + cspSource -> a self-contained document, so the markup stays
// deterministically testable. The inline runtime is single-quote concatenation only (no backticks / ${}) so it
// embeds cleanly under the CSP nonce.

/** Escape text for safe HTML insertion. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Neutralize a JSON island so it cannot close the script tag early. */
function island(model) {
  return JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const STYLE = `
  html, body { margin: 0; height: 100%; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #ddd);
    background: var(--vscode-editor-background, #1e1e1e); overflow: hidden; }
  #fc-root { position: absolute; inset: 0; display: flex; flex-direction: column; }
  #fc-graphwrap { flex: 0 0 44%; position: relative; border-bottom: 1px solid var(--vscode-editorWidget-border, #444); }
  #fc-graph { position: absolute; inset: 0; width: 100%; height: 100%; cursor: ew-resize; touch-action: none; }
  #fc-legend { position: absolute; left: 10px; top: 6px; font-size: 12px; line-height: 1.5; z-index: 2;
    background: var(--vscode-editorWidget-background, #252526cc); padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--vscode-editorWidget-border, #444); }
  #fc-legend .sw { display: inline-block; width: 11px; height: 3px; vertical-align: middle; margin-right: 5px; }
  #fc-readout { position: absolute; right: 10px; top: 6px; font-size: 12px; z-index: 2;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-editorWidget-background, #252526cc); padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--vscode-editorWidget-border, #444); }
  #fc-hint { position: absolute; left: 10px; bottom: 6px; font-size: 11px; opacity: 0.7; z-index: 2; }
  #fc-framewrap { flex: 1 1 56%; position: relative; background: #0b0b0b; overflow: hidden; }
  #fc-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  #fc-empty { padding: 20px; color: var(--vscode-descriptionForeground, #999); }
  #fc-markreadout { position: absolute; right: 10px; bottom: 6px; font-size: 12px; z-index: 2;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-editorWidget-background, #252526cc); padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--vscode-editorWidget-border, #444); display: none; }
  #fc-markreadout.on { display: block; }
  .fc-marker { cursor: pointer; }
`;

const SCRIPT = `
(function () {
  'use strict';
  var island = document.getElementById('fc-model');
  var root = document.getElementById('fc-root');
  var model; try { model = JSON.parse(island.textContent || '{}'); } catch (e) { model = {}; }
  var frames = (model && model.frames) || [];
  if (!frames.length) { root.innerHTML = '<div id=\\'fc-empty\\'>No captured frames in this record.</div>'; return; }
  var n = frames.length;
  var sel = model.selectedIndex | 0; if (sel < 0 || sel >= n) { sel = 0; }

  var metrics = [
    { key: 'cpuPct', label: 'CPU %', color: '#4fc1ff' },
    { key: 'ramMb', label: 'RAM MB', color: '#a5d6a7' },
    { key: 'diskPct', label: 'Disk %', color: '#ffd166' }
  ];
  var VW = 1000, VH = 300, PADL = 8, PADR = 8, PADT = 10, PADB = 16;
  function gx(i) { return PADL + (n <= 1 ? 0 : (i / (n - 1)) * (VW - PADL - PADR)); }

  var svgNs = 'http://www.w3.org/2000/svg';
  var graphwrap = document.getElementById('fc-graphwrap');
  var svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('id', 'fc-graph');
  svg.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
  svg.setAttribute('preserveAspectRatio', 'none');
  graphwrap.appendChild(svg);

  // one normalized polyline per metric (each scaled to its own min/max so all three shapes are visible)
  metrics.forEach(function (m) {
    var vals = frames.map(function (f) { return typeof f[m.key] === 'number' ? f[m.key] : null; });
    var present = vals.filter(function (v) { return v != null; });
    m.min = present.length ? Math.min.apply(null, present) : 0;
    m.max = present.length ? Math.max.apply(null, present) : 1;
    var span = (m.max - m.min) || 1;
    var pts = [];
    for (var i = 0; i < n; i++) {
      if (vals[i] == null) { continue; }
      var y = PADT + (1 - (vals[i] - m.min) / span) * (VH - PADT - PADB);
      pts.push(gx(i).toFixed(1) + ',' + y.toFixed(1));
    }
    if (pts.length > 1) {
      var poly = document.createElementNS(svgNs, 'polyline');
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', m.color);
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('vector-effect', 'non-scaling-stroke');
      poly.setAttribute('points', pts.join(' '));
      svg.appendChild(poly);
    }
  });

  // the draggable red line
  var line = document.createElementNS(svgNs, 'line');
  line.setAttribute('y1', '0'); line.setAttribute('y2', String(VH));
  line.setAttribute('stroke', '#ff3b30'); line.setAttribute('stroke-width', '2');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);

  var legend = document.getElementById('fc-legend');
  var readout = document.getElementById('fc-readout');
  var img = document.getElementById('fc-img');
  var markreadout = document.getElementById('fc-markreadout');
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  var TOL = (model && typeof model.markerToleranceMs === 'number') ? model.markerToleranceMs : 200;
  var frameMs = 1000 / (model.fps || 12);
  var markers = [];
  var markerSeq = 0;

  function fmt(v, suffix) { return (v == null ? '--' : v) + (suffix || ''); }
  function render() {
    var f = frames[sel];
    line.setAttribute('x1', gx(sel).toFixed(1));
    line.setAttribute('x2', gx(sel).toFixed(1));
    legend.innerHTML = metrics.map(function (m) {
      return '<span class=sw style="background:' + m.color + '"></span>' + m.label + ': <b>' + fmt(f[m.key]) + '</b>';
    }).join('<br>');
    readout.textContent = 'frame ' + (sel + 1) + '/' + n + '   t=' + (f.tMs != null ? f.tMs : sel * Math.round(1000 / (model.fps || 12))) + 'ms';
    root.setAttribute('data-selected-index', String(sel));
    if (img.getAttribute('src') !== (f.imageSrc || '')) { img.setAttribute('src', f.imageSrc || ''); }
  }
  function setSel(i) { if (i < 0) { i = 0; } if (i >= n) { i = n - 1; } if (i !== sel) { sel = i; } render(); }

  function frameFromClientX(clientX) {
    var r = svg.getBoundingClientRect();
    if (!(r.width > 1)) { return sel; }
    var vbx = (clientX - r.left) * (VW / r.width);
    var frac = (vbx - PADL) / (VW - PADL - PADR);
    return Math.round(frac * (n - 1));
  }

  // --- marker (click-to-label) helpers: mirror frameMarkers.mjs classifyPointerGesture + resolveMarkerImageGrab ---
  function tMsOf(i) { var f = frames[i]; return f && f.tMs != null ? f.tMs : i * frameMs; }
  function classifyGesture(dx, dy, slop) { return Math.hypot(dx, dy) <= (slop || 4) ? 'click' : 'drag'; }
  function instantMsFromClientX(clientX) {
    var r = svg.getBoundingClientRect();
    if (!(r.width > 1)) { return tMsOf(sel); }
    var frac = ((clientX - r.left) * (VW / r.width) - PADL) / (VW - PADL - PADR);
    if (frac < 0) { frac = 0; } if (frac > 1) { frac = 1; }
    var pos = frac * (n - 1), i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1), t = pos - i0;
    return tMsOf(i0) + (tMsOf(i1) - tMsOf(i0)) * t;
  }
  function grabNearestImage(instantMs) {
    var best = null;
    for (var i = 0; i < n; i++) {
      var tm = tMsOf(i), d = Math.abs(tm - instantMs);
      if (best === null || d < best.d || (d === best.d && tm < best.tm)) { best = { d: d, i: i, tm: tm, img: frames[i].imageSrc || null }; }
    }
    if (best === null) { return { nearestFrameIndex: null, deltaMs: null, admitted: false, imageSrc: null }; }
    var admitted = best.d <= TOL;
    return { nearestFrameIndex: best.i, deltaMs: best.d, admitted: admitted, imageSrc: admitted ? best.img : null };
  }
  function drawMarkerPin(m) {
    var x = gx(m.frameIndex);
    var pin = document.createElementNS(svgNs, 'polygon');
    pin.setAttribute('points', (x - 5).toFixed(1) + ',0 ' + (x + 5).toFixed(1) + ',0 ' + x.toFixed(1) + ',11');
    pin.setAttribute('fill', (m.imageGrab && m.imageGrab.admitted) ? '#ffb020' : '#8a8a8a');
    pin.setAttribute('vector-effect', 'non-scaling-stroke');
    pin.setAttribute('class', 'fc-marker');
    pin.setAttribute('data-frame', String(m.frameIndex));
    svg.appendChild(pin);
  }
  function renderMarkReadout(m) {
    var g = m.imageGrab || {};
    markreadout.className = 'on';
    markreadout.textContent = 'marker @frame ' + ((m.frameIndex | 0) + 1) + '  t=' + Math.round(m.instantMs) + 'ms  image ' +
      (g.admitted ? '\\u2713 \\u0394' + Math.round(g.deltaMs) + 'ms' : '\\u2014 outside ' + TOL + 'ms');
  }
  function addMarker(m, silent) {
    markers.push(m); drawMarkerPin(m);
    root.setAttribute('data-marker-count', String(markers.length));
    root.setAttribute('data-last-marker-frame', String(m.frameIndex));
    root.setAttribute('data-last-marker-admitted', String(!!(m.imageGrab && m.imageGrab.admitted)));
    if (!silent) {
      renderMarkReadout(m);
      if (vscode) { try { vscode.postMessage({ type: 'frame-marker', marker: m }); } catch (_) {} }
    }
  }
  function dropMarkerAtClientX(clientX) {
    var instantMs = instantMsFromClientX(clientX);
    var grab = grabNearestImage(instantMs);
    markerSeq += 1;
    addMarker({ id: 'm-' + Math.round(instantMs) + '-' + markerSeq, instantMs: instantMs, frameIndex: grab.nearestFrameIndex == null ? sel : grab.nearestFrameIndex, kind: 'user-click', imageGrab: grab }, false);
  }

  var dragging = false, downX = 0, downY = 0, moved = 0;
  svg.addEventListener('pointerdown', function (e) {
    dragging = true; downX = e.clientX; downY = e.clientY; moved = 0;
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    setSel(frameFromClientX(e.clientX)); e.preventDefault();
  });
  svg.addEventListener('pointermove', function (e) {
    if (!dragging) { return; }
    var d = Math.hypot(e.clientX - downX, e.clientY - downY); if (d > moved) { moved = d; }
    setSel(frameFromClientX(e.clientX));
  });
  function endGesture(e) {
    if (!dragging) { return; }
    dragging = false;
    var upX = (e && e.clientX != null) ? e.clientX : downX;
    var upY = (e && e.clientY != null) ? e.clientY : downY;
    if (classifyGesture(upX - downX, upY - downY, 4) === 'click' && moved <= 4) { dropMarkerAtClientX(upX); }
  }
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', function () { dragging = false; });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { setSel(sel - 1); }
    else if (e.key === 'ArrowRight') { setSel(sel + 1); }
    else if (e.key === 'Home') { setSel(0); }
    else if (e.key === 'End') { setSel(n - 1); }
    else { return; }
    e.preventDefault();
  });

  // pre-seeded markers (deterministic render for tests / persisted markers)
  (model.markers || []).forEach(function (mk) {
    markerSeq += 1;
    var inst = (mk && mk.instantMs != null) ? mk.instantMs : ((mk && mk.frameIndex != null) ? tMsOf(mk.frameIndex) : 0);
    var grab = (mk && mk.imageGrab) ? mk.imageGrab : grabNearestImage(inst);
    var fi = (mk && mk.frameIndex != null) ? mk.frameIndex : (grab.nearestFrameIndex == null ? 0 : grab.nearestFrameIndex);
    addMarker({ id: (mk && mk.id) || ('m-seed-' + markerSeq), instantMs: inst, frameIndex: fi, kind: (mk && mk.kind) || 'seed', imageGrab: grab }, true);
  });
  if (markers.length) { renderMarkReadout(markers[markers.length - 1]); }

  render();
})();
`;

/**
 * Build the frame-correlator document.
 * @param {object} model { title, fps, frames:[{index,tMs,cpuPct,ramMb,diskPct,imageSrc}], selectedIndex,
 *   markers?:[{id?,instantMs?,frameIndex?,kind?,imageGrab?}], markerToleranceMs? } -- a CLICK (vs a scrub drag)
 *   on the graph drops a marker at that instant (nearest-frame image grabbed only within markerToleranceMs, 200
 *   default) and posts { type:'frame-marker', marker } to the host; pre-seeded markers render deterministically.
 * @param {string} nonce per-load CSP nonce
 * @param {string} cspSource the webview.cspSource (so the frame <img> can load VM-local webview URIs)
 * @returns {string} self-contained HTML
 */
export function buildFrameCorrelatorHtml(model, nonce, cspSource) {
  const src = cspSource || '';
  const normalized = {
    title: (model && model.title) || 'LabVIEW launch \u2014 frame correlator',
    fps: (model && model.fps) || 12,
    selectedIndex: model && typeof model.selectedIndex === 'number' ? model.selectedIndex : 0,
    frames: Array.isArray(model && model.frames) ? model.frames : [],
    markers: Array.isArray(model && model.markers) ? model.markers : [],
    markerToleranceMs: model && typeof model.markerToleranceMs === 'number' ? model.markerToleranceMs : 200,
  };
  const csp =
    "default-src 'none'; " +
    `img-src ${src} data:; ` +
    "style-src 'unsafe-inline'; " +
    `script-src 'nonce-${nonce}'; ` +
    "font-src 'none';";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(normalized.title)}</title>
    <style nonce="${nonce}">${STYLE}</style>
  </head>
  <body>
    <div id="fc-root">
      <div id="fc-graphwrap">
        <div id="fc-legend"></div>
        <div id="fc-readout"></div>
        <div id="fc-hint">Grab the red line and drag \u2190 \u2192 (or arrow keys) to scrub; CLICK a spot to drop a marker (grabs the nearest frame image within tolerance). The frame below is the captured screenshot at that instant.</div>
        <div id="fc-markreadout"></div>
      </div>
      <div id="fc-framewrap"><img id="fc-img" alt="captured screenshot at the scrubbed frame" /></div>
    </div>
    <script id="fc-model" type="application/json" nonce="${nonce}">${island(normalized)}</script>
    <script nonce="${nonce}">${SCRIPT}</script>
  </body>
</html>`;
}
