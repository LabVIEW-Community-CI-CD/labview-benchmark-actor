/**
 * Benchmark presentation builders for the VS Code UI (wire-up of the visual-ring
 * benchmark backbone into the shipping extension).
 *
 * Three surfaces, all PURE + deterministic so the document shape stays testable
 * without a browser host (same discipline as buildBenchmarkFrameScrubberHtml):
 *
 *   1. buildBenchmarkPanelHtml(record, nonce)  — a SINGLE boot-benchmark-v1
 *      record (e.g. a LabVIEW IDE-launch): the launchMs headline, the UI-READY
 *      settle pin rendered as an 8x8 dhash grid (the perceptual fingerprint the
 *      capture settled on), and the capture stats. STATIC (no client script).
 *
 *   2. buildTrendPanelHtml(trend, nonce)  — a workload-trend@1 record: the run
 *      series as an SVG chart with the baseline + least-squares slope, the
 *      PASS/REGRESSION verdict badge, and the stats. STATIC (no client script).
 *
 *   3. scrubberModelFromTrend / scrubberModelFromRecord  — map real benchmark
 *      data into the BenchmarkFrameScrubberModel consumed by the proven
 *      buildBenchmarkFrameScrubberHtml vertical-line scrubber (the frame
 *      correlator): each point carries its launchMs (graph) + its captured
 *      UI-READY frame as a dhash-grid image (lower pane).
 *
 * dhash rendering uses the same MSB-first 64-bit projection as the single-source
 * dhashHexToBits (fingerprint.mjs) so the grid is exactly the 64 bits the
 * benchmark's settle detector compares. It is INLINED here (not imported) so
 * this module is self-contained and stageable into the extension's media/ dir
 * (the same discipline as media/counter-render.mjs); verify-benchmark-panels.mjs
 * guards it against the canonical dhashHexToBits so the two never drift.
 */

// --- shared primitives -----------------------------------------------------

/** dhash-64 (16 hex) -> its 64-bit value. Inlined twin of fingerprint.mjs dhashHexToBits (drift-guarded). */
function dhashHexToBits(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{16}$/.test(hex)) {
    throw new Error('dhashHexToBits: exactly 16 hex chars required (dhash-64)');
  }
  return BigInt(`0x${hex}`);
}

/** HTML-escape text for safe insertion into element content / attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A strict webview CSP for a STATIC panel: no scripts at all, only inline styles + data: images. */
function staticPanelCsp() {
  return "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none';";
}

/**
 * Decode a dhash-64 (16 hex chars) into an 8x8 boolean grid, MSB-first (bit 63 =
 * row 0 / col 0, row-major). This is the 64 bits the perceptual fingerprint IS.
 * @param {string} dhashHex 16 hex chars
 * @returns {boolean[][]} 8 rows x 8 cols
 */
export function dhashGridCells(dhashHex) {
  const bits = dhashHexToBits(dhashHex); // throws unless exactly 16 hex chars
  const rows = [];
  for (let r = 0; r < 8; r += 1) {
    const row = [];
    for (let c = 0; c < 8; c += 1) {
      const bitIndex = 63 - (r * 8 + c);
      row.push(((bits >> BigInt(bitIndex)) & 1n) === 1n);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Render a dhash-64 as an 8x8 SVG grid. Deterministic string output. The SVG
 * carries explicit width/height so an <img src="data:..."> reports a natural
 * size (the scrubber's Fit relies on it).
 * @param {string} dhashHex 16 hex chars
 * @param {{cell?:number, on?:string, off?:string, gap?:number}} [opts]
 * @returns {string} SVG document string
 */
export function dhashGridSvg(dhashHex, opts = {}) {
  const cell = opts.cell || 24;
  const gap = opts.gap || 1;
  const on = opts.on || '#4fc1ff';
  const off = opts.off || '#101418';
  const cells = dhashGridCells(dhashHex);
  const size = cell * 8;
  const rects = [];
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const x = c * cell + gap;
      const y = r * cell + gap;
      const w = cell - gap * 2;
      rects.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="${cells[r][c] ? on : off}"/>`
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-label="perceptual fingerprint dhash-64 ${dhashHex}">` +
    `<rect width="${size}" height="${size}" fill="${off}"/>${rects.join('')}</svg>`
  );
}

/** dhash-64 -> a `data:image/svg+xml;base64,...` URI (the scrubber frame image). */
export function dhashGridDataUri(dhashHex, opts = {}) {
  const svg = dhashGridSvg(dhashHex, opts);
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

const PANEL_STYLE = `
  :root { color-scheme: dark light; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground, #ddd);
    background: var(--vscode-editor-background, #1e1e1e);
    margin: 0; padding: 16px;
  }
  h2 { margin: 0 0 2px; font-size: 1.15em; }
  .sub { opacity: 0.7; font-size: 0.85em; margin-bottom: 14px; }
  .headline { font-size: 2.2em; font-weight: 600; }
  .headline small { font-size: 0.4em; font-weight: 400; opacity: 0.7; }
  .row { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
  .card {
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
    border-radius: 6px; padding: 12px 14px;
  }
  .grid-cap { font-size: 0.8em; opacity: 0.7; margin-top: 6px; text-align: center; }
  table { border-collapse: collapse; font-size: 0.9em; }
  td { padding: 2px 12px 2px 0; vertical-align: top; }
  td.k { opacity: 0.7; }
  td.v { font-family: var(--vscode-editor-font-family, monospace); }
  .badge { display: inline-block; padding: 2px 12px; border-radius: 12px; font-weight: 600; font-size: 0.9em; }
  .badge.pass { background: #1b5e20; color: #e8f5e9; }
  .badge.fail { background: #7f1d1d; color: #fdecec; }
  .chart { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-editorWidget-border, #3c3c3c); border-radius: 6px; }
  .legend { font-size: 0.8em; opacity: 0.8; margin-top: 6px; }
  .legend span { margin-right: 16px; }
  .dot { display: inline-block; width: 10px; height: 3px; vertical-align: middle; margin-right: 4px; }
`;

function panelDoc(title, nonce, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${staticPanelCsp()}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style nonce="${nonce}">${PANEL_STYLE}</style>
  </head>
  <body>${bodyHtml}</body>
</html>`;
}

// --- 1. single benchmark record -------------------------------------------

/** The launchMs (or first) span of a boot-benchmark-v1 record. */
function primarySpan(record, preferredId) {
  const spans = Array.isArray(record?.spans) ? record.spans : [];
  if (preferredId) {
    const hit = spans.find((s) => s && s.id === preferredId);
    if (hit) return hit;
  }
  return spans.find((s) => s && s.id === 'launchMs') || spans[0] || null;
}

/** The settled (UI-READY) frame of a record, else the first frame. */
function settleFrame(record) {
  const frames = Array.isArray(record?.frames) ? record.frames : [];
  return frames.find((f) => f && f.settled) || frames[0] || null;
}

/**
 * Build the single-benchmark panel document for a boot-benchmark-v1 record.
 * @param {object} record boot-benchmark-v1
 * @param {string} nonce per-load CSP nonce
 * @returns {string} self-contained HTML
 */
export function buildBenchmarkPanelHtml(record, nonce) {
  const span = primarySpan(record);
  const frame = settleFrame(record);
  const detail = (record && record.sourceDetail) || {};
  const ms = span && typeof span.ms === 'number' ? span.ms : null;
  const spanId = span ? span.id : 'metric';

  const gridHtml = frame && frame.perceptualFingerprint
    ? `<img width="196" height="196" alt="UI-READY perceptual fingerprint" src="${dhashGridDataUri(frame.perceptualFingerprint)}" />`
    : '<div class="grid-cap">no captured frame</div>';

  const rows = [];
  const stat = (k, v) => {
    if (v !== undefined && v !== null && v !== '') rows.push(`<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>`);
  };
  if (span) stat('span', `${span.id}  (${span.from || '?'} \u2192 ${span.to || '?'})`);
  if (span) stat('clock / scope', `${span.clock || '?'} / ${span.scope || '?'}`);
  stat('frames captured', detail.framesCaptured);
  stat('stable tail frames', detail.stableTailFrames);
  if (detail.settleOpts) stat('settle window', `${detail.settleOpts.window} frames, tol ${detail.settleOpts.toleranceHamming}`);
  if (frame) stat('UI-READY dhash', frame.perceptualFingerprint);
  if (frame && frame.integrityHash) stat('integrity', String(frame.integrityHash).slice(0, 16) + '\u2026');

  const body = `
    <h2>${escapeHtml(record?.workload || 'benchmark')} \u2014 single run</h2>
    <div class="sub">${escapeHtml(record?.plane || '?')} \u00b7 ${escapeHtml(record?.hypervisor || '?')} \u00b7 ${escapeHtml(record?.substrate || record?.source || '')}</div>
    <div class="headline">${ms === null ? '\u2014' : escapeHtml(ms)}<small> ms ${escapeHtml(spanId)}</small></div>
    <div class="row" style="margin-top:16px;">
      <div class="card">
        ${gridHtml}
        <div class="grid-cap">UI-READY frame \u00b7 dhash-64 perceptual fingerprint</div>
      </div>
      <div class="card"><table>${rows.join('')}</table></div>
    </div>`;
  return panelDoc(`${record?.workload || 'benchmark'} \u2014 run`, nonce, body);
}

// --- 2. trend --------------------------------------------------------------

/**
 * Build the trend panel document for a workload-trend@1 record: an SVG run-series
 * chart (points + baseline + least-squares slope), the PASS/REGRESSION verdict
 * badge, and the stats.
 * @param {object} trend workload-trend@1
 * @param {string} nonce per-load CSP nonce
 * @returns {string} self-contained HTML
 */
export function buildTrendPanelHtml(trend, nonce) {
  const values = Array.isArray(trend?.values) ? trend.values.map(Number) : [];
  const stats = (trend && trend.stats) || {};
  const baseline = typeof trend?.baselineMs === 'number' ? trend.baselineMs : (stats.median ?? 0);
  const n = values.length;
  const verdict = trend?.verdict || (trend?.regressed ? 'REGRESSION' : 'PASS');
  const pass = verdict === 'PASS';

  // Chart geometry (static SVG). Domain spans the values + the baseline, padded.
  const W = 720, H = 300, PADL = 52, PADR = 16, PADT = 20, PADB = 34;
  const domainVals = values.concat([baseline]).filter((v) => Number.isFinite(v));
  const vMin = domainVals.length ? Math.min(...domainVals) : 0;
  const vMax = domainVals.length ? Math.max(...domainVals) : 1;
  const padV = Math.max(1, (vMax - vMin) * 0.15);
  const yLo = vMin - padV, yHi = vMax + padV;
  const xOf = (i) => PADL + (n <= 1 ? (W - PADL - PADR) / 2 : (i / (n - 1)) * (W - PADL - PADR));
  const yOf = (v) => PADT + (1 - (v - yLo) / (yHi - yLo || 1)) * (H - PADT - PADB);

  // Least-squares slope line across the run index (matches trend.slopeMsPerRun).
  const slope = typeof trend?.slopeMsPerRun === 'number' ? trend.slopeMsPerRun : 0;
  const meanX = n ? (n - 1) / 2 : 0;
  const meanY = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const slopeY = (i) => meanY + slope * (i - meanX);

  const svgParts = [];
  // y grid: baseline + min/max ticks
  const tick = (v, label, cls) => {
    const y = yOf(v);
    svgParts.push(`<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="${cls}" stroke-width="1" stroke-dasharray="${cls === '#888' ? '4 4' : '2 6'}" opacity="0.6"/>`);
    svgParts.push(`<text x="6" y="${(y + 4).toFixed(1)}" fill="var(--vscode-foreground,#ddd)" font-size="11" opacity="0.8">${escapeHtml(label)}</text>`);
  };
  tick(baseline, `base ${Math.round(baseline)}`, '#888');

  // slope line
  if (n >= 2) {
    svgParts.push(
      `<line x1="${xOf(0).toFixed(1)}" y1="${yOf(slopeY(0)).toFixed(1)}" x2="${xOf(n - 1).toFixed(1)}" y2="${yOf(slopeY(n - 1)).toFixed(1)}" stroke="#c586c0" stroke-width="2" stroke-dasharray="6 4"/>`
    );
  }
  // series polyline
  if (n >= 2) {
    svgParts.push(
      `<polyline fill="none" stroke="#4fc1ff" stroke-width="2" points="${values.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')}"/>`
    );
  }
  // run markers + x labels + value labels
  values.forEach((v, i) => {
    const x = xOf(i), y = yOf(v);
    const over = v > baseline;
    svgParts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${over ? '#ff7b72' : '#4fc1ff'}"/>`);
    svgParts.push(`<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" fill="var(--vscode-foreground,#ddd)" font-size="10" text-anchor="middle" opacity="0.85">${escapeHtml(v)}</text>`);
    svgParts.push(`<text x="${x.toFixed(1)}" y="${(H - 12).toFixed(1)}" fill="var(--vscode-foreground,#ddd)" font-size="10" text-anchor="middle" opacity="0.6">${i + 1}</text>`);
  });
  // latest marker ring
  if (n) {
    const x = xOf(n - 1), y = yOf(values[n - 1]);
    svgParts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="none" stroke="#ffd166" stroke-width="2"/>`);
  }

  const svg = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(trend?.metric || 'metric')} over ${n} runs">${svgParts.join('')}</svg>`;

  const rows = [];
  const stat = (k, v) => {
    if (v !== undefined && v !== null && v !== '') rows.push(`<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>`);
  };
  stat('runs (n)', n);
  stat('mean', stats.mean);
  stat('median', stats.median);
  stat('min / max', `${stats.min} / ${stats.max}`);
  stat('stddev', stats.stddev);
  stat('spread', stats.spread);
  stat('baseline', baseline);
  stat('tolerance', trend?.toleranceMs);
  stat('latest', trend?.latest);
  stat('slope', `${slope} ms/run`);
  if (trend?.driftThresholdMsPerRun != null) stat('drift threshold', `${trend.driftThresholdMsPerRun} ms/run \u2192 ${trend.drifting ? 'DRIFTING' : 'stable'}`);
  const ceiling = Number.isFinite(baseline) && typeof trend?.toleranceMs === 'number' ? baseline + trend.toleranceMs : null;

  const body = `
    <h2>${escapeHtml(trend?.workload || 'benchmark')} \u2014 ${escapeHtml(trend?.metric || 'metric')} trend
      <span class="badge ${pass ? 'pass' : 'fail'}">${escapeHtml(verdict)}</span></h2>
    <div class="sub">${escapeHtml(trend?.plane || '?')} \u00b7 ${escapeHtml(trend?.hypervisor || '?')} \u00b7 ${n} runs</div>
    <div class="row">
      <div>
        ${svg}
        <div class="legend">
          <span><span class="dot" style="background:#4fc1ff"></span>${escapeHtml(trend?.metric || 'metric')} per run</span>
          <span><span class="dot" style="background:#888"></span>baseline (median)</span>
          <span><span class="dot" style="background:#c586c0"></span>least-squares slope</span>
          <span><span class="dot" style="background:#ffd166"></span>latest</span>
        </div>
        ${ceiling !== null ? `<div class="legend">regression ceiling ${escapeHtml(Math.round(ceiling))} ms (baseline + tolerance) \u2014 ${trend?.regressed ? 'BREACHED' : 'not breached'}.</div>` : ''}
      </div>
      <div class="card"><table>${rows.join('')}</table></div>
    </div>`;
  return panelDoc(`${trend?.metric || 'metric'} trend`, nonce, body);
}

// --- 3. frame-correlator scrubber models -----------------------------------

/**
 * Map a workload-trend@1 record into a BenchmarkFrameScrubberModel: one scrubber
 * point per run (evenly spaced), the run's metric on the graph, and the captured
 * UI-READY frame (a dhash grid) in the lower pane. The vertical slider then
 * correlates each run's launchMs with the frame the capture settled on.
 *
 * @param {object} trend workload-trend@1
 * @param {{pinDhash?:string, title?:string}} [opts] pinDhash = the settled dhash
 *   captured for these runs (from the paired record); defaults to a neutral grid.
 * @returns {object} BenchmarkFrameScrubberModel
 */
export function scrubberModelFromTrend(trend, opts = {}) {
  const values = Array.isArray(trend?.values) ? trend.values.map(Number) : [];
  if (values.length === 0) {
    throw new Error('scrubberModelFromTrend: trend has no values[]');
  }
  const pinDhash = opts.pinDhash && /^[0-9a-fA-F]{16}$/.test(opts.pinDhash) ? opts.pinDhash : '0000000000000000';
  const image = dhashGridDataUri(pinDhash);
  const points = values.map((v, i) => ({
    pointId: `run-${i + 1}`,
    label: `run ${i + 1}`,
    centiseconds: i * 100,
    metricValue: v,
    image,
    isFrameStart: true,
  }));
  return {
    title: opts.title || `${trend?.workload || 'benchmark'} \u2014 ${trend?.metric || 'metric'} frame correlator`,
    metricLabel: trend?.metric || 'metric',
    selectedIndex: values.length - 1,
    points,
  };
}

/**
 * Map a single boot-benchmark-v1 record's frames into a BenchmarkFrameScrubberModel
 * (each milestone frame -> a scrubber point, its dhash rendered as the frame). Used
 * when a record carries a multi-frame capture trace.
 *
 * @param {object} record boot-benchmark-v1
 * @param {{title?:string, metric?:string}} [opts]
 * @returns {object} BenchmarkFrameScrubberModel
 */
export function scrubberModelFromRecord(record, opts = {}) {
  const frames = Array.isArray(record?.frames) ? record.frames.filter((f) => f && f.perceptualFingerprint) : [];
  if (frames.length === 0) {
    throw new Error('scrubberModelFromRecord: record has no fingerprinted frames');
  }
  const points = frames
    .map((f, i) => ({
      pointId: f.caseId || `frame-${i}`,
      label: f.caseId || `frame ${i}`,
      centiseconds: typeof f.index === 'number' ? f.index : i,
      metricValue: typeof f.index === 'number' ? f.index : i,
      image: dhashGridDataUri(f.perceptualFingerprint),
      isFrameStart: Boolean(f.settled) || frames.length === 1,
    }))
    .sort((a, b) => a.centiseconds - b.centiseconds);
  return {
    title: opts.title || `${record?.workload || 'benchmark'} \u2014 frame correlator`,
    metricLabel: opts.metric || 'frameIndex',
    selectedIndex: points.length - 1,
    points,
  };
}
