import * as vscode from 'vscode';
import { execFile, spawn, spawnSync, ChildProcess } from 'node:child_process';
import { readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, existsSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

import { registerBenchmarkActorMcpServerProvider } from './mcp/benchmarkActorMcpServerProvider';

const execFileAsync = promisify(execFile);

// The labview-benchmark-actor extension packages the standalone agentic infrastructure (LBA-REQ-001): it
// surfaces the cross-plane coordination bus (`lbabus`) inside the VS Code host so an operator can observe
// host capabilities, poll the coordination bus, and post a coordination note from the IDE. The extension
// depends only on `vscode` + Node built-ins -- no external prototype-private module on its graph.

const CLI = 'lbabus';

function getOutput(context: vscode.ExtensionContext): vscode.OutputChannel {
  const channel = vscode.window.createOutputChannel('LabVIEW Benchmark Actor');
  context.subscriptions.push(channel);
  return channel;
}

async function runCli(output: vscode.OutputChannel, args: string[], timeoutMs: number): Promise<void> {
  output.appendLine(`$ ${CLI} ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync(CLI, args, { timeout: timeoutMs });
    if (stderr.trim().length > 0) {
      output.appendLine(stderr.trimEnd());
    }
    output.appendLine(stdout.trimEnd());
    output.show(true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`error: ${message}`);
    output.show(true);
    void vscode.window.showErrorMessage(
      `${CLI} failed: ${message}. Install the coordination CLI (see the repository INSTALL notes).`
    );
  }
}

// A per-load nonce so the webview CSP can allow exactly our scripts (no inline/eval, no remote origins).
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// The demo benchmark metric (cpu% shaped) used only when the bundled mprr series is unavailable.
const DEMO_SERIES: Array<{ t: number; v: number }> = [
  { t: 0, v: 40 },
  { t: 100, v: 44 },
  { t: 200, v: 58 },
  { t: 300, v: 63 },
  { t: 400, v: 55 },
  { t: 500, v: 71 },
  { t: 600, v: 66 },
  { t: 700, v: 48 },
];

// Load the benchmark series the viewer renders. The build (scripts/stage-media.mjs) generates
// media/mprr-series.json from the committed mprr short-packet fixture via the absorbed ring core, so the
// DEPLOYED viewer renders REAL mprr ring-buffer data. Falls back to the demo series if the bundled file is
// missing/unreadable (e.g. a bare test harness), so the viewer always has a valid series.
function loadSeries(extensionUri: vscode.Uri): Array<{ t: number; v: number }> {
  try {
    const path = vscode.Uri.joinPath(extensionUri, 'media', 'mprr-series.json').fsPath;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((s) => s && typeof s.t === 'number' && typeof s.v === 'number')
    ) {
      return parsed;
    }
  } catch {
    /* fall back to the demo series */
  }
  return DEMO_SERIES;
}

// Build the LBA-REQ-004 benchmark-viewer webview HTML: a strict CSP (default-src 'none'; scripts only via the
// nonce + the webview resource origin), a non-executed JSON series data block, and the media/viewer.js module
// (which imports the shipped, unit-tested media/viewerCursor.mjs and renders the draggable time cursor).
function viewerHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const viewerJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.js'));
  const cspSource = webview.cspSource;
  // The deployed viewer renders the real mprr ring-buffer series (build-generated); demo is the fallback.
  const series = loadSeries(extensionUri);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Benchmark Viewer</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  #chart { width: 100%; height: auto; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  #readout { margin-top: 8px; font-family: var(--vscode-editor-font-family, monospace); }
  .hint { opacity: 0.7; font-size: 0.9em; margin-top: 4px; }
</style>
</head>
<body>
  <h3>Benchmark run viewer <span class="hint">(LBA-REQ-004)</span></h3>
  <svg id="chart" viewBox="0 0 800 240" role="img" aria-label="benchmark metric over time with a draggable time cursor"></svg>
  <div id="readout" aria-live="polite"></div>
  <div class="hint">Drag on the chart or use Left/Right arrows and Home/End to move the time cursor.</div>
  <script type="application/json" id="lba-series" nonce="${nonce}">${JSON.stringify(series)}</script>
  <script type="module" nonce="${nonce}" src="${viewerJs}"></script>
</body>
</html>`;
}

// --- Real benchmark UI surfaces (single run / trend / frame correlator) -------------------------------------
// The extension ships the REAL committed LabVIEW launch record + 5-run trend (staged into media/ by
// scripts/stage-media.mjs) and renders them with the PURE, gated builders (media/benchmark-panels.mjs). The
// builders are ESM; tsc emits CommonJS, which downlevels a literal `import()` to `require()` (cannot load
// ESM). This indirection keeps a GENUINE dynamic import so the host loads the staged, self-contained ESM
// builder modules natively -- single-source with the local gates.
const importEsm: (specifier: string) => Promise<Record<string, unknown>> = new Function(
  's',
  'return import(s);'
) as (specifier: string) => Promise<Record<string, unknown>>;

interface PanelBuilders {
  buildBenchmarkPanelHtml(record: unknown, nonce: string): string;
  buildTrendPanelHtml(trend: unknown, nonce: string): string;
  buildCrossPlaneTrendPanelHtml(receipt: unknown, winTrend: unknown, linuxTrend: unknown, nonce: string): string;
  buildResourcePanelHtml(rc: unknown, nonce: string): string;
  buildCrossPlaneResourcePanelHtml(receipt: unknown, nonce: string): string;
}

let panelBuildersPromise: Promise<PanelBuilders> | undefined;

function mediaEsmUrl(extensionUri: vscode.Uri, file: string): string {
  return pathToFileURL(vscode.Uri.joinPath(extensionUri, 'media', file).fsPath).href;
}
function loadPanelBuilders(extensionUri: vscode.Uri): Promise<PanelBuilders> {
  if (!panelBuildersPromise) {
    panelBuildersPromise = importEsm(mediaEsmUrl(extensionUri, 'benchmark-panels.mjs')) as unknown as Promise<PanelBuilders>;
  }
  return panelBuildersPromise;
}
function loadBenchmarkJson(extensionUri: vscode.Uri, file: string): Record<string, unknown> {
  const path = vscode.Uri.joinPath(extensionUri, 'media', file).fsPath;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

// The mesh-stress calibration ANALYSIS VIEW builder (overview.md §3.6 / VW-1, LBA-REQ-032): a self-contained,
// script-free ESM module staged to media/, loaded natively like the other pure builders.
interface MeshViewBuilder {
  buildMeshCalibrationHtml(receipt: unknown, opts: { cspSource: string }): string;
}
let meshViewBuilderPromise: Promise<MeshViewBuilder> | undefined;
function loadMeshViewBuilder(extensionUri: vscode.Uri): Promise<MeshViewBuilder> {
  if (!meshViewBuilderPromise) {
    meshViewBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'meshCalibrationView.mjs')) as unknown as Promise<MeshViewBuilder>;
  }
  return meshViewBuilderPromise;
}

// The concurrent mesh BOARD builder (overview.md §3.6 / VW-1, LBA-REQ-032): a self-contained, script-free ESM
// module that renders a concurrent-actors receipt as a live mesh snapshot (one tile per simultaneous actor).
interface MeshBoardBuilder {
  buildMeshBoardHtml(receipt: unknown, opts: { cspSource: string }): string;
}
let meshBoardBuilderPromise: Promise<MeshBoardBuilder> | undefined;
function loadMeshBoardBuilder(extensionUri: vscode.Uri): Promise<MeshBoardBuilder> {
  if (!meshBoardBuilderPromise) {
    meshBoardBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'meshBoardView.mjs')) as unknown as Promise<MeshBoardBuilder>;
  }
  return meshBoardBuilderPromise;
}

function makeBenchmarkPanel(
  context: vscode.ExtensionContext,
  id: string,
  title: string,
  enableScripts: boolean
): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(id, title, vscode.ViewColumn.Active, {
    enableScripts,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
}

function reportUiError(output: vscode.OutputChannel, label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  output.appendLine(`${label}: error: ${message}`);
  output.show(true);
  void vscode.window.showErrorMessage(`${label} failed: ${message}`);
}

async function openBenchmarkRunCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const panels = await loadPanelBuilders(context.extensionUri);
    const record = loadBenchmarkJson(context.extensionUri, 'labview-launch-record.json');
    const panel = makeBenchmarkPanel(context, 'lbaBenchmarkRun', 'Benchmark Run', false);
    panel.webview.html = panels.buildBenchmarkPanelHtml(record, getNonce());
  } catch (err) {
    reportUiError(output, 'Open Benchmark Run', err);
  }
}

async function openBenchmarkTrendCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const panels = await loadPanelBuilders(context.extensionUri);
    const trend = loadBenchmarkJson(context.extensionUri, 'labview-launch-trend.json');
    const panel = makeBenchmarkPanel(context, 'lbaBenchmarkTrend', 'Benchmark Trend', false);
    panel.webview.html = panels.buildTrendPanelHtml(trend, getNonce());
  } catch (err) {
    reportUiError(output, 'Open Benchmark Trend', err);
  }
}

async function openCrossPlaneTrendCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const panels = await loadPanelBuilders(context.extensionUri);
    const receipt = loadBenchmarkJson(context.extensionUri, 'cross-plane-trend-receipt.json');
    const winTrend = loadBenchmarkJson(context.extensionUri, 'labview-launch-trend-win.json');
    const linuxTrend = loadBenchmarkJson(context.extensionUri, 'labview-launch-trend.json');
    const panel = makeBenchmarkPanel(context, 'lbaCrossPlaneTrend', 'Cross-Plane Benchmark Trend', false);
    panel.webview.html = panels.buildCrossPlaneTrendPanelHtml(receipt, winTrend, linuxTrend, getNonce());
  } catch (err) {
    reportUiError(output, 'Open Cross-Plane Trend', err);
  }
}

async function openResourceProfileCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const panels = await loadPanelBuilders(context.extensionUri);
    const rc = loadBenchmarkJson(context.extensionUri, 'labview-launch-resource-correlation.json');
    const panel = makeBenchmarkPanel(context, 'lbaResourceProfile', 'Benchmark Resource Profile', false);
    panel.webview.html = panels.buildResourcePanelHtml(rc, getNonce());
  } catch (err) {
    reportUiError(output, 'Open Resource Profile', err);
  }
}

async function openCrossPlaneResourceCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const panels = await loadPanelBuilders(context.extensionUri);
    const receipt = loadBenchmarkJson(context.extensionUri, 'resource-cross-plane-receipt.json');
    const panel = makeBenchmarkPanel(context, 'lbaCrossPlaneResource', 'Cross-Plane Resource Agreement', false);
    panel.webview.html = panels.buildCrossPlaneResourcePanelHtml(receipt, getNonce());
  } catch (err) {
    reportUiError(output, 'Open Cross-Plane Resource Profile', err);
  }
}

// The mesh-stress calibration ANALYSIS VIEW panel (overview.md §3.6 / VW-1, LBA-REQ-032): renders the staged
// live-ladder receipt with the script-free mesh view builder. Feeds the panel's own cspSource so the
// (image-free) CSP is host-correct.
async function openMeshCalibrationCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const view = await loadMeshViewBuilder(context.extensionUri);
    const receipt = loadBenchmarkJson(context.extensionUri, 'mesh-live-ladder-receipt.json');
    const panel = makeBenchmarkPanel(context, 'lbaMeshCalibration', 'Mesh-Stress Calibration', false);
    panel.webview.html = view.buildMeshCalibrationHtml(receipt, { cspSource: panel.webview.cspSource });
  } catch (err) {
    reportUiError(output, 'Open Mesh-Stress Calibration', err);
  }
}

// The concurrent mesh BOARD panel (overview.md §3.6 / VW-1, LBA-REQ-032): renders the staged concurrent-actors
// receipt with the script-free board builder -- a live snapshot of which actor is stressed and how much.
async function openMeshBoardCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const view = await loadMeshBoardBuilder(context.extensionUri);
    const receipt = loadBenchmarkJson(context.extensionUri, 'mesh-concurrent-actors-receipt.json');
    const panel = makeBenchmarkPanel(context, 'lbaMeshBoard', 'Concurrent Mesh Board', false);
    panel.webview.html = view.buildMeshBoardHtml(receipt, { cspSource: panel.webview.cspSource });
  } catch (err) {
    reportUiError(output, 'Open Concurrent Mesh Board', err);
  }
}

// --- Language Model Tools (Copilot agent mode) --------------------------------------------------------------
// So a Copilot AGENT can DRIVE the extension from a prompt (open a benchmark panel; summarize the captured
// numbers). The tools reuse the SAME panel command handlers + staged fixtures the human UI uses. Guarded: a
// no-op on hosts predating the stable LanguageModelTool API (VS Code 1.101+), exactly like the MCP provider.
type LmToolInvoke = (options: { input?: Record<string, unknown> }, token: unknown) => Promise<unknown>;
interface LmApi {
  registerTool?(name: string, tool: { invoke: LmToolInvoke }): vscode.Disposable;
}

// Build a LanguageModelToolResult when the API classes exist; fall back to a plain shape otherwise.
function lmTextResult(text: string): unknown {
  const g = vscode as unknown as {
    LanguageModelToolResult?: new (parts: unknown[]) => unknown;
    LanguageModelTextPart?: new (t: string) => unknown;
  };
  if (g.LanguageModelToolResult && g.LanguageModelTextPart) {
    return new g.LanguageModelToolResult([new g.LanguageModelTextPart(text)]);
  }
  return { content: [{ type: 'text', value: text }] };
}

type PanelOpener = (context: vscode.ExtensionContext, output: vscode.OutputChannel) => Promise<void>;
const BENCHMARK_PANEL_OPENERS: Record<string, { title: string; open: PanelOpener }> = {
  run: { title: 'Benchmark Run', open: openBenchmarkRunCommand },
  trend: { title: 'Benchmark Trend', open: openBenchmarkTrendCommand },
  frameCorrelator: { title: 'Benchmark Frame Correlator', open: openFrameCorrelatorCommand },
  crossPlaneTrend: { title: 'Cross-Plane Benchmark Trend', open: openCrossPlaneTrendCommand },
  resourceProfile: { title: 'Benchmark Resource Profile', open: openResourceProfileCommand },
  crossPlaneResource: { title: 'Cross-Plane Resource Agreement', open: openCrossPlaneResourceCommand },
  meshCalibration: { title: 'Mesh-Stress Calibration', open: openMeshCalibrationCommand },
  meshBoard: { title: 'Concurrent Mesh Board', open: openMeshBoardCommand },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function numOrQ(v: unknown): string {
  return typeof v === 'number' ? String(v) : '?';
}

// A plain-text summary of the extension's captured benchmark evidence, read from the staged fixtures so it is
// always the real numbers the panels render. The agent uses this to EXPLAIN the panels.
function benchmarkSummaryText(context: vscode.ExtensionContext): string {
  const lines: string[] = [
    'LabVIEW Benchmark Actor — real captured LabVIEW IDE-launch benchmark evidence (shipped in the extension):',
  ];
  const read = (f: string): Record<string, unknown> | null => {
    try {
      return loadBenchmarkJson(context.extensionUri, f);
    } catch {
      return null;
    }
  };
  const rec = read('labview-launch-record.json');
  if (rec) {
    const span = (Array.isArray(rec.spans) ? rec.spans : []).map(asRecord).find((s) => s.id === 'launchMs') ?? {};
    const frame = (Array.isArray(rec.frames) ? rec.frames : []).map(asRecord).find((f) => f.settled) ?? {};
    const detail = asRecord(rec.sourceDetail);
    lines.push(
      `• Single run: launchMs ${numOrQ(span.ms)} ms to UI-READY (settle fingerprint ${String(frame.perceptualFingerprint ?? '?')}, ${numOrQ(detail.framesCaptured)} frames captured).`
    );
  }
  const trend = read('labview-launch-trend.json');
  if (trend) {
    const stats = asRecord(trend.stats);
    lines.push(
      `• Trend (${numOrQ(trend.n)} runs): mean ${numOrQ(stats.mean)} ms, verdict ${String(trend.verdict ?? '?')} (baseline ${numOrQ(trend.baselineMs)} ms, slope ${numOrQ(trend.slopeMsPerRun)} ms/run).`
    );
  }
  const xtrend = read('cross-plane-trend-receipt.json');
  if (xtrend) {
    const w = asRecord(xtrend.witness);
    const lin = asRecord(xtrend.linux);
    const win = asRecord(xtrend.win);
    lines.push(
      `• Cross-plane launchMs: LINUX mean ${numOrQ(lin.mean)} vs WIN mean ${numOrQ(win.mean)} ms, witness Δ ${numOrQ(w.meanDeltaMs)} ms (${String(w.status ?? '?')}, faster ${String(w.faster ?? '?')}).`
    );
  }
  const rescorr = read('labview-launch-resource-correlation.json');
  if (rescorr) {
    const h = asRecord(rescorr.headline);
    lines.push(
      `• Resource correlation (live, pre=launching → post=settled): RAM Δ ${numOrQ(h.ramDeltaMean)} MB, CPU Δ ${numOrQ(h.cpuDeltaMean)} %, disk Δ ${numOrQ(h.diskDeltaMean)} %.`
    );
  }
  const xres = read('resource-cross-plane-receipt.json');
  if (xres) {
    const ram = asRecord(asRecord(xres.metrics).ram);
    lines.push(
      `• Cross-plane resource: RAM Δ WIN ${numOrQ(asRecord(ram.win).deltaMean)} vs LINUX ${numOrQ(asRecord(ram.linux).deltaMean)} MB, |Δ| ${numOrQ(ram.agreementDelta)} (${String(ram.status ?? '?')} — a substrate-independent signal).`
    );
  }
  lines.push(
    'Open a panel to see these visually — call lba-open-benchmark-panel with panel = run | trend | frameCorrelator | crossPlaneTrend | resourceProfile | crossPlaneResource | meshCalibration | meshBoard, or run the "LabVIEW Benchmark Actor: Open ..." commands.'
  );
  return lines.join('\n');
}

function registerBenchmarkLanguageModelTools(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  if (!lm?.registerTool) {
    return; // host predates the stable LanguageModelTool API
  }
  try {
    context.subscriptions.push(
      lm.registerTool('lba-open-benchmark-panel', {
        invoke: async (options) => {
          const panel = String(asRecord(options?.input).panel ?? 'trend');
          const entry = BENCHMARK_PANEL_OPENERS[panel] ?? BENCHMARK_PANEL_OPENERS.trend;
          await entry.open(context, output);
          return lmTextResult(
            `Opened the "${entry.title}" panel in the editor — it renders real captured LabVIEW IDE-launch benchmark evidence.`
          );
        },
      }),
      lm.registerTool('lba-benchmark-summary', {
        invoke: async () => lmTextResult(benchmarkSummaryText(context)),
      })
    );
    output.appendLine('registered language-model tools: lba-open-benchmark-panel, lba-benchmark-summary');
  } catch (err) {
    output.appendLine(`language-model tools not registered: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- LabVIEW-launch capture (VM-local, mprr dual-packet) + frame correlator ---------------------------------
// One-click "Capture LabVIEW Launch": records the screen at 12 fps (ffmpeg gdigrab -> VM-local PNG frames =
// the mprr LONG-packet payloads) + samples CPU/RAM/disk (the SHORT-packet metrics) while LabVIEW launches; the
// user clicks Stop; the frames + metrics are assembled into a launch-capture@1 record (mprr dual-packet) and
// the frame correlator opens: CPU/RAM/disk curves on top, a grab-and-drag red line, the real screenshot below.
// Everything is VM-local (LBA-REQ-009); nothing is embedded in the .vsix.

interface CaptureBuilder {
  buildLaunchCapture(input: unknown): LaunchCaptureRecord;
}
interface CorrelatorBuilder {
  buildFrameCorrelatorHtml(model: unknown, nonce: string, cspSource: string): string;
}
interface LaunchCaptureRecord {
  frameCount: number;
  frames: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

let captureBuilderPromise: Promise<CaptureBuilder> | undefined;
let correlatorBuilderPromise: Promise<CorrelatorBuilder> | undefined;
function loadCaptureBuilder(extensionUri: vscode.Uri): Promise<CaptureBuilder> {
  if (!captureBuilderPromise) {
    captureBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'launch-capture.mjs')) as unknown as Promise<CaptureBuilder>;
  }
  return captureBuilderPromise;
}
function loadCorrelatorBuilder(extensionUri: vscode.Uri): Promise<CorrelatorBuilder> {
  if (!correlatorBuilderPromise) {
    correlatorBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'frame-correlator.mjs')) as unknown as Promise<CorrelatorBuilder>;
  }
  return correlatorBuilderPromise;
}

// Handoff Beacon (LBA-REQ-055): the capture-status payload builder, staged into media/ + loaded like the others.
interface CaptureStatusBuilder {
  buildCapturingStatus(opts: unknown): unknown;
  buildCaptureStatus(record: unknown, samples: unknown, opts: unknown): unknown;
  buildFailedStatus(opts: unknown): unknown;
}
let captureStatusBuilderPromise: Promise<CaptureStatusBuilder> | undefined;
function loadCaptureStatusBuilder(extensionUri: vscode.Uri): Promise<CaptureStatusBuilder> {
  if (!captureStatusBuilderPromise) {
    captureStatusBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'captureStatus.mjs')) as unknown as Promise<CaptureStatusBuilder>;
  }
  return captureStatusBuilderPromise;
}

// Handoff Beacon agent->human request (LBA-REQ-056, ADR-0036): the request/op-done payload builders + the
// pending-request selector, staged into media/ + loaded like the capture-status builder.
interface HandoffRequestBuilder {
  buildAgentRequest(opts: unknown): { id: string; title: string; body: string; kind: string; createdAt: string | null };
  buildOpDone(opts: unknown): unknown;
  validateAgentRequest(req: unknown): { ok: boolean; errors: string[] };
  validateOpDone(done: unknown): { ok: boolean; errors: string[] };
  selectPendingRequest(requests: unknown, answeredIds: unknown): { id: string; title: string; body?: string } | null;
}
let handoffRequestBuilderPromise: Promise<HandoffRequestBuilder> | undefined;
function loadHandoffRequestBuilder(extensionUri: vscode.Uri): Promise<HandoffRequestBuilder> {
  if (!handoffRequestBuilderPromise) {
    handoffRequestBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'handoffRequest.mjs')) as unknown as Promise<HandoffRequestBuilder>;
  }
  return handoffRequestBuilderPromise;
}

/** The Handoff Beacon dirs under globalStorage: requests/ (agent asks) + done/ (human answers). */
export function handoffPaths(globalDir: string): { root: string; requestsDir: string; doneDir: string } {
  const root = path.join(globalDir, 'handoff');
  return { root, requestsDir: path.join(root, 'requests'), doneDir: path.join(root, 'done') };
}

/** Read + JSON-parse every *.json in a dir (skipping a missing dir / unreadable / partial files). */
export function readJsonDir(dir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>); } catch { /* skip partial */ }
  }
  return out;
}

/** The request ids that already have an op-done answer in done/, so an answered ask is never re-surfaced. */
export function answeredRequestIds(doneDir: string): string[] {
  return readJsonDir(doneDir)
    .map((d) => (typeof d.requestId === 'string' ? d.requestId : null))
    .filter((x): x is string => !!x);
}

// Handoff Beacon reviewer VISUAL VERDICT (LBA-REQ-057, ADR-0037): the pure, dependency-free builder the extension
// loads to build + Ed25519-SIGN the reviewer's PASS/FAIL of a release candidate IN the VM (mapping to an
// acg-human-signoff-v1 that feeds the release gate).
interface HandoffVerdictBuilder {
  buildReviewerVerdict(opts: unknown): { schema: string; verdict: string; target: Record<string, unknown>; [k: string]: unknown };
  validateReviewerVerdict(v: unknown): { ok: boolean; errors: string[] };
  signReviewerVerdict(v: unknown, opts: unknown): { schema: string; decision: string; [k: string]: unknown };
  buildVerdictBusPost(record: unknown): { type: string; task: string; ref: string | null; priority: string; reviewer: string | null; summary: string };
}
let handoffVerdictBuilderPromise: Promise<HandoffVerdictBuilder> | undefined;
function loadHandoffVerdictBuilder(extensionUri: vscode.Uri): Promise<HandoffVerdictBuilder> {
  if (!handoffVerdictBuilderPromise) {
    handoffVerdictBuilderPromise = importEsm(mediaEsmUrl(extensionUri, 'reviewerVerdict.mjs')) as unknown as Promise<HandoffVerdictBuilder>;
  }
  return handoffVerdictBuilderPromise;
}

/** The dir where the reviewer's signed verdicts are written (globalStorage/handoff/verdicts). */
export function verdictsDir(globalDir: string): string {
  return path.join(handoffPaths(globalDir).root, 'verdicts');
}

/**
 * The review TARGET (what the human is judging): read from handoff/review-target.json (written by the host
 * render-verdict.sh so it knows the candidate's commit + .vsix digest) with safe defaults from the running
 * extension version.
 */
export function readReviewTarget(
  globalDir: string,
  extVersion: string
): { component: string; version: string; commit: string | null; vsixSha256: string | null; evidence: Array<Record<string, unknown>> } {
  const dflt = { component: 'extension', version: extVersion || '0.0.0', commit: null as string | null, vsixSha256: null as string | null, evidence: [] as Array<Record<string, unknown>> };
  const p = path.join(handoffPaths(globalDir).root, 'review-target.json');
  if (!existsSync(p)) return dflt;
  try {
    const t = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return {
      component: typeof t.component === 'string' ? t.component : dflt.component,
      version: typeof t.version === 'string' ? t.version : dflt.version,
      commit: typeof t.commit === 'string' ? t.commit : null,
      vsixSha256: typeof t.vsixSha256 === 'string' ? t.vsixSha256 : null,
      evidence: Array.isArray(t.evidence) ? (t.evidence as Array<Record<string, unknown>>) : [],
    };
  } catch {
    return dflt;
  }
}

/** Build + sign a reviewer verdict via the loaded builder (pure orchestration): validate, then Ed25519-sign. */
export function buildSignedVerdict(
  builder: HandoffVerdictBuilder,
  opts: { target: unknown; verdict: string; reviewer: string; station: string; notes: string; evidence: unknown; privateKeyPem: string; renderedAt: string }
): { verdict: unknown; signOff: unknown } {
  const verdict = builder.buildReviewerVerdict({ target: opts.target, verdict: opts.verdict, reviewer: opts.reviewer, station: opts.station, notes: opts.notes, evidence: opts.evidence, renderedAt: opts.renderedAt });
  const check = builder.validateReviewerVerdict(verdict);
  if (!check.ok) throw new Error(`invalid reviewer verdict: ${check.errors.join('; ')}`);
  const signOff = builder.signReviewerVerdict(verdict, { privateKeyPem: opts.privateKeyPem, reviewer: opts.reviewer, station: opts.station });
  return { verdict, signOff };
}

/** Build the `lbabus net send` argv for a verdict announcement over TCP (pure, LBA-REQ-066/ADR-0046, net-only):
 *  the semantic type + release task + the FULL signed verdict JSON (--message-file). The net envelope has no
 *  priority/ref fields (those live inside the verdict JSON); host(s) are the configured peer(s), else a graceful
 *  no-op via --skip-if-no-peer. */
export function busSendArgs(post: { type: string; task: string }, verdictFile: string, netHosts: string): string[] {
  const args = ['net', 'send'];
  if (netHosts) { args.push('--hosts', netHosts); } else { args.push('--skip-if-no-peer'); }
  args.push('--type', post.type, '--task', post.task, '--message-file', verdictFile);
  return args;
}

/** The live-only `lbabus net` TCP coordination bus config (LBA-REQ-066, ADR-0046, net-only): the peer host(s)
 *  that `net send` targets (else a graceful no-op) + the local receive-log written by `lbabus net listen --log`
 *  that `net poll` reads. The GitHub-Discussion transport opt-out was removed off-Discussions step 7. */
function busConfig(): { netHosts: string; netLog: string } {
  const c = vscode.workspace.getConfiguration('labviewBenchmarkActor');
  return {
    netHosts: (c.get<string>('busNetHosts', '') || '').trim(),
    netLog: (c.get<string>('busNetLog', '') || '').trim(),
  };
}

/** Parse a capture's resources.jsonl into the raw sample array (skipping blank/partial lines). */
export function readResourceSamples(dir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const resFile = path.join(dir, 'resources.jsonl');
  if (!existsSync(resFile)) return out;
  for (const line of readFileSync(resFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as Record<string, unknown>); } catch { /* skip partial */ }
  }
  return out;
}

/** Best-effort write of the handoff capture-status beacon (never throws into the capture flow). Returns the
 *  built beacon so the caller can act on it (e.g. auto-jump the correlator to the peak-write frame). */
async function writeCaptureStatusBeacon(
  extensionUri: vscode.Uri,
  dir: string,
  build: (b: CaptureStatusBuilder) => unknown,
  output: vscode.OutputChannel
): Promise<unknown> {
  try {
    const builder = await loadCaptureStatusBuilder(extensionUri);
    const status = build(builder);
    writeFileSync(path.join(dir, 'capture-status.json'), `${JSON.stringify(status, null, 2)}\n`);
    return status;
  } catch (err) {
    output.appendLine(`capture-status beacon skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// --- Handoff Beacon agent->human request barrier (LBA-REQ-056, ADR-0036) -------------------------------------
// The agent drops an agent-request@1 beacon in handoff/requests/; the extension watches that dir and surfaces the
// newest unanswered ask as a VS Code notification with 'Mark step done' / 'Skip' actions (also palette commands).
// The human's answer is an op-done@1 beacon written into handoff/done/<id>.json that the agent awaits -- a reusable
// human-step barrier for any manual op (activate LabVIEW, run a VI, VIPM login, ...).
let activeHandoffRequest: { id: string; title: string; body?: string } | undefined;
let lastNotifiedRequestId: string | undefined;

async function writeOpDoneBeacon(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  outcome: 'done' | 'skipped',
  note: string | null
): Promise<void> {
  const request = activeHandoffRequest;
  if (!request) {
    vscode.window.showInformationMessage('No pending handoff request to answer.');
    return;
  }
  try {
    const { doneDir } = handoffPaths(context.globalStorageUri.fsPath);
    mkdirSync(doneDir, { recursive: true });
    const builder = await loadHandoffRequestBuilder(context.extensionUri);
    const done = builder.buildOpDone({ requestId: request.id, outcome, note, doneAt: new Date().toISOString() });
    writeFileSync(path.join(doneDir, `${request.id}.json`), `${JSON.stringify(done, null, 2)}\n`);
    output.appendLine(`handoff ${outcome}: ${request.id}${note ? ` (${note})` : ''}`);
    vscode.window.showInformationMessage(`Handoff step ${outcome}: ${request.title}`);
    activeHandoffRequest = undefined;
  } catch (err) {
    reportUiError(output, 'Answer handoff request', err);
  }
}

async function markStepDoneCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (!activeHandoffRequest) {
    vscode.window.showInformationMessage('No pending handoff request to mark done.');
    return;
  }
  const note = await vscode.window.showInputBox({
    prompt: `Optional note for the handoff step: ${activeHandoffRequest.title}`,
    placeHolder: '(optional) what you did / observed',
  });
  // showInputBox returns undefined when dismissed -> still mark done (the note is optional).
  await writeOpDoneBeacon(context, output, 'done', note && note.length ? note : null);
}

async function skipStepCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  await writeOpDoneBeacon(context, output, 'skipped', null);
}

export async function refreshHandoffRequests(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  try {
    const { requestsDir, doneDir } = handoffPaths(context.globalStorageUri.fsPath);
    const builder = await loadHandoffRequestBuilder(context.extensionUri);
    const pending = builder.selectPendingRequest(readJsonDir(requestsDir), answeredRequestIds(doneDir));
    if (!pending) {
      activeHandoffRequest = undefined;
      return;
    }
    activeHandoffRequest = pending;
    if (pending.id === lastNotifiedRequestId) {
      return; // already surfaced this ask (avoid duplicate toasts on repeated fs events)
    }
    lastNotifiedRequestId = pending.id;
    const detail = pending.body ? `${pending.title} \u2014 ${pending.body}` : pending.title;
    output.appendLine(`handoff request ${pending.id}: ${detail}`);
    const choice = await vscode.window.showInformationMessage(`Agent request: ${detail}`, 'Mark step done', 'Skip');
    if (choice === 'Mark step done') {
      await markStepDoneCommand(context, output);
    } else if (choice === 'Skip') {
      await skipStepCommand(context, output);
    }
  } catch (err) {
    output.appendLine(`handoff request refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startHandoffWatcher(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const globalDir = context.globalStorageUri?.fsPath;
  if (!globalDir) {
    return; // no globalStorage (e.g. a minimal host/test context) -> nothing to watch
  }
  const { requestsDir, doneDir } = handoffPaths(globalDir);
  try {
    mkdirSync(requestsDir, { recursive: true });
    mkdirSync(doneDir, { recursive: true });
  } catch { /* best-effort: the dirs are also created on demand when answering */ }
  void refreshHandoffRequests(context, output); // surface any ask already waiting at startup
  try {
    const watcher = watch(requestsDir, () => { void refreshHandoffRequests(context, output); });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (err) {
    output.appendLine(`handoff watcher not started: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Handoff Beacon reviewer VISUAL VERDICT command (LBA-REQ-057, ADR-0037): the human renders their PASS/FAIL of
// the release candidate IN the VM; the extension Ed25519-SIGNS it with the enrolled reviewer key and writes the
// signed verdict (an acg-human-signoff-v1 over the reviewer-verdict@1) into handoff/verdicts/ for the release
// gate + a CI keyless counter-sign.
async function renderReviewerVerdictCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('labviewBenchmarkActor');
  const reviewer = String(cfg.get<string>('reviewerId', '') || '').trim();
  const keyPath = String(cfg.get<string>('reviewerKeyPath', '') || '').trim();
  if (!reviewer || !keyPath) {
    vscode.window.showWarningMessage('Set labviewBenchmarkActor.reviewerId and labviewBenchmarkActor.reviewerKeyPath (the enrolled reviewer key) to render a signed verdict.');
    return;
  }
  if (!existsSync(keyPath)) {
    vscode.window.showErrorMessage(`Reviewer key not found at ${keyPath}.`);
    return;
  }
  const globalDir = context.globalStorageUri?.fsPath;
  if (!globalDir) {
    return;
  }
  const extVersion = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0');
  const target = readReviewTarget(globalDir, extVersion);
  const choice = await vscode.window.showInformationMessage(`Reviewer visual verdict for ${target.component} ${target.version}?`, 'Pass', 'Request changes', 'Fail');
  if (!choice) {
    return;
  }
  const verdict = choice === 'Pass' ? 'pass' : choice === 'Fail' ? 'fail' : 'changes';
  const notes = await vscode.window.showInputBox({ prompt: `Notes for the ${verdict.toUpperCase()} verdict on ${target.component} ${target.version}`, placeHolder: 'what you saw / why' });
  try {
    const builder = await loadHandoffVerdictBuilder(context.extensionUri);
    const privateKeyPem = readFileSync(keyPath, 'utf8');
    const record = buildSignedVerdict(builder, { target, verdict, reviewer, station: 'WINDOWS_VM', notes: notes || '', evidence: target.evidence, privateKeyPem, renderedAt: new Date().toISOString() });
    const dir = verdictsDir(globalDir);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${target.component}-${target.version}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    output.appendLine(`reviewer verdict ${verdict} signed for ${target.component} ${target.version} by ${reviewer}`);
    vscode.window.showInformationMessage(`Reviewer verdict signed: ${verdict.toUpperCase()} for ${target.component} ${target.version}.`);
    // Announce the signed verdict on the coordination bus (best-effort; a missing lbabus / token never fails signing).
    await postVerdictToBus(context, output, builder, record, file);
  } catch (err) {
    reportUiError(output, 'Render reviewer verdict', err);
  }
}

// Announce a signed reviewer verdict on the lbabus coordination bus (LBA-REQ-058, ADR-0038): a semantic post
// (PASS->RESOLVED / CHANGES->REFINE / FAIL->BLOCKED) carrying the FULL signed verdict JSON, so remote actors see
// the human's PASS/FAIL. Best-effort -- a missing `lbabus` / GH token is logged, never thrown into the signing.
async function postVerdictToBus(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  builder: HandoffVerdictBuilder,
  record: unknown,
  verdictFile: string
): Promise<void> {
  try {
    const post = builder.buildVerdictBusPost(record);
    const { netHosts } = busConfig();
    const args = busSendArgs(post, verdictFile, netHosts);
    output.appendLine(`$ ${CLI} ${args.join(' ')}`);
    try {
      const { stdout, stderr } = await execFileAsync(CLI, args, { timeout: 30000 });
      if (stderr.trim().length > 0) output.appendLine(stderr.trimEnd());
      if (stdout.trim().length > 0) output.appendLine(stdout.trimEnd());
      output.appendLine(`posted reviewer verdict to the coordination bus: ${post.summary}`);
    } catch (err) {
      output.appendLine(`bus post skipped (${CLI} unavailable?): ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    output.appendLine(`bus post skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The peak-write frame index a capture-status beacon points at (0 when absent/invalid) -- the frame the
 *  correlator opens at so the human + agent land on the evidence instead of scrubbing (LBA-REQ-055). */
export function peakFrameIndexOf(status: unknown): number {
  const peak = (status as { peak?: { frameIndex?: unknown } } | undefined)?.peak;
  const idx = peak ? peak.frameIndex : undefined;
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : 0;
}

/** Read the peak-write frame index from a capture's capture-status beacon on disk (0 if absent/unreadable). */
export function readPeakFrameIndex(dir: string): number {
  const statusPath = path.join(dir, 'capture-status.json');
  if (!existsSync(statusPath)) return 0;
  try { return peakFrameIndexOf(JSON.parse(readFileSync(statusPath, 'utf8'))); } catch { return 0; }
}

/** Clamp a desired frame index into [0, count) (0 when out of range) -- keeps the correlator auto-jump safe. */
export function clampFrameIndex(index: number, count: number): number {
  return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
}

/** Build the frame-correlator webview model (pure): clamps the initial/auto-jump index + carries markers/disks. */
export function buildCorrelatorModel(
  framesModel: unknown[],
  initialIndex: number,
  markers: unknown,
  diskNames: unknown
): { title: string; fps: number; selectedIndex: number; frames: unknown[]; markers: unknown[]; diskNames: unknown } {
  const frames = Array.isArray(framesModel) ? framesModel : [];
  const existingMarkers = Array.isArray(markers) ? markers : [];
  const selectedIndex = clampFrameIndex(initialIndex, frames.length);
  return { title: 'LabVIEW launch \u2014 frame correlator', fps: 12, selectedIndex, frames, markers: existingMarkers, diskNames };
}

/** Map one capture frame + its (webview) image src into the correlator's per-frame model (pure). */
export function buildCorrelatorFrame(f: Record<string, unknown>, imageSrc: string): Record<string, unknown> {
  return {
    index: f.index,
    tMs: f.tMs,
    cpuPct: f.cpuPct,
    ramMb: f.ramMb,
    diskPct: f.diskPct,
    // per-physical-disk read/write throughput (MB/s) when the sampler captured it (write + read curve per disk).
    disks: f.disks,
    // v2: the frame's performance-counter catalog when the capture carries it (else CPU/RAM/disk fallback).
    counters: f.counters,
    imageSrc,
  };
}

interface ActiveCapture {
  dir: string;
  ffmpeg: ChildProcess;
  sampler: ChildProcess;
  status: vscode.StatusBarItem;
  startedAt: string;
}
let activeCapture: ActiveCapture | undefined;

function captureCfg<T>(key: string, dflt: T): T {
  return vscode.workspace.getConfiguration('labviewBenchmarkActor').get<T>(key, dflt);
}
function capturesRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'captures');
}
function resolveLabview(): string | null {
  const configured = captureCfg<string>('labviewPath', '').trim();
  // Validate a configured labviewPath actually exists (mirrors resolveFfmpegChecked's runnable check): a bogus
  // path would otherwise pass the guard and start a doomed capture (ffmpeg + sampler) that can never launch LabVIEW.
  if (configured) return existsSync(configured) ? configured : null;
  const candidates = [
    'C:\\Program Files (x86)\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
    'C:\\Program Files\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
  ];
  return candidates.find((c) => existsSync(c)) || null;
}

// ffmpeg resolution + a runnability probe: explicit ffmpegPath setting -> the VM-local copy install-lba.cmd stages
// under %LOCALAPPDATA%\lba -> `ffmpeg` on PATH. resolveFfmpegChecked returns null when NONE is a spawnable binary,
// so the capture fails FAST with an actionable prompt instead of a raw `spawn ffmpeg ENOENT` mid-run (the v1.0.0
// Marketplace complaint: a fresh install has no ffmpeg on PATH).
export function ffmpegRunnable(cmd: string): boolean {
  try {
    // `-version` is a fast, side-effect-free probe. We only care that the binary SPAWNS (no ENOENT): a present
    // ffmpeg exits 0, and even a mismatched build still spawns. spawnSync sets `.error` (does not throw) on ENOENT.
    return !spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 5000 }).error;
  } catch {
    return false;
  }
}

export function resolveFfmpegChecked(): string | null {
  const configured = captureCfg<string>('ffmpegPath', '').trim();
  if (configured) return ffmpegRunnable(configured) ? configured : null;
  const localAppData = process.env.LOCALAPPDATA;
  const staged = localAppData ? path.join(localAppData, 'lba', 'ffmpeg.exe') : '';
  if (staged && existsSync(staged)) return staged;
  if (ffmpegRunnable('ffmpeg')) return 'ffmpeg';
  // A winget-installed ffmpeg (the "Install ffmpeg (winget)" button installs Gyan.FFmpeg) symlinks ffmpeg.exe into
  // %LOCALAPPDATA%\Microsoft\WinGet\Links and adds that dir to the USER PATH -- but this extension-host process
  // still holds the PRE-install PATH (VS Code's "Reload Window" does NOT refresh the process environment), so the
  // `ffmpeg`-on-PATH probe above misses it right after installing (issue #405). Check the stable winget Links
  // location directly so the capture works without a full VS Code restart.
  if (localAppData) {
    const wingetLink = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (existsSync(wingetLink) && ffmpegRunnable(wingetLink)) return wingetLink;
  }
  return null;
}

// When ffmpeg is missing, GUIDE the user (one-click winget, manual download, or point at an existing ffmpeg.exe)
// instead of failing the capture with a raw spawn error. gdigrab needs ffmpeg present; the Marketplace build does
// not bundle it (that would add ~70MB + ffmpeg's GPL/LGPL licensing to the listing).
async function promptInstallFfmpeg(output: vscode.OutputChannel): Promise<void> {
  const INSTALL = 'Install ffmpeg (winget)';
  const DOWNLOAD = 'Download ffmpeg\u2026';
  const SET_PATH = 'Set ffmpeg path\u2026';
  const choice = await vscode.window.showErrorMessage(
    'ffmpeg is required to capture a LabVIEW launch but was not found on this machine. Install it (one click via winget), download it, or point the extension at an existing ffmpeg.exe.',
    { modal: true },
    INSTALL,
    DOWNLOAD,
    SET_PATH
  );
  if (choice === INSTALL) {
    const term = vscode.window.createTerminal('Install ffmpeg');
    term.show(true);
    term.sendText('winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements');
    void vscode.window.showInformationMessage(
      'Installing ffmpeg via winget in the terminal. When it finishes, just run the capture again \u2014 the extension detects the freshly installed ffmpeg (from %LOCALAPPDATA%\\Microsoft\\WinGet\\Links), so no VS Code restart is needed.'
    );
  } else if (choice === DOWNLOAD) {
    void vscode.env.openExternal(vscode.Uri.parse('https://www.gyan.dev/ffmpeg/builds/'));
  } else if (choice === SET_PATH) {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'labviewBenchmarkActor.ffmpegPath');
  }
  output.appendLine('capture aborted: ffmpeg not found (prompted winget install / download / set-path).');
}

// PowerShell sampler: fast System.Diagnostics.PerformanceCounter reads (NextValue() is sub-ms, unlike the old
// ~0.8 s CIM loop) frame-locked to ~100 ms. Emits CPU %, used RAM MB, disk % busy (kept for back-compat) AND
// per-PHYSICAL-DISK write/read THROUGHPUT in MB/s (decimal, bytes/1e6) for every physical disk. A modest
// sustained write (e.g. ~11 MB/s) registers on the throughput curve even though % Disk Time barely moves.
export function samplerScript(outFile: string): string {
  const out = outFile.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$out='${out}'`,
    'function NewPC($cat,$ctr,$inst){ try { if ($inst) { New-Object System.Diagnostics.PerformanceCounter $cat,$ctr,$inst } else { New-Object System.Diagnostics.PerformanceCounter $cat,$ctr } } catch { $null } }',
    '$totalMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1024,0)',
    "$cpu=NewPC 'Processor' '% Processor Time' '_Total'",
    "$avail=NewPC 'Memory' 'Available MBytes' $null",
    "$dt=NewPC 'PhysicalDisk' '% Disk Time' '_Total'",
    "$insts=@()",
    "try { $insts=@((New-Object System.Diagnostics.PerformanceCounterCategory 'PhysicalDisk').GetInstanceNames() | Where-Object { $_ -ne '_Total' } | Sort-Object) } catch {}",
    '$wc=@{}; $rc=@{}',
    "foreach($i in $insts){ $wc[$i]=NewPC 'PhysicalDisk' 'Disk Write Bytes/sec' $i; $rc[$i]=NewPC 'PhysicalDisk' 'Disk Read Bytes/sec' $i }",
    'foreach($x in @($cpu,$dt)+$wc.Values+$rc.Values){ if($x){ try{ [void]$x.NextValue() }catch{} } }',
    'while ($true) {',
    '  $t0=[DateTimeOffset]::UtcNow',
    '  $c=if($cpu){[math]::Round($cpu.NextValue(),1)}else{0}',
    '  $am=if($avail){$avail.NextValue()}else{0}',
    '  $r=[math]::Round($totalMb-$am,1)',
    '  $d=if($dt){[math]::Round($dt.NextValue(),1)}else{0}',
    '  $ds=@()',
    '  foreach($i in $insts){',
    '    $w=if($wc[$i]){[math]::Round($wc[$i].NextValue()/1000000,3)}else{0}',
    '    $rd=if($rc[$i]){[math]::Round($rc[$i].NextValue()/1000000,3)}else{0}',
    '    $nm=$i.Replace(\'"\',\'\')',
    '    $ds+=("{""name"":"""+$nm+""",""writeMBs"":"+$w+",""readMBs"":"+$rd+"}")',
    '  }',
    '  $ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  Add-Content -Path $out -Value ("{""ms"":"+$ms+",""cpuPct"":"+$c+",""ramMb"":"+$r+",""diskPct"":"+$d+",""disks"":["+($ds -join ",")+"]}")',
    '  $el=([DateTimeOffset]::UtcNow-$t0).TotalMilliseconds',
    '  $sl=100-$el; if($sl -gt 0){ Start-Sleep -Milliseconds ([int]$sl) }',
    '}',
  ].join('\n');
}

// Cross-platform mprr capture: run the mprr visual-ring launch-trend runner against a target VBox VM (SSH-trigger
// xinit labview64 + capture over VBox-VNC), producing a real workload-trend@1. Unlike captureLaunchCommand (Windows
// gdigrab of the host desktop), this works on a Linux/Wayland host because it captures the VM, not the host screen.
async function captureLaunchMprrCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('mprr capture needs the labview-benchmark-actor repo open as a workspace folder.');
    return;
  }
  const runner = path.join(root, 'experiments', 'mprr-capture-ring', 'live-vbox-labview-trend.mjs');
  if (!existsSync(runner)) {
    void vscode.window.showErrorMessage(`mprr runner not found at ${runner}`);
    return;
  }
  const sshPort = captureCfg<string>('mprrSshPort', '2223').trim() || '2223';
  const vncPort = captureCfg<string>('mprrVncPort', '5900').trim() || '5900';
  const vncPassword = captureCfg<string>('mprrVncPassword', '').trim();
  const iterations = captureCfg<number>('mprrIterations', 5);
  const targetVm = captureCfg<string>('mprrTargetVm', '').trim();
  const dir = path.join(capturesRoot(context), `mprr-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    reportUiError(output, 'Capture LabVIEW Launch (mprr)', err);
    return;
  }
  const outTrend = path.join(dir, 'trend.json');
  const env = {
    ...process.env,
    LBA_SSH_PORT: sshPort,
    LBA_VNC_PORT: vncPort,
    LBA_VNC_PASSWORD: vncPassword,
    LBA_ITERATIONS: String(iterations),
    LBA_OUT: outTrend,
  };
  output.show(true);
  output.appendLine(`[mprr] capturing ${iterations} LabVIEW launch(es) of ${targetVm || 'the target VM'} over VBox-VNC ${vncPort} (SSH ${sshPort}) -> ${outTrend}`);
  const proc = spawn('node', [runner], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (b: Buffer) => output.append(b.toString()));
  proc.stderr.on('data', (b: Buffer) => output.append(b.toString()));
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Capturing LabVIEW launch (mprr)…', cancellable: false },
    () =>
      new Promise<void>((resolve) => {
        proc.on('error', (e) => {
          void vscode.window.showErrorMessage(`mprr capture failed to start: ${e.message}`);
          resolve();
        });
        proc.on('close', (code) => {
          if (code === 0 && existsSync(outTrend)) {
            try {
              const t = JSON.parse(readFileSync(outTrend, 'utf8')) as Record<string, unknown>;
              const stats = asRecord(t.stats);
              void vscode.window
                .showInformationMessage(
                  `mprr capture: ${String(t.plane)} launchMs mean ${numOrQ(stats.mean)} ms over ${numOrQ(t.n)} runs — ${String(t.verdict)}.`,
                  'Open Trend JSON'
                )
                .then((a) => {
                  if (a) void vscode.window.showTextDocument(vscode.Uri.file(outTrend));
                });
            } catch (e) {
              output.appendLine(`[mprr] trend parse error: ${(e as Error).message}`);
            }
          } else {
            void vscode.window.showErrorMessage(`mprr capture failed (exit ${code}). See the "LabVIEW Benchmark Actor" output channel.`);
          }
          resolve();
        });
      })
  );
}

async function captureLaunchCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (activeCapture) {
    void vscode.window.showWarningMessage('A LabVIEW capture is already running. Stop it first.');
    return;
  }
  const labview = resolveLabview();
  if (!labview) {
    void vscode.window.showErrorMessage(
      'LabVIEW.exe not found. Set "labviewBenchmarkActor.labviewPath" to your LabVIEW 2026 LabVIEW.exe.'
    );
    return;
  }
  // Pre-flight ffmpeg: a fresh Marketplace install has no ffmpeg on PATH (users hit `spawn ffmpeg.exe ENOENT`).
  // Fail-fast with an actionable prompt instead of launching a doomed capture (LabVIEW + sampler + beacon).
  const ffmpeg = resolveFfmpegChecked();
  if (!ffmpeg) {
    await promptInstallFfmpeg(output);
    return;
  }
  const dir = path.join(capturesRoot(context), `run-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    reportUiError(output, 'Capture LabVIEW Launch', err);
    return;
  }
  // Handoff beacon: mark the capture in flight so the agent's poll knows one is running (LBA-REQ-055).
  const startedAt = new Date().toISOString();
  void writeCaptureStatusBeacon(context.extensionUri, dir, (b) => b.buildCapturingStatus({ runDir: dir, startedAt }), output);
  const framePattern = path.join(dir, 'frame-%05d.png');
  const resourcesFile = path.join(dir, 'resources.jsonl');

  // 1) ffmpeg screen capture at 12 fps (stdin kept open so we can 'q' it for a clean finalize on stop).
  let ffmpegProc: ChildProcess;
  try {
    ffmpegProc = spawn(
      ffmpeg,
      ['-y', '-f', 'gdigrab', '-framerate', '12', '-i', 'desktop', framePattern],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
    );
  } catch (err) {
    reportUiError(output, 'Capture LabVIEW Launch (ffmpeg)', err);
    return;
  }
  ffmpegProc.on('error', (e) => {
    output.appendLine(`ffmpeg error: ${e.message}. Set "labviewBenchmarkActor.ffmpegPath" to ffmpeg.exe.`);
    void vscode.window.showErrorMessage(
      `ffmpeg failed to start (${e.message}). Install ffmpeg or set labviewBenchmarkActor.ffmpegPath.`
    );
  });

  // 2) CPU/RAM/disk sampler.
  const sampler = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', samplerScript(resourcesFile)],
    { windowsHide: true, stdio: 'ignore' }
  );

  // 3) launch LabVIEW itself.
  try {
    spawn(labview, [], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    output.appendLine(`LabVIEW launch error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  status.text = '$(debug-stop) Stop LabVIEW Capture';
  status.tooltip = 'Stop the LabVIEW-launch capture and open the frame correlator';
  status.command = 'labviewBenchmarkActor.stopCapture';
  status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  status.show();

  activeCapture = { dir, ffmpeg: ffmpegProc, sampler, status, startedAt };
  output.appendLine(`capture started: ${dir} (ffmpeg 12fps + CPU/RAM/disk; LabVIEW launching)`);
  void vscode.window
    .showInformationMessage(
      'Capturing the LabVIEW launch at 12 fps. Click "Stop LabVIEW Capture" in the status bar when the IDE is up.',
      'Stop now'
    )
    .then((a) => {
      if (a === 'Stop now') void vscode.commands.executeCommand('labviewBenchmarkActor.stopCapture');
    });
}

async function stopCaptureCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const cap = activeCapture;
  if (!cap) {
    void vscode.window.showInformationMessage('No LabVIEW capture is running.');
    return;
  }
  activeCapture = undefined;
  cap.status.dispose();
  // Stop ffmpeg cleanly (q on stdin -> finalize the last frame), then hard-stop the sampler.
  try {
    cap.ffmpeg.stdin?.write('q\n');
  } catch {
    /* fall through to kill */
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    cap.ffmpeg.on('close', finish);
    setTimeout(() => {
      try {
        cap.ffmpeg.kill();
      } catch {
        /* ignore */
      }
      finish();
    }, 4000);
  });
  try {
    cap.sampler.kill();
  } catch {
    /* ignore */
  }

  const stoppedAt = new Date().toISOString();
  try {
    const record = await assembleCapture(context, cap.dir);
    // Handoff beacon FIRST: the rich stop status (which resolves the agent's await poll) also tells us the
    // peak-write frame, so the correlator opens THERE -- the human + agent land on the evidence, not frame 0.
    const samples = readResourceSamples(cap.dir);
    const status = await writeCaptureStatusBeacon(context.extensionUri, cap.dir, (b) => b.buildCaptureStatus(record, samples, { runDir: cap.dir, startedAt: cap.startedAt, stoppedAt }), output);
    const peakIndex = peakFrameIndexOf(status);
    await openCorrelatorForCapture(context, output, cap.dir, record, peakIndex);
    output.appendLine(`capture stopped: ${record.frameCount} frames -> correlator @ frame ${peakIndex + 1} (peak write; beacon written)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeCaptureStatusBeacon(context.extensionUri, cap.dir, (b) => b.buildFailedStatus({ runDir: cap.dir, startedAt: cap.startedAt, stoppedAt, error: message }), output);
    reportUiError(output, 'Assemble LabVIEW capture', err);
  }
}

async function assembleCapture(context: vscode.ExtensionContext, dir: string): Promise<LaunchCaptureRecord> {
  const builder = await loadCaptureBuilder(context.extensionUri);
  return assembleCaptureFromDir(dir, builder);
}

// Assemble the captured PNG frames + resource samples in `dir` into a launch-capture@1 record (mprr dual-packet)
// and write capture.json. Split out from the cleanroom-gated ffmpeg CAPTURE that PRODUCES the frames, so this
// pure file-assembly around the unit-tested builder is itself directly unit-testable with fixture frames.
export function assembleCaptureFromDir(dir: string, builder: CaptureBuilder): LaunchCaptureRecord {
  const frameFiles = readdirSync(dir)
    .filter((f) => /^frame-\d+\.png$/.test(f))
    .sort();
  if (frameFiles.length === 0) {
    throw new Error('no frames were captured (is ffmpeg installed + did the capture run long enough?)');
  }
  // Align each frame to REAL wall-clock via its PNG mtime (when ffmpeg wrote it), NOT startMs + i/fps -- that
  // removes ffmpeg's startup lag so every frame takes its true nearest CPU/RAM/disk sample. The mtime and the
  // PowerShell sampler's UnixTimeMilliseconds share the one Windows clock, so they compare directly.
  const frames = frameFiles.map((image, i) => {
    const st = statSync(path.join(dir, image));
    return { index: i, imageFile: image, imageBytes: st.size, ms: st.mtimeMs };
  });
  const firstFrameMs = frames[0].ms;
  const resourceSamples: Array<Record<string, unknown>> = [];
  const resFile = path.join(dir, 'resources.jsonl');
  if (existsSync(resFile)) {
    for (const line of readFileSync(resFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        resourceSamples.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        /* skip a partial trailing line */
      }
    }
  }
  const record = builder.buildLaunchCapture({
    frames,
    resourceSamples,
    startMs: firstFrameMs,
    fps: 12,
    meta: { workload: 'labview-launch', plane: 'WIN', source: 'ffmpeg-gdigrab' },
  });
  writeFileSync(path.join(dir, 'capture.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function openCorrelatorForCapture(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  dir: string,
  record: LaunchCaptureRecord,
  initialIndex = 0
): Promise<void> {
  const correlator = await loadCorrelatorBuilder(context.extensionUri);
  const panel = vscode.window.createWebviewPanel(
    'lbaFrameCorrelator',
    'LabVIEW Launch Frame Correlator',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(dir)] }
  );
  const framesModel = record.frames.map((f) =>
    buildCorrelatorFrame(f, panel.webview.asWebviewUri(vscode.Uri.file(path.join(dir, String(f.image)))).toString())
  );
  // Auto-jump to the beacon's peak-write frame (clamped inside buildCorrelatorModel): open on the evidence, not frame 0.
  const model = buildCorrelatorModel(framesModel, initialIndex, record.markers, record.diskNames);
  panel.webview.html = correlator.buildFrameCorrelatorHtml(model, getNonce(), panel.webview.cspSource);

  // Persist a CLICK marker into the capture metadata ("mouse click -> label in metadata"): the webview posts
  // { type:'frame-marker', marker } on each click; append it to capture.json so markers survive a reopen.
  const capturePath = path.join(dir, 'capture.json');
  panel.webview.onDidReceiveMessage(
    (msg: { type?: string; marker?: unknown } | undefined) => {
      if (!msg || msg.type !== 'frame-marker' || !msg.marker) {
        return;
      }
      try {
        const current = JSON.parse(readFileSync(capturePath, 'utf8')) as LaunchCaptureRecord;
        const markers = Array.isArray(current.markers) ? current.markers : [];
        markers.push(msg.marker);
        current.markers = markers;
        writeFileSync(capturePath, `${JSON.stringify(current, null, 2)}\n`);
        const m = msg.marker as { frameIndex?: unknown };
        output.appendLine(`persisted frame-marker @frame ${String(m.frameIndex)} (${markers.length} total) to ${capturePath}`);
      } catch (err) {
        output.appendLine(`failed to persist frame-marker: ${String(err)}`);
      }
    },
    undefined,
    context.subscriptions
  );
  output.appendLine(`correlator opened for ${dir} (${framesModel.length} frames)`);
}

// Open the frame correlator for the most recent VM-local capture (or guide the user to record one).
async function openFrameCorrelatorCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  try {
    const root = capturesRoot(context);
    const runs = existsSync(root)
      ? readdirSync(root)
          .filter((d) => existsSync(path.join(root, d, 'capture.json')))
          .sort()
      : [];
    if (runs.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        'No LabVIEW capture yet. Run "Capture LabVIEW Launch" to record one.',
        'Capture LabVIEW Launch'
      );
      if (pick === 'Capture LabVIEW Launch') {
        void vscode.commands.executeCommand('labviewBenchmarkActor.captureLaunch');
      }
      return;
    }
    const dir = path.join(root, runs[runs.length - 1]);
    const record = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8')) as LaunchCaptureRecord;
    // If a capture-status beacon is present, open on its peak-write frame too (not just on a fresh stop).
    await openCorrelatorForCapture(context, output, dir, record, readPeakFrameIndex(dir));
  } catch (err) {
    reportUiError(output, 'Open Frame Correlator', err);
  }
}

// --- Extension-embedded AGENTS.md (issue #98) --------------------------------------------------------------
// The .vsix bundles media/AGENTS.md + media/agents.manifest.json (staged from extension-agents/ by
// scripts/stage-media.mjs). These commands let a user's coding agent pick up the version-pinned instructions,
// mirroring `lbabus agents` (print / --out / --check). The manifest sha256 (over the CANONICAL body) is the
// single integrity anchor -- no header parsing for the drift check.
const AGENTS_SCHEME = 'lba-agents';

// Canonical body: LF, no trailing whitespace, single trailing newline. MUST stay byte-identical to
// scripts/agentsManifest.mjs canonicalizeAgents so the sha256 matches on every plane (Windows CRLF included).
function canonicalizeAgents(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[\s\uFEFF]*$/, '') + '\n';
}

function agentsSha256(text: string): string {
  return createHash('sha256').update(canonicalizeAgents(text), 'utf8').digest('hex');
}

interface BundledAgents {
  body: string;
  version: string;
  sha256: string;
}

async function readBundledAgents(context: vscode.ExtensionContext): Promise<BundledAgents> {
  const mdUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'AGENTS.md');
  const manifestUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'agents.manifest.json');
  const body = Buffer.from(await vscode.workspace.fs.readFile(mdUri)).toString('utf8');
  const manifest = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(manifestUri)).toString('utf8'));
  return { body, version: String(manifest.version), sha256: String(manifest.sha256) };
}

function extensionVersion(context: vscode.ExtensionContext): string {
  return String(context.extension?.packageJSON?.version ?? 'unknown');
}

// Materialized file = a single-line provenance stamp + the canonical body. checkAgents strips the stamp before
// hashing, so the stamp never affects the drift check (the manifest sha256 is over the body only).
function stampedAgents(bundle: BundledAgents, extVersion: string): string {
  const header =
    `<!-- GENERATED: labview-benchmark-actor extension AGENTS.md v${bundle.version} ` +
    `(sha256:${bundle.sha256.slice(0, 12)}) - emitted by labview-benchmark-actor v${extVersion}. ` +
    `Regenerate with the "Write Agent Instructions" command; do not hand-edit this header. -->\n\n`;
  return header + canonicalizeAgents(bundle.body);
}

function stripAgentsStamp(text: string): string {
  return text.replace(/^<!-- GENERATED: labview-benchmark-actor extension AGENTS\.md[^\n]*-->\n\n?/, '');
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// A read-only virtual document serving the shipped canonical (stamped), for `showAgents` and the diff view.
class AgentsContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideTextDocumentContent(): Promise<string> {
    const bundle = await readBundledAgents(this.context);
    return stampedAgents(bundle, extensionVersion(this.context));
  }
}

function agentsCanonicalUri(version: string): vscode.Uri {
  return vscode.Uri.parse(`${AGENTS_SCHEME}:AGENTS.md?v=${version}`);
}

async function writeAgentsCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      'Open a folder first: "Write Agent Instructions" materializes AGENTS.md at the workspace root.'
    );
    return;
  }
  const bundle = await readBundledAgents(context);
  const target = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');

  if (await uriExists(target)) {
    const choice = await vscode.window.showWarningMessage(
      `AGENTS.md already exists at the workspace root. Overwrite it with the extension's v${bundle.version}?`,
      { modal: true },
      'Overwrite',
      'Show Diff'
    );
    if (choice === 'Show Diff') {
      await vscode.commands.executeCommand(
        'vscode.diff',
        target,
        agentsCanonicalUri(bundle.version),
        `AGENTS.md (workspace) \u2194 extension v${bundle.version}`
      );
      return;
    }
    if (choice !== 'Overwrite') {
      return; // Cancel / dismissed
    }
  }

  const content = stampedAgents(bundle, extensionVersion(context));
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  output.appendLine(`wrote ${target.fsPath} (extension AGENTS.md v${bundle.version})`);
  void vscode.window.showInformationMessage(`Wrote AGENTS.md (v${bundle.version}) to the workspace root.`);
}

async function showAgentsCommand(context: vscode.ExtensionContext): Promise<void> {
  const bundle = await readBundledAgents(context);
  const doc = await vscode.workspace.openTextDocument(agentsCanonicalUri(bundle.version));
  await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function checkAgentsCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      'Open a folder first: "Check Agent Instructions" verifies the workspace AGENTS.md.'
    );
    return;
  }
  const bundle = await readBundledAgents(context);
  const target = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');
  if (!(await uriExists(target))) {
    void vscode.window.showWarningMessage('No AGENTS.md at the workspace root. Run "Write Agent Instructions" first.');
    return;
  }
  const workspaceText = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
  const actual = agentsSha256(stripAgentsStamp(workspaceText));
  if (actual === bundle.sha256) {
    output.appendLine(`AGENTS.md matches the shipped canonical (v${bundle.version} sha256:${bundle.sha256.slice(0, 12)}).`);
    void vscode.window.showInformationMessage(`AGENTS.md matches the shipped extension canonical (v${bundle.version}).`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `AGENTS.md has DRIFTED from the extension canonical (v${bundle.version}).`,
    'Show Diff',
    'Rewrite'
  );
  if (choice === 'Show Diff') {
    await vscode.commands.executeCommand(
      'vscode.diff',
      target,
      agentsCanonicalUri(bundle.version),
      `AGENTS.md (workspace) \u2194 extension v${bundle.version}`
    );
  } else if (choice === 'Rewrite') {
    await vscode.workspace.fs.writeFile(target, Buffer.from(stampedAgents(bundle, extensionVersion(context)), 'utf8'));
    void vscode.window.showInformationMessage(`Rewrote AGENTS.md to the extension canonical (v${bundle.version}).`);
  }
}

// Create a cleanroom WORKER VM for cross-machine routing (the distributed-CI north-star): drives the reusable
// cloner experiments/multi-vm-topology/clone-cleanroom-worker.sh, which linked-clones the golden Ubuntu+LabVIEW
// base VM from its snapshot, assigns distinct NAT ports, provisions it (Node + the provider-delegation harness),
// and launches the worker as a PERSISTENT systemd unit -- so the host router can route capability-differentiated
// tasks across REAL VMs (proven by experiments/provider-delegation/prove-2vm-routing.mjs). The script uses
// VBoxManage + ssh + bash, so this is a Linux/macOS host operator tool; it runs in an integrated terminal so the
// operator watches the VM come up (and can answer any prompt). Inputs are validated to a safe charset + quoted,
// so nothing typed into the prompts can inject shell.
function cleanroomPortValidator(v: string): string | undefined {
  return /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : 'Enter a valid TCP port (1-65535)';
}

function cleanroomShellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveCloneScript(context: vscode.ExtensionContext): string | undefined {
  const rel = path.join('experiments', 'multi-vm-topology', 'clone-cleanroom-worker.sh');
  const candidates: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(path.join(folder.uri.fsPath, rel));
  }
  candidates.push(path.join(context.extensionUri.fsPath, rel));
  return candidates.find((candidate) => existsSync(candidate));
}

async function createCleanroomCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (process.platform === 'win32') {
    void vscode.window.showErrorMessage(
      'Create Cleanroom Worker VM is a Linux/macOS host tool (it drives VBoxManage + ssh via a bash script).'
    );
    return;
  }
  const script = resolveCloneScript(context);
  if (!script) {
    void vscode.window.showErrorMessage(
      'Cleanroom cloner not found (experiments/multi-vm-topology/clone-cleanroom-worker.sh). Open the labview-benchmark-actor repo as a workspace folder.'
    );
    return;
  }
  const cloneName = await vscode.window.showInputBox({
    prompt: 'Cleanroom clone VM name',
    value: 'lba-cleanroom-clone-01',
    validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? undefined : 'Use letters, digits, dot, dash, underscore only'),
  });
  if (!cloneName) {
    return;
  }
  const sshPort = await vscode.window.showInputBox({ prompt: 'Guest SSH host port', value: '2223', validateInput: cleanroomPortValidator });
  if (!sshPort) {
    return;
  }
  const workerPort = await vscode.window.showInputBox({ prompt: 'Worker host port', value: '7441', validateInput: cleanroomPortValidator });
  if (!workerPort) {
    return;
  }
  const actorId = await vscode.window.showInputBox({
    prompt: 'Worker actor id',
    value: 'cleanroom-clone',
    validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? undefined : 'Use letters, digits, dot, dash, underscore only'),
  });
  if (!actorId) {
    return;
  }

  output.appendLine(`[createCleanroom] cloning -> ${cloneName} (ssh ${sshPort}, worker ${workerPort}, actor ${actorId})`);
  output.show(true);
  const terminal = vscode.window.createTerminal({ name: `LBA Create Cleanroom: ${cloneName}` });
  terminal.show(true);
  const args = [cloneName, sshPort, workerPort, actorId].map(cleanroomShellQuote).join(' ');
  terminal.sendText(`bash ${cleanroomShellQuote(script)} ${args}`);
}

// Bootstrap the LabVIEW AUTHORING LANE (labview_assistant + its DQMH dependency + the .vipb VI-Package build).
// WINDOWS ONLY: labview_assistant drives the LabVIEW IDE via ActiveX, so the lane runs on a Windows cleanroom,
// not the Linux host. This surfaces the committed PowerShell bootstrap (experiments/authoring-lane/
// bootstrap-authoring-lane.ps1) so it can be run against a Windows cleanroom that has LabVIEW + VIPM Community.
function resolveAuthoringLaneScript(context: vscode.ExtensionContext): string | undefined {
  const rel = path.join('experiments', 'authoring-lane', 'bootstrap-authoring-lane.ps1');
  const candidates: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(path.join(folder.uri.fsPath, rel));
  }
  candidates.push(path.join(context.extensionUri.fsPath, rel));
  return candidates.find((candidate) => existsSync(candidate));
}

async function bootstrapAuthoringLaneCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const script = resolveAuthoringLaneScript(context);
  if (!script) {
    void vscode.window.showErrorMessage(
      'Authoring-lane bootstrap not found (experiments/authoring-lane/bootstrap-authoring-lane.ps1). Open the labview-benchmark-actor repo as a workspace folder.'
    );
    return;
  }
  void vscode.window.showInformationMessage(
    'The LabVIEW authoring lane is Windows-only (labview_assistant drives LabVIEW via ActiveX). Run this on a Windows cleanroom with LabVIEW + VIPM Community activated.'
  );
  output.appendLine(`[bootstrapAuthoringLane] ${script} (Windows/pwsh: clones labview_assistant, installs DQMH, builds the .vipb)`);
  output.show(true);
  const terminal = vscode.window.createTerminal({ name: 'LBA Authoring Lane Bootstrap' });
  terminal.show(true);
  terminal.sendText(`pwsh -NoProfile -File "${script}"`);
}

// Resolve a repo-relative file from the open workspace folder(s), falling back to the bundled extension copy.
function resolveWorkspaceRepoFile(context: vscode.ExtensionContext, rel: string): string | undefined {
  const candidates: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(path.join(folder.uri.fsPath, rel));
  }
  candidates.push(path.join(context.extensionUri.fsPath, rel));
  return candidates.find((candidate) => existsSync(candidate));
}

// Actor Corroboration Grid (ADR-0014, LBA-REQ-023): run the whole grid end-to-end over the committed witnesses
// and print the release decision -- machine-corroborated across independence + quorum + attestation + mesh, then
// held at the human sign-off gate. Cross-platform (Node); reads only committed evidence.
async function runCorroborationGridCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const script = resolveWorkspaceRepoFile(context, path.join('experiments', 'acg-grid', 'grid-run-proof.mjs'));
  if (!script) {
    void vscode.window.showErrorMessage(
      'Corroboration grid runner not found (experiments/acg-grid/grid-run-proof.mjs). Open the labview-benchmark-actor repo as a workspace folder.'
    );
    return;
  }
  output.appendLine(`[runCorroborationGrid] node ${script}`);
  output.show(true);
  const terminal = vscode.window.createTerminal({ name: 'LBA Corroboration Grid' });
  terminal.show(true);
  terminal.sendText(`node "${script}"`);
}

// Verify-before-install (ADR-0022, LBA-REQ-031): verify a release's corroboration provenance -- every witness
// attestation must be enrolled-signed AND included in the signed transparency log -- running the same verifier
// the reviewer workstation runs before installing the .vsix. Cross-platform (Node).
async function verifyReleaseProvenanceCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const script = resolveWorkspaceRepoFile(context, path.join('experiments', 'acg-transparency', 'verify-release-inclusion.mjs'));
  if (!script) {
    void vscode.window.showErrorMessage(
      'Release-provenance verifier not found (experiments/acg-transparency/verify-release-inclusion.mjs). Open the labview-benchmark-actor repo as a workspace folder.'
    );
    return;
  }
  output.appendLine(`[verifyReleaseProvenance] node ${script}`);
  output.show(true);
  const terminal = vscode.window.createTerminal({ name: 'LBA Verify Release Provenance' });
  terminal.show(true);
  terminal.sendText(`node "${script}"`);
}

// Throughput-to-disk LADDER (the benchmark-variation witness, operator direction 2026-08-04): run the C# `tpd`
// disk-throughput ladder via experiments/throughput-to-disk/run-ladder.mjs and record a
// throughput-ladder-receipt@v1. Best-effort reproducible -- the CROSS-WITNESS variation (compare-ladders.mjs) is
// the corroboration signal, NOT byte-identity; the timestamp differentiates each run. No LabVIEW. Linux/macOS
// host (the tpd + fsync measure the sustained to-disk rate); this is the extension's LINUX path.
async function runThroughputLadderCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (process.platform === 'win32') {
    void vscode.window.showErrorMessage(
      'Run Throughput-to-Disk Ladder is a Linux/macOS tool (the C# tpd + fsync measure sustained to-disk throughput).'
    );
    return;
  }
  const script = resolveWorkspaceRepoFile(context, path.join('experiments', 'throughput-to-disk', 'run-ladder.mjs'));
  if (!script) {
    void vscode.window.showErrorMessage(
      'Throughput ladder runner not found (experiments/throughput-to-disk/run-ladder.mjs). Open the labview-benchmark-actor repo as a workspace folder.'
    );
    return;
  }
  const plane = await vscode.window.showInputBox({
    prompt: 'Witness plane name (differentiates this witness in the corroboration)',
    value: 'REVIEWER-LINUX',
    validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? undefined : 'Use letters, digits, dot, dash, underscore only'),
  });
  if (!plane) {
    return;
  }
  const rungs = await vscode.window.showInputBox({
    prompt: 'Ladder rungs (comma-separated, increasing disk load)',
    value: '256M,512M,1G',
    validateInput: (v) => (/^\s*\d+(\.\d+)?[KMG]?(\s*,\s*\d+(\.\d+)?[KMG]?)*\s*$/i.test(v) ? undefined : 'Comma-separated sizes, e.g. 256M,512M,1G'),
  });
  if (!rungs) {
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(script);
  const outFile = path.join(folder, `throughput-ladder-${plane}.json`);
  output.appendLine(`[runThroughputLadder] node ${script} --plane ${plane} --rungs ${rungs} --out ${outFile}`);
  output.show(true);
  const terminal = vscode.window.createTerminal({ name: `LBA Throughput Ladder: ${plane}` });
  terminal.show(true);
  terminal.sendText(`node "${script}" --plane "${plane}" --rungs "${rungs}" --out "${outFile}"`);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = getOutput(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.showCapabilities', () =>
      runCli(output, ['capabilities'], 15000)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.pollBus', () => {
      const { netLog } = busConfig();
      const args = ['net', 'poll', ...(netLog ? ['--log', netLog] : []), '--tail', '10'];
      return runCli(output, args, 30000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.postNote', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Coordination note (ASCII only)',
        placeHolder: 'NOTE ...',
      });
      if (!message) {
        return;
      }
      const { netHosts } = busConfig();
      const args = ['net', 'send', ...(netHosts ? ['--hosts', netHosts] : ['--skip-if-no-peer']), '--type', 'NOTE', '--message', message];
      await runCli(output, args, 20000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.openViewer', () => {
      const panel = vscode.window.createWebviewPanel(
        'labviewBenchmarkActorViewer',
        'Benchmark Viewer',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        }
      );
      panel.webview.html = viewerHtml(panel.webview, context.extensionUri);
    })
  );

  // Real benchmark UI surfaces (LBA-REQ-004/005): render the shipped LabVIEW launch record + 5-run trend and
  // the vertical-line frame correlator, all fed by the real committed fixtures the local gates re-validate.
  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.openBenchmarkRun', () =>
      openBenchmarkRunCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openBenchmarkTrend', () =>
      openBenchmarkTrendCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openFrameCorrelator', () =>
      openFrameCorrelatorCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openCrossPlaneTrend', () =>
      openCrossPlaneTrendCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openResourceProfile', () =>
      openResourceProfileCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openCrossPlaneResource', () =>
      openCrossPlaneResourceCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openMeshCalibration', () =>
      openMeshCalibrationCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.openMeshBoard', () =>
      openMeshBoardCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.captureLaunch', () =>
      captureLaunchCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.captureLaunchMprr', () =>
      captureLaunchMprrCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.stopCapture', () =>
      stopCaptureCommand(context, output)
    )
  );

  // Handoff Beacon agent->human request barrier (LBA-REQ-056, ADR-0036): watch handoff/requests/ and surface the
  // agent's asks as in-VM notifications; the "Mark step done" / "Skip" actions (also palette commands) write the
  // op-done beacon the agent awaits.
  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.markStepDone', () => markStepDoneCommand(context, output)),
    vscode.commands.registerCommand('labviewBenchmarkActor.skipStep', () => skipStepCommand(context, output)),
    vscode.commands.registerCommand('labviewBenchmarkActor.renderReviewerVerdict', () => renderReviewerVerdictCommand(context, output))
  );
  startHandoffWatcher(context, output);

  // Extension-embedded AGENTS.md (issue #98): read-only canonical provider + materialize/show/check commands.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(AGENTS_SCHEME, new AgentsContentProvider(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.writeAgents', () => writeAgentsCommand(context, output)),
    vscode.commands.registerCommand('labviewBenchmarkActor.showAgents', () => showAgentsCommand(context)),
    vscode.commands.registerCommand('labviewBenchmarkActor.checkAgents', () => checkAgentsCommand(context, output))
  );

  // Cross-machine cleanroom creation (distributed CI): clone a capability-differentiated worker VM from the
  // golden snapshot and launch its bus worker, so the host router can route across REAL VMs.
  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.createCleanroom', () => createCleanroomCommand(context, output))
  );

  // LabVIEW authoring lane (Windows/ActiveX): bootstrap labview_assistant + its DQMH dependency + the .vipb
  // VI-Package build so it can be tested on a Windows cleanroom.
  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.bootstrapAuthoringLane', () => bootstrapAuthoringLaneCommand(context, output))
  );

  // Actor Corroboration Grid (ADR-0014 / ADR-0022): surface the end-to-end grid run and the verify-before-install
  // provenance check to the operator, running the same committed engines the local gates re-derive.
  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.runCorroborationGrid', () => runCorroborationGridCommand(context, output)),
    vscode.commands.registerCommand('labviewBenchmarkActor.verifyReleaseProvenance', () => verifyReleaseProvenanceCommand(context, output)),
    vscode.commands.registerCommand('labviewBenchmarkActor.runThroughputLadder', () => runThroughputLadderCommand(context, output))
  );

  // Model Context Protocol surface (VS Code 1.101+): expose this extension's own tools (host capabilities,
  // the deterministic benchmark series, the coordination bus) to Copilot agent mode via a bundled stdio
  // JSON-RPC server. No-op on hosts predating the stable MCP API.
  registerBenchmarkActorMcpServerProvider(context);

  // Language-model tools (VS Code 1.101+): let a Copilot AGENT open the benchmark panels + summarize the
  // captured numbers directly from a prompt. No-op on older hosts.
  registerBenchmarkLanguageModelTools(context, output);
}

export function deactivate(): void {
  // Nothing to tear down: all disposables are registered on the extension context.
}
