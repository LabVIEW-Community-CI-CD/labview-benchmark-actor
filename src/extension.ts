import * as vscode from 'vscode';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

import { registerBenchmarkActorMcpServerProvider } from './mcp/benchmarkActorMcpServerProvider';

const execFileAsync = promisify(execFile);

// The labview-benchmark-actor extension packages the standalone agentic infrastructure (LBA-REQ-001): it
// surfaces the cross-plane coordination bus (`lbabus`) inside the VS Code host so an operator can observe
// host capabilities, poll the coordination bus, and post a coordination note from the IDE. The extension
// depends only on `vscode` + Node built-ins -- no `vi-history-suite`-private module on its graph.

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
    'Open a panel to see these visually — call lba-open-benchmark-panel with panel = run | trend | frameCorrelator | crossPlaneTrend | resourceProfile | crossPlaneResource, or run the "LabVIEW Benchmark Actor: Open ..." commands.'
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

interface ActiveCapture {
  dir: string;
  ffmpeg: ChildProcess;
  sampler: ChildProcess;
  status: vscode.StatusBarItem;
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
  if (configured) return configured;
  const candidates = [
    'C:\\Program Files (x86)\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
    'C:\\Program Files\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
  ];
  return candidates.find((c) => existsSync(c)) || null;
}

// ffmpeg resolution: explicit setting -> the VM-local copy install-lba.cmd stages under %LOCALAPPDATA%\lba ->
// `ffmpeg` on PATH. So a capture is one-click after install even when ffmpeg is not otherwise on the system.
function resolveFfmpeg(): string {
  const configured = captureCfg<string>('ffmpegPath', '').trim();
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA;
  const staged = localAppData ? path.join(localAppData, 'lba', 'ffmpeg.exe') : '';
  if (staged && existsSync(staged)) return staged;
  return 'ffmpeg';
}

// PowerShell CIM sampler: instant formatted counters (CPU/disk %) + OS memory -> JSONL every ~200 ms.
export function samplerScript(outFile: string): string {
  const out = outFile.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$out='${out}'`,
    'while ($true) {',
    "  $c=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime",
    '  $o=Get-CimInstance Win32_OperatingSystem',
    '  $r=[math]::Round((($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1024),1)',
    "  $d=(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\").PercentDiskTime",
    '  $ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  Add-Content -Path $out -Value ("{""ms"":"+$ms+",""cpuPct"":"+[double]$c+",""ramMb"":"+$r+",""diskPct"":"+[double]$d+"}")',
    '  Start-Sleep -Milliseconds 200',
    '}',
  ].join('\n');
}

async function captureLaunchCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (activeCapture) {
    void vscode.window.showWarningMessage('A LabVIEW capture is already running. Stop it first.');
    return;
  }
  const ffmpeg = resolveFfmpeg();
  const labview = resolveLabview();
  if (!labview) {
    void vscode.window.showErrorMessage(
      'LabVIEW.exe not found. Set "labviewBenchmarkActor.labviewPath" to your LabVIEW 2026 LabVIEW.exe.'
    );
    return;
  }
  const dir = path.join(capturesRoot(context), `run-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    reportUiError(output, 'Capture LabVIEW Launch', err);
    return;
  }
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

  activeCapture = { dir, ffmpeg: ffmpegProc, sampler, status };
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

  try {
    const record = await assembleCapture(context, cap.dir);
    await openCorrelatorForCapture(context, output, cap.dir, record);
    output.appendLine(`capture stopped: ${record.frameCount} frames -> correlator`);
  } catch (err) {
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
  record: LaunchCaptureRecord
): Promise<void> {
  const correlator = await loadCorrelatorBuilder(context.extensionUri);
  const panel = vscode.window.createWebviewPanel(
    'lbaFrameCorrelator',
    'LabVIEW Launch Frame Correlator',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(dir)] }
  );
  const framesModel = record.frames.map((f) => ({
    index: f.index,
    tMs: f.tMs,
    cpuPct: f.cpuPct,
    ramMb: f.ramMb,
    diskPct: f.diskPct,
    imageSrc: panel.webview.asWebviewUri(vscode.Uri.file(path.join(dir, String(f.image)))).toString(),
  }));
  const model = { title: 'LabVIEW launch \u2014 frame correlator', fps: 12, selectedIndex: 0, frames: framesModel };
  panel.webview.html = correlator.buildFrameCorrelatorHtml(model, getNonce(), panel.webview.cspSource);
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
    await openCorrelatorForCapture(context, output, dir, record);
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

export function activate(context: vscode.ExtensionContext): void {
  const output = getOutput(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.showCapabilities', () =>
      runCli(output, ['capabilities'], 15000)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('labviewBenchmarkActor.pollBus', () =>
      runCli(output, ['poll', '--full', '--tail', '10'], 30000)
    )
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
      await runCli(output, ['post', '--type', 'NOTE', '--message', message], 20000);
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
    vscode.commands.registerCommand('labviewBenchmarkActor.captureLaunch', () =>
      captureLaunchCommand(context, output)
    ),
    vscode.commands.registerCommand('labviewBenchmarkActor.stopCapture', () =>
      stopCaptureCommand(context, output)
    )
  );

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
    vscode.commands.registerCommand('labviewBenchmarkActor.verifyReleaseProvenance', () => verifyReleaseProvenanceCommand(context, output))
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
