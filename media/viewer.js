// LBA-REQ-004 benchmark viewer (webview presentation layer): render a benchmark metric time-series and a
// draggable TIME cursor over the run window. All cursor behavior is delegated to the SHIPPED, unit-tested
// core (experiments/viewer-cursor/viewerCursor.mjs, staged into media/ at build) imported VERBATIM -- pointer
// drag + Left/Right + Home/End map to a time-axis sample, always clamped to [first, last]. The selected time
// is the single source of truth posted back to the host for the linked picture panel (LBA-REQ-005).
//
// This file is pure presentation (SVG + DOM events). It adds NO cursor math of its own: the snap/step/jump
// logic that verify-viewer-cursor.mjs proves 5/5 is the exact logic that runs here, so the interaction is
// correct by construction (the browser render itself is the maintainer/Playwright step).
import { createCursor, setPointer, step, jump, selectedIndex, selectedTime } from './viewerCursor.mjs';
import { createCounter, tick, setCase, counterSvg } from './counter-render.mjs';

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

// The series is injected by the extension as a non-executed JSON data block.
const series = JSON.parse(document.getElementById('lba-series').textContent); // [{ t, v }]
const times = series.map((s) => s.t);
const values = series.map((s) => s.v);

let cursor = createCursor(times);

const svg = document.getElementById('chart');
const W = 800;
const H = 240;
const PAD = 32;
const tMin = times[0];
const tMax = times[times.length - 1];
const vMin = Math.min(...values);
const vMax = Math.max(...values);
const spanT = tMax - tMin || 1;
const spanV = vMax - vMin || 1;
const xOf = (t) => PAD + ((t - tMin) / spanT) * (W - 2 * PAD);
const yOf = (v) => H - PAD - ((v - vMin) / spanV) * (H - 2 * PAD);

const SVGNS = 'http://www.w3.org/2000/svg';
function el(name, attrs) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, val] of Object.entries(attrs)) {
    n.setAttribute(k, String(val));
  }
  return n;
}

// Metric polyline (drawn once).
svg.appendChild(
  el('polyline', {
    fill: 'none',
    stroke: 'var(--vscode-charts-blue, #3794ff)',
    'stroke-width': 2,
    points: series.map((s) => `${xOf(s.t)},${yOf(s.v)}`).join(' '),
  })
);

// Draggable time cursor line + selected-sample marker (repositioned on each render).
const cursorLine = el('line', { stroke: 'var(--vscode-charts-red, #f14c4c)', 'stroke-width': 2, y1: PAD, y2: H - PAD });
const dot = el('circle', { r: 5, fill: 'var(--vscode-charts-red, #f14c4c)' });
svg.appendChild(cursorLine);
svg.appendChild(dot);

const readout = document.getElementById('readout');

function render() {
  const i = selectedIndex(cursor);
  const t = selectedTime(cursor);
  const v = values[i];
  const x = xOf(t);
  cursorLine.setAttribute('x1', x);
  cursorLine.setAttribute('x2', x);
  dot.setAttribute('cx', x);
  dot.setAttribute('cy', yOf(v));
  readout.textContent = `sample ${i + 1}/${times.length}  t=${t}  value=${v}`;
  // Bind the linked picture panel (LBA-REQ-005) to the one selected-time value.
  if (vscode) {
    vscode.postMessage({ type: 'cursor', index: i, time: t, value: v });
  }
}

// Map a pointer event to a [0,1] fraction of the plot width in viewBox space (setPointer clamps out-of-range).
function pointerToFraction(evt) {
  const rect = svg.getBoundingClientRect();
  const vbX = (evt.clientX - rect.left) * (W / rect.width);
  return (vbX - PAD) / (W - 2 * PAD);
}

let dragging = false;
svg.addEventListener('pointerdown', (e) => {
  dragging = true;
  try {
    svg.setPointerCapture(e.pointerId);
  } catch {
    /* capture is best-effort */
  }
  cursor = setPointer(cursor, pointerToFraction(e));
  render();
});
svg.addEventListener('pointermove', (e) => {
  if (dragging) {
    cursor = setPointer(cursor, pointerToFraction(e));
    render();
  }
});
svg.addEventListener('pointerup', (e) => {
  dragging = false;
  try {
    svg.releasePointerCapture(e.pointerId);
  } catch {
    /* release is best-effort */
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') {
    cursor = step(cursor, -1);
  } else if (e.key === 'ArrowRight') {
    cursor = step(cursor, 1);
  } else if (e.key === 'Home') {
    cursor = jump(cursor, 'start');
  } else if (e.key === 'End') {
    cursor = jump(cursor, 'end');
  } else {
    return;
  }
  e.preventDefault();
  render();
});

render();

// Manual-procedure-record on-screen anchor (opt-in, LBA-REQ-004 capture sessions only). The host injects a
// #lba-mpr-counter element (its data-case marks the active reviewer case) ONLY when a deterministic-record
// capture is running. When present, tick a monotonic plain-digit counter -- the exact glyphs the known-digit
// reader templates -- into it and post each emitted { counter, caseId } to the host as the correlation ground
// truth (screenshot reads the on-screen digits; host logs the posted series; the two are correlated to seal).
// Absent element => this block is inert, so the normal benchmark viewer is byte-for-byte unchanged.
const mprHost = document.getElementById('lba-mpr-counter');
if (mprHost) {
  const mprCounter = createCounter(0);
  setInterval(() => {
    setCase(mprCounter, mprHost.dataset.case || null);
    const value = tick(mprCounter);
    mprHost.innerHTML = counterSvg(value, { minDigits: 6, cellPx: 6 });
    if (vscode) {
      vscode.postMessage({ type: 'mpr-counter', counter: value, caseId: mprCounter.caseId });
    }
  }, 100);
}
