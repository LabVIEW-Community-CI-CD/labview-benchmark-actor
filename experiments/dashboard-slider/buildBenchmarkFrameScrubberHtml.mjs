/**
 * LBA dashboard next-horizon (Discussion #2365, task lba-dashboard):
 * the benchmark frame-scrubber shell.
 *
 * Pure builder for a self-contained HTML document that renders the human
 * target: the UPPER HALF holds the benchmark (a metric graph over the capture
 * timeline) with a VERTICAL SLIDER; the LOWER HALF shows the captured frame
 * (the packet-derived image) at the scrubbed instant. Moving the vertical
 * slider scrubs the benchmark timeline and the lower half navigates to the
 * captured frame at that instant, snapping to the nearest-preceding
 * frame-start (mprr timepoint-resolver benchmarkSelectionMode
 * "nearest-preceding-frame-start", OQ3).
 *
 * This shell is the vi-history-suite half of the split agreed on #2365: it
 * consumes the mprr "successor-shadow-dashboard-synchronized-review-state-v1"
 * points model + the packet-derived-images, and reuses the shipped
 * viPreviewFramesViewer.ts pattern (strict nonce CSP, a JSON island, an inline
 * runtime with pan/zoom/Fit and arrow-key paging). WIN then folds the proven
 * markup into the mprr synchronized-review surface as a new
 * timestampNavigationMode. The builder is pure so the document shape stays
 * deterministically testable without a browser host.
 *
 * Model shape (BenchmarkFrameScrubberModel):
 *   {
 *     title: string,
 *     metricLabel: string,          // e.g. "cpuUsagePercent"
 *     selectedIndex: number,        // initial selected point
 *     points: Array<{
 *       pointId: string,
 *       label: string,              // human timestamp text, e.g. "00:00:00.12"
 *       centiseconds: number,       // benchmark time (slider domain + graph X)
 *       metricValue: number,        // benchmark metric (graph Y)
 *       image: string,              // data: URI of the packet-derived frame
 *       isFrameStart?: boolean      // eligible nearest-preceding snap target
 *     }>
 *   }
 * Points are sorted ascending by centiseconds by the builder.
 */

/**
 * Resolves a scrubbed benchmark instant (centiseconds) to the index of the
 * nearest-PRECEDING eligible point. Eligible = frame-start points if any point
 * declares isFrameStart, else every point. A target before the first eligible
 * point clamps to the first. Shared by the Node self-test and mirrored by the
 * embedded runtime so the semantic has one authoritative definition.
 *
 * @param {Array<{centiseconds:number,isFrameStart?:boolean}>} pointsAsc points sorted ascending by centiseconds
 * @param {number} targetCs scrubbed benchmark instant in centiseconds
 * @returns {number} index into pointsAsc, or -1 when empty
 */
export function resolveNearestPrecedingIndex(pointsAsc, targetCs) {
  if (!Array.isArray(pointsAsc) || pointsAsc.length === 0) {
    return -1;
  }
  const anyFrameStart = pointsAsc.some((p) => p && p.isFrameStart);
  let idx = -1;
  for (let i = 0; i < pointsAsc.length; i += 1) {
    const p = pointsAsc[i];
    if (anyFrameStart && !(p && p.isFrameStart)) {
      continue;
    }
    if (p.centiseconds <= targetCs) {
      idx = i;
    } else {
      break;
    }
  }
  if (idx === -1) {
    // Target precedes the first eligible point: clamp to the first eligible.
    for (let i = 0; i < pointsAsc.length; i += 1) {
      if (!anyFrameStart || (pointsAsc[i] && pointsAsc[i].isFrameStart)) {
        return i;
      }
    }
    return 0;
  }
  return idx;
}

/** Sorts a copy of the points ascending by centiseconds (stable). */
function sortPoints(points) {
  return (Array.isArray(points) ? points.slice() : []).sort(
    (a, b) => (a.centiseconds || 0) - (b.centiseconds || 0)
  );
}

/**
 * Escapes a model for safe embedding in a `<script type="application/json">`
 * island: neutralizes `<` (so `</script>` cannot close the tag early) and the
 * U+2028/U+2029 line terminators invalid in JS string literals. Same primitive
 * as viPreviewFramesViewer.ts.
 */
function encodeJsonIsland(model) {
  return JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** CSP for the scrubber: only the nonce'd script, data: images, inline styles. */
function scrubberCsp(nonce) {
  return (
    "default-src 'none'; " +
    'img-src data:; ' +
    "style-src 'unsafe-inline'; " +
    `script-src 'nonce-${nonce}'; ` +
    "font-src 'none';"
  );
}

const SCRUBBER_STYLE = `
  html, body { margin: 0; height: 100%; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground, #ddd);
    background: var(--vscode-editor-background, #1e1e1e);
    overflow: hidden;
  }
  #bfs-root { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .bfs-half { position: relative; overflow: hidden; }
  .bfs-benchmark { flex: 0 0 50%; display: flex; border-bottom: 1px solid var(--vscode-editorWidget-border, #555); }
  .bfs-frames { flex: 1 1 50%; background: #ffffff; }
  .bfs-slider-col {
    flex: 0 0 56px; display: flex; flex-direction: column; align-items: center;
    padding: 8px 4px; box-sizing: border-box; gap: 6px;
  }
  .bfs-slider {
    writing-mode: vertical-lr; direction: rtl;
    width: 24px; flex: 1 1 auto; cursor: pointer;
  }
  .bfs-slider-label { font-size: 10px; opacity: 0.7; text-align: center; }
  .bfs-graph-wrap { flex: 1 1 auto; position: relative; }
  .bfs-graph { position: absolute; inset: 0; width: 100%; height: 100%; }
  .bfs-readout {
    position: absolute; left: 8px; top: 6px; z-index: 2;
    font-size: 12px; padding: 2px 8px; border-radius: 3px;
    background: var(--vscode-editorWidget-background, #333);
    border: 1px solid var(--vscode-editorWidget-border, #555);
  }
  .bfs-viewport { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
  .bfs-viewport.bfs-grabbing { cursor: grabbing; }
  .bfs-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; background: #ffffff; }
  .bfs-img { display: block; user-select: none; -webkit-user-drag: none; }
  .bfs-fit {
    position: absolute; right: 8px; bottom: 8px; z-index: 3;
    font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px;
  }
  .bfs-empty { padding: 16px; color: var(--vscode-descriptionForeground, #999); }
`;

/**
 * The scrubber runtime. Written as a string (single-quote concatenation only,
 * no backticks or ${} so it embeds cleanly under a nonce). It reads the
 * `#bfs-model` JSON island and renders the benchmark graph + vertical slider
 * (upper) and the packet-derived frame pane (lower). Self-contained; no VS
 * Code messaging, external resource, or eval.
 */
const SCRUBBER_SCRIPT = `
(function () {
  'use strict';
  var island = document.getElementById('bfs-model');
  var root = document.getElementById('bfs-root');
  if (!island || !root) { return; }
  var model;
  try { model = JSON.parse(island.textContent || '{}'); } catch (e) { model = null; }
  var points = (model && Array.isArray(model.points)) ? model.points : [];
  if (!points.length) {
    root.innerHTML = '<div class="bfs-empty">No captured frames to scrub.</div>';
    return;
  }
  points = points.slice().sort(function (a, b) { return (a.centiseconds || 0) - (b.centiseconds || 0); });
  var anyFrameStart = points.some(function (p) { return p && p.isFrameStart; });
  function eligible(i) { return !anyFrameStart || (points[i] && points[i].isFrameStart); }

  // Mirror of resolveNearestPrecedingIndex (single authoritative semantic).
  function nearestPreceding(targetCs) {
    var idx = -1;
    for (var i = 0; i < points.length; i++) {
      if (!eligible(i)) { continue; }
      if (points[i].centiseconds <= targetCs) { idx = i; } else { break; }
    }
    if (idx === -1) { for (var j = 0; j < points.length; j++) { if (eligible(j)) { return j; } } return 0; }
    return idx;
  }

  var minCs = points[0].centiseconds || 0;
  var maxCs = points[points.length - 1].centiseconds || 0;
  var span = Math.max(1, maxCs - minCs);
  var selected = (model && typeof model.selectedIndex === 'number') ? model.selectedIndex : 0;
  if (selected < 0 || selected >= points.length) { selected = 0; }

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (parent) { parent.appendChild(n); }
    return n;
  }

  // ---- upper half: slider column + benchmark graph -----------------------
  var upper = el('div', 'bfs-half bfs-benchmark', root);
  var sliderCol = el('div', 'bfs-slider-col', upper);
  var topLbl = el('div', 'bfs-slider-label', sliderCol); topLbl.textContent = 'late';
  var slider = el('input', 'bfs-slider', sliderCol);
  slider.type = 'range';
  slider.min = String(minCs); slider.max = String(maxCs); slider.step = 'any';
  slider.value = String(points[selected].centiseconds);
  slider.setAttribute('aria-label', 'Scrub benchmark timeline');
  var botLbl = el('div', 'bfs-slider-label', sliderCol); botLbl.textContent = 'early';

  var graphWrap = el('div', 'bfs-graph-wrap', upper);
  var readout = el('div', 'bfs-readout', graphWrap);
  var svgNs = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('class', 'bfs-graph');
  svg.setAttribute('preserveAspectRatio', 'none');
  graphWrap.appendChild(svg);

  var metricValues = points.map(function (p) { return (typeof p.metricValue === 'number') ? p.metricValue : 0; });
  var minV = Math.min.apply(null, metricValues);
  var maxV = Math.max.apply(null, metricValues);
  var vSpan = Math.max(1e-9, maxV - minV);
  var VW = 1000, VH = 300;
  svg.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
  function gx(cs) { return ((cs - minCs) / span) * (VW - 20) + 10; }
  function gy(v) { return VH - 20 - ((v - minV) / vSpan) * (VH - 40); }

  var poly = document.createElementNS(svgNs, 'polyline');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#4fc1ff');
  poly.setAttribute('stroke-width', '3');
  poly.setAttribute('vector-effect', 'non-scaling-stroke');
  poly.setAttribute('points', points.map(function (p) { return gx(p.centiseconds) + ',' + gy(typeof p.metricValue === 'number' ? p.metricValue : 0); }).join(' '));
  svg.appendChild(poly);

  var dots = points.map(function (p) {
    var c = document.createElementNS(svgNs, 'circle');
    c.setAttribute('cx', String(gx(p.centiseconds)));
    c.setAttribute('cy', String(gy(typeof p.metricValue === 'number' ? p.metricValue : 0)));
    c.setAttribute('r', '5');
    c.setAttribute('fill', '#4fc1ff');
    svg.appendChild(c);
    return c;
  });
  var guide = document.createElementNS(svgNs, 'line');
  guide.setAttribute('y1', '0'); guide.setAttribute('y2', String(VH));
  guide.setAttribute('stroke', '#ff7b72'); guide.setAttribute('stroke-width', '2');
  guide.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(guide);

  // ---- lower half: packet-derived frame pane (pan/zoom/Fit) --------------
  var lower = el('div', 'bfs-half bfs-frames', root);
  var viewport = el('div', 'bfs-viewport', lower);
  var stage = el('div', 'bfs-stage', viewport);
  var img = el('img', 'bfs-img', stage);
  img.draggable = false;
  var fitBtn = el('button', 'bfs-fit', viewport);
  fitBtn.type = 'button'; fitBtn.textContent = 'Fit'; fitBtn.title = 'Fit frame';

  var zoom = 1, panX = 0, panY = 0, dragging = false, sx = 0, sy = 0, px = 0, py = 0;
  var natW = 0, natH = 0;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function apply() { stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')'; }
  function fit() {
    var r = viewport.getBoundingClientRect();
    var w = natW || 1, h = natH || 1;
    if (!(r.width > 2 && r.height > 2)) { return; }
    var pad = 20;
    zoom = clamp(Math.min((r.width - pad) / w, (r.height - pad) / h, 4), 0.02, 8);
    panX = Math.max(0, (r.width - w * zoom) / 2);
    panY = Math.max(0, (r.height - h * zoom) / 2);
    apply();
  }
  fitBtn.addEventListener('click', function (e) { e.stopPropagation(); fit(); });
  viewport.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) { return; }
    e.preventDefault();
    var d = Math.max(-50, Math.min(50, e.deltaY));
    var nz = clamp(zoom * Math.exp(-d * 0.002), 0.02, 8);
    var r = viewport.getBoundingClientRect();
    var cx = (e.clientX - r.left - panX) / zoom, cy = (e.clientY - r.top - panY) / zoom;
    zoom = nz; panX = e.clientX - r.left - cx * zoom; panY = e.clientY - r.top - cy * zoom; apply();
  }, { passive: false });
  viewport.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.bfs-fit')) { return; }
    dragging = true; sx = e.clientX; sy = e.clientY; px = panX; py = panY;
    viewport.classList.add('bfs-grabbing');
    try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
  });
  viewport.addEventListener('pointermove', function (e) { if (dragging) { panX = px + (e.clientX - sx); panY = py + (e.clientY - sy); apply(); } });
  function endDrag() { dragging = false; viewport.classList.remove('bfs-grabbing'); }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  // ---- selection wiring --------------------------------------------------
  function render(i) {
    selected = (i + points.length) % points.length;
    var p = points[selected];
    for (var k = 0; k < dots.length; k++) {
      dots[k].setAttribute('r', k === selected ? '8' : '5');
      dots[k].setAttribute('fill', k === selected ? '#ff7b72' : '#4fc1ff');
    }
    guide.setAttribute('x1', String(gx(p.centiseconds)));
    guide.setAttribute('x2', String(gx(p.centiseconds)));
    readout.textContent = (model.metricLabel || 'metric') + ' @ ' + (p.label || p.centiseconds) + '  (frame ' + (selected + 1) + '/' + points.length + ')';
    root.setAttribute('data-selected-index', String(selected));
    root.setAttribute('data-selected-point-id', p.pointId || '');
    if (img.src !== (p.image || '')) {
      img.onload = function () {
        natW = img.naturalWidth || 320; natH = img.naturalHeight || 240;
        stage.style.width = natW + 'px'; stage.style.height = natH + 'px';
        fit();
      };
      img.src = p.image || '';
    }
  }
  function scrubTo(cs) {
    if (cs < minCs) { cs = minCs; } if (cs > maxCs) { cs = maxCs; }
    render(nearestPreceding(cs));
  }
  slider.addEventListener('input', function () { scrubTo(parseFloat(slider.value)); });
  // Snap the slider handle to the resolved frame-start after a scrub settles.
  slider.addEventListener('change', function () { slider.value = String(points[selected].centiseconds); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return; }
    // Up = later in time (next eligible), Down = earlier (previous eligible).
    var dir = e.key === 'ArrowUp' ? 1 : -1;
    var i = selected;
    do { i += dir; } while (i >= 0 && i < points.length && !eligible(i));
    if (i >= 0 && i < points.length) {
      render(i);
      slider.value = String(points[selected].centiseconds);
    }
    e.preventDefault();
  });

  render(selected);
  slider.value = String(points[selected].centiseconds);
  (window.requestAnimationFrame || function (f) { f(); })(function () { fit(); });
})();
`;

/**
 * Builds the full benchmark frame-scrubber document for a model. The `nonce`
 * must be a per-load random token the webview host also passes to the webview
 * options so only this document's script executes.
 *
 * @param {object} model BenchmarkFrameScrubberModel
 * @param {string} nonce per-load CSP nonce
 * @returns {string} self-contained HTML document
 */
export function buildBenchmarkFrameScrubberHtml(model, nonce) {
  const normalized = {
    title: (model && model.title) || 'Benchmark Frame Scrubber',
    metricLabel: (model && model.metricLabel) || 'metric',
    selectedIndex: (model && typeof model.selectedIndex === 'number') ? model.selectedIndex : 0,
    points: sortPoints(model && model.points)
  };
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${scrubberCsp(nonce)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${(normalized.title || 'Benchmark Frame Scrubber').replace(/</g, '&lt;')}</title>
    <style>${SCRUBBER_STYLE}</style>
  </head>
  <body>
    <div id="bfs-root"></div>
    <script id="bfs-model" type="application/json" nonce="${nonce}">${encodeJsonIsland(normalized)}</script>
    <script nonce="${nonce}">${SCRUBBER_SCRIPT}</script>
  </body>
</html>`;
}
