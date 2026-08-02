// meshBoardView.mjs -- the Concurrent Mesh BOARD (overview.md §3.6 / VW-1, LBA-REQ-032). Where
// meshCalibrationView renders the calibration CURVE (rung -> expected value, the reference), this renders a LIVE
// MESH SNAPSHOT: N actors stressed SIMULTANEOUSLY, each shown as a tile with its commanded rung, its measured
// stress bar (cpuPoolPct of its own core budget), and the rung the calibration INVERSE-READ back from its
// concurrent signature -- so an operator sees, at a glance, which actor is stressed and how much, right now.
// Renders a committed mesh-concurrent-actors@1 receipt. Pure builder (no VS Code API), SCRIPT-FREE (CSP
// script-src 'none'), all data entity-escaped -- deterministically testable + inert to embed.

export const MESH_BOARD_VIEW_SCHEMA = 'labview-benchmark-actor/mesh-board-view@1';

/** Escape text for safe HTML insertion. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Round to 1 decimal. */
function n1(x) { return Number(Number(x).toFixed(1)); }
/** Clamp a percentage into [0, 100]. */
function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }

/**
 * Build the concurrent mesh board.
 * @param {object} receipt - a mesh-concurrent-actors@1 receipt.
 * @param {{cspSource?: string}} [opts]
 * @returns {string} a self-contained, script-free HTML document.
 */
export function buildMeshBoardHtml(receipt, opts = {}) {
  const r = receipt || {};
  const host = r.host || {};
  const inv = r.invariants || {};
  const conc = r.concurrency || {};
  const measured = r.measured || {};
  const actors = Array.isArray(r.actors) ? r.actors : [];
  const irByActor = new Map((Array.isArray(r.perActorInverseRead) ? r.perActorInverseRead : []).map((x) => [x.actor, x]));
  const cspSource = opts.cspSource || '';

  const monotonePct = Number.isFinite(inv.monotone) ? Math.round(inv.monotone * 100) : 0;
  const badge = (ok, label) => `<span class="mb-badge ${ok ? 'ok' : 'no'}">${ok ? '\u2713' : '\u2717'} ${esc(label)}</span>`;

  const tiles = actors.map((a) => {
    const ir = irByActor.get(a.actor) || {};
    const filled = pct(a.cpuPoolPctMean);
    const recovered = ir.correct === true;
    const inferred = ir.inferredRung == null ? '?' : ir.inferredRung;
    return `<div class="mb-tile">
      <div class="mb-head"><b>${esc(a.actor)}</b><span class="mb-rung">${esc(a.rung)}</span></div>
      <div class="mb-barwrap" role="img" aria-label="stress ${n1(filled)} percent">
        <div class="mb-bar" style="width:${n1(filled)}%"></div>
        <span class="mb-pct">${n1(filled)}%</span>
      </div>
      <div class="mb-infer">read \u2192 <b>${esc(inferred)}</b>
        <span class="mb-mark ${recovered ? 'ok' : 'no'}">${recovered ? '\u2713' : '\u2717'}</span>
        <small>conf ${Number.isFinite(ir.confidence) ? n1(ir.confidence) : '?'}</small></div>
    </div>`;
  }).join('');

  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${cspSource || "'none'"}; script-src 'none';`;

  const style = `
    :root { color-scheme: dark; }
    html, body { margin: 0; }
    body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #ddd);
      background: var(--vscode-editor-background, #1e1e1e); padding: 16px 20px; line-height: 1.4; }
    h1 { font-size: 16px; margin: 0 0 2px; } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
      opacity: .75; margin: 18px 0 8px; }
    .mb-sub { font-size: 12px; opacity: .7; margin: 0; font-family: var(--vscode-editor-font-family, monospace); }
    .mb-badges { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .mb-badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
    .mb-badge.ok { background: #16371f; color: #82e0aa; } .mb-badge.no { background: #3a1a1a; color: #ff8fab; }
    .mb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 8px; }
    .mb-tile { background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-editorWidget-border, #444);
      border-radius: 6px; padding: 10px 12px; }
    .mb-head { display: flex; justify-content: space-between; align-items: baseline; }
    .mb-rung { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #4fc1ff;
      font-family: var(--vscode-editor-font-family, monospace); }
    .mb-barwrap { position: relative; height: 16px; background: #333; border-radius: 4px; margin: 8px 0 6px; overflow: hidden; }
    .mb-bar { position: absolute; inset: 0 auto 0 0; height: 100%; background: linear-gradient(90deg, #4fc1ff, #ff8fab); }
    .mb-pct { position: absolute; right: 6px; top: 0; font-size: 11px; line-height: 16px; color: #ddd;
      font-family: var(--vscode-editor-font-family, monospace); text-shadow: 0 0 3px #000; }
    .mb-infer { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
    .mb-infer b { color: #4fc1ff; }
    .mb-mark.ok { color: #82e0aa; } .mb-mark.no { color: #ff8fab; }
    .mb-infer small { opacity: .6; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Concurrent Mesh Board</title>
<style>${style}</style>
</head>
<body>
<h1>Concurrent Mesh Board &mdash; who is stressed, how much, right now</h1>
<p class="mb-sub">${esc(r.schema || '')} &middot; ${esc(host.cpus)} cores &middot; ${esc(actors.length)} actors sampled simultaneously &middot; ${esc(measured.effectiveFps)} FPS &middot; ${esc(conc.simultaneousFrames)} frames</p>

<div class="mb-badges">
${badge(r.allActorsRecovered === true, 'all actors recovered')}
${badge(conc.allActorsSampledEveryFrame === true, `${esc(conc.actorsPerFrame)} actors / frame (simultaneous)`)}
${badge(measured.exactly12fps === true, 'exactly 12 FPS')}
${badge(monotonePct >= 90, `monotone ${monotonePct}%`)}
${badge(inv.separable === true, 'separable')}
${badge(inv.repeatable === true, 'repeatable')}
</div>

<h2>Actors (${esc(actors.length)})</h2>
<div class="mb-grid">${tiles}</div>
</body>
</html>`;
}
