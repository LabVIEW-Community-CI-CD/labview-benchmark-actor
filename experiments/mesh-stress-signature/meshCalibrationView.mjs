// meshCalibrationView.mjs -- the Mesh-Stress Calibration ANALYSIS VIEW (overview.md §3.6 / VW-1, LBA-REQ-032).
//
// Renders a committed live mesh-stress ladder receipt (mesh-stress-live-ladder@1) into a self-contained,
// SCRIPT-FREE HTML analysis surface: the commanded ladder (idle -> saturate), the cpuTotalPct.mean calibration
// curve with its per-rung tolerance BAND (SVG), the monotone / separable / repeatable invariants, the
// per-boundary separability, and the inverse-read readout. Pure builder (no VS Code API) so the markup is
// deterministically testable; script-free (CSP `script-src 'none'`) so the surface is inert and safe to embed.

export const MESH_CALIBRATION_VIEW_SCHEMA = 'labview-benchmark-actor/mesh-stress-calibration-view@1';

const RUNG_ORDER = ['idle', 'light', 'medium', 'heavy', 'saturate'];

/** Escape text for safe HTML insertion. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Round a coordinate to a stable 1-decimal number (no float noise in the markup). */
function n1(x) { return Number(Number(x).toFixed(1)); }

/** Clamp a percentage into [0, 100]. */
function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }

/**
 * The cpuTotalPct.mean calibration curve as an SVG: a shaded tolerance band (expected +/- tolerance) with the
 * expected polyline + per-rung points labelled with their value. y axis is a fixed 0..100 percentage scale.
 */
function calibrationSvg(curve) {
  const W = 640; const H = 280; const padL = 48; const padR = 20; const padT = 20; const padB = 44;
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const pts = Array.isArray(curve) ? curve : [];
  const cnt = pts.length;
  const xAt = (i) => padL + (cnt <= 1 ? 0 : (i / (cnt - 1)) * plotW);
  const yAt = (v) => padT + (1 - pct(v) / 100) * plotH;

  const grid = [0, 25, 50, 75, 100].map((g) => {
    const y = n1(yAt(g));
    return `<line class="mc-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`
      + `<text class="mc-axis" x="${padL - 6}" y="${n1(y + 3)}" text-anchor="end">${g}</text>`;
  }).join('');

  const upper = pts.map((p, i) => `${n1(xAt(i))},${n1(yAt(pct(p.expected) + (Number(p.tolerance) || 0)))}`);
  const lower = pts.map((p, i) => `${n1(xAt(i))},${n1(yAt(pct(p.expected) - (Number(p.tolerance) || 0)))}`).reverse();
  const band = cnt >= 2 ? `<polygon class="mc-band" points="${upper.concat(lower).join(' ')}"/>` : '';

  const line = `<polyline class="mc-line" points="${pts.map((p, i) => `${n1(xAt(i))},${n1(yAt(p.expected))}`).join(' ')}"/>`;

  const marks = pts.map((p, i) => {
    const x = n1(xAt(i)); const y = n1(yAt(p.expected));
    const rung = esc(p.rung == null ? '' : p.rung);
    return `<circle class="mc-dot" cx="${x}" cy="${y}" r="4"/>`
      + `<text class="mc-val" x="${x}" y="${n1(y - 9)}" text-anchor="middle">${n1(p.expected)}%</text>`
      + `<text class="mc-rung" x="${x}" y="${H - padB + 16}" text-anchor="middle">${rung}</text>`;
  }).join('');

  return `<svg class="mc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="cpuTotalPct calibration curve">`
    + `<text class="mc-axis-title" x="${padL}" y="12">cpuTotalPct.mean (%) vs stress rung</text>`
    + grid + band + line + marks + '</svg>';
}

/**
 * Build the mesh-stress calibration analysis view.
 * @param {object} receipt - a mesh-stress-live-ladder@1 receipt.
 * @param {{cspSource?: string}} [opts]
 * @returns {string} a self-contained, script-free HTML document.
 */
export function buildMeshCalibrationHtml(receipt, opts = {}) {
  const r = receipt || {};
  const host = r.host || {};
  const ladder = r.ladder || {};
  const inv = r.invariants || {};
  const ir = r.inverseRead || {};
  const curve = Array.isArray(r.cpuTotalPctMeanCurve) ? r.cpuTotalPctMeanCurve : [];
  const salient = Array.isArray(r.salientDimensions) ? r.salientDimensions : [];
  const sep = Array.isArray(r.separability) ? r.separability : [];
  const commanded = Array.isArray(ladder.commanded) ? ladder.commanded : [];
  const cspSource = opts.cspSource || '';

  const monotonePct = Number.isFinite(inv.monotone) ? Math.round(inv.monotone * 100) : 0;
  const badge = (ok, label) => `<span class="mc-badge ${ok ? 'ok' : 'no'}">${ok ? '\u2713' : '\u2717'} ${esc(label)}</span>`;

  const ladderChips = commanded.map((c) => `<span class="mc-chip"><b>${esc(c.rung)}</b><small>${esc(c.spinners)} load</small></span>`).join('');

  const sepRows = sep.map((s) => `<tr><td>${esc(s.from)} \u2192 ${esc(s.to)}</td><td class="mc-num">${esc(s.separableDims)}</td></tr>`).join('');

  const irOk = ir.heldOutRung != null && ir.heldOutRung === ir.inferredRung;
  const conf = Number.isFinite(ir.confidence) ? ir.confidence : 0;

  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${cspSource || "'none'"}; script-src 'none';`;

  const style = `
    :root { color-scheme: dark; }
    html, body { margin: 0; }
    body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #ddd);
      background: var(--vscode-editor-background, #1e1e1e); padding: 16px 20px; line-height: 1.4; }
    h1 { font-size: 16px; margin: 0 0 2px; } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
      opacity: .75; margin: 18px 0 8px; }
    .mc-sub { font-size: 12px; opacity: .7; margin: 0 0 4px; font-family: var(--vscode-editor-font-family, monospace); }
    .mc-panel { background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-editorWidget-border, #444);
      border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
    .mc-svg { width: 100%; height: auto; display: block; }
    .mc-grid { stroke: var(--vscode-editorWidget-border, #444); stroke-width: 1; opacity: .5; }
    .mc-axis, .mc-axis-title { fill: var(--vscode-descriptionForeground, #999); font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace); }
    .mc-band { fill: #4fc1ff; opacity: .16; }
    .mc-line { fill: none; stroke: #4fc1ff; stroke-width: 2; }
    .mc-dot { fill: #4fc1ff; }
    .mc-val { fill: var(--vscode-foreground, #ddd); font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); }
    .mc-rung { fill: var(--vscode-descriptionForeground, #999); font-size: 11px; }
    .mc-chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .mc-chip { display: inline-flex; flex-direction: column; align-items: center; padding: 4px 10px; border-radius: 5px;
      background: var(--vscode-badge-background, #333); }
    .mc-chip small { opacity: .7; font-size: 10px; }
    .mc-badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .mc-badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
    .mc-badge.ok { background: #16371f; color: #82e0aa; } .mc-badge.no { background: #3a1a1a; color: #ff8fab; }
    table { border-collapse: collapse; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
    td { padding: 2px 14px 2px 0; } .mc-num { text-align: right; }
    .mc-ir { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
    .mc-ir b { color: #4fc1ff; } .mc-salient { font-size: 11px; opacity: .75; word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace); }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Mesh-Stress Calibration</title>
<style>${style}</style>
</head>
<body>
<h1>Mesh-Stress Calibration &mdash; Analysis view</h1>
<p class="mc-sub">${esc(r.schema || '')} &middot; ${esc(host.hostname || 'host')} &middot; ${esc(host.cpus)} cores &middot; ${esc(host.totalMemGb)} GB &middot; ${esc(r.frameRateHz)} FPS &middot; ${esc(ladder.repeats)}\u00d7 repeats</p>

<h2>Commanded ladder</h2>
<div class="mc-chips">${ladderChips}</div>

<h2>cpuTotalPct calibration curve</h2>
<div class="mc-panel">${calibrationSvg(curve)}</div>

<h2>Invariants</h2>
<div class="mc-badges">
${badge(monotonePct >= 90, `monotone ${monotonePct}%`)}
${badge(inv.separable === true, 'separable')}
${badge(inv.repeatable === true, 'repeatable')}
<span class="mc-badge ok">${esc(salient.length)} salient dims</span>
</div>

<h2>Rung separability</h2>
<table><tbody>${sepRows}</tbody></table>

<h2>Inverse read</h2>
<p class="mc-ir">observed <b>${esc(ir.heldOutRung)}</b> signature &rarr; inferred <b>${esc(ir.inferredRung)}</b>
&middot; confidence ${n1(conf)} &middot; ${irOk ? 'recovered \u2713' : 'mismatch \u2717'}</p>

<h2>Salient dimensions</h2>
<p class="mc-salient">${salient.map((d) => esc(d)).join(' &middot; ')}</p>
</body>
</html>`;
}
