import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

// Build the LBA-REQ-004 benchmark-viewer webview HTML: a strict CSP (default-src 'none'; scripts only via the
// nonce + the webview resource origin), a non-executed JSON series data block, and the media/viewer.js module
// (which imports the shipped, unit-tested media/viewerCursor.mjs and renders the draggable time cursor).
function viewerHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const viewerJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.js'));
  const cspSource = webview.cspSource;
  // Demo benchmark metric (e.g. cpu%) sampled over the run window; a real run supplies its own series.
  const series = [
    { t: 0, v: 40 },
    { t: 100, v: 44 },
    { t: 200, v: 58 },
    { t: 300, v: 63 },
    { t: 400, v: 55 },
    { t: 500, v: 71 },
    { t: 600, v: 66 },
    { t: 700, v: 48 },
  ];
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
}

export function deactivate(): void {
  // Nothing to tear down: all disposables are registered on the extension context.
}
