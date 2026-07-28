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
}

export function deactivate(): void {
  // Nothing to tear down: all disposables are registered on the extension context.
}
