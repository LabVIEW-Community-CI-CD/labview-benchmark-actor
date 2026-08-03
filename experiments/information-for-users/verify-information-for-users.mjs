// verify-information-for-users.mjs -- fail-closed ISO/IEC/IEEE 26514:2022 information-for-users conformance
// checker (LBA-REQ-034). Verifies the bounded information PRODUCT set is COMPLETE and cannot silently drift:
//   1. every required information item exists + is non-trivial,
//   2. the command reference covers EVERY VS Code command the extension contributes,
//   3. the conformance boundary states a bounded product claim + disclaims full process conformance,
//   4. the audience/task model contains both an Audience and a Task analysis,
//   5. the navigation hub indexes every other item.
// Pure, deterministic, Node builtins only (no ripgrep / no network). Elevates 26514 from advisory to enforced.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRED_ITEMS = Object.freeze([
  'navigation-and-search', 'getting-started', 'user-guide', 'command-reference', 'glossary',
  'faq', 'audience-and-task-model', 'delivery-profile', 'plan', 'conformance-boundary', 'join-the-mesh',
]);
const MIN_NONEMPTY_LINES = 12;

/**
 * Build the 26514 information-for-users conformance report for a repo.
 * @param {{repoRoot?: string}} [opts]
 * @returns {{schema:string, requiredItems:number, commandsCovered:number, commandsTotal:number, findings:string[], ok:boolean}}
 */
export function buildInformationForUsersReport(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const dir = join(repoRoot, 'docs', 'information-for-users');
  const findings = [];
  const items = {};

  // 1. required items present + non-trivial
  for (const name of REQUIRED_ITEMS) {
    const p = join(dir, `${name}.md`);
    if (!existsSync(p)) { findings.push(`missing required information item: ${name}.md`); continue; }
    const txt = readFileSync(p, 'utf8');
    const nonEmpty = txt.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    if (nonEmpty < MIN_NONEMPTY_LINES) findings.push(`${name}.md is too thin (${nonEmpty} < ${MIN_NONEMPTY_LINES} non-empty lines)`);
    items[name] = txt;
  }

  // 2. the command reference covers every contributed VS Code command
  let commandTitles = [];
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const cmds = (pkg.contributes && pkg.contributes.commands) || [];
    commandTitles = cmds.map((c) => String(c.title || '').replace(/^LabVIEW Benchmark Actor:\s*/, '').trim()).filter(Boolean);
  } catch { findings.push('could not read package.json contributed commands'); }
  const cmdRef = items['command-reference'] || '';
  const missingCmds = commandTitles.filter((t) => !cmdRef.includes(t));
  if (missingCmds.length) findings.push(`command-reference.md omits ${missingCmds.length} contributed command(s): ${missingCmds.slice(0, 6).join(', ')}`);

  // 3. the conformance boundary states a bounded product claim + disclaims full process conformance
  const cb = items['conformance-boundary'] || '';
  if (!/bounded/i.test(cb) || !/product/i.test(cb)) findings.push('conformance-boundary.md does not state a bounded product claim');
  if (!/not[\s\S]{0,40}full process conformance/i.test(cb)) findings.push('conformance-boundary.md does not disclaim full process conformance');

  // 4. the audience/task model contains both audience and task analysis
  const at = items['audience-and-task-model'] || '';
  if (!/^##\s*audience/im.test(at)) findings.push('audience-and-task-model.md has no Audience section');
  if (!/^##\s*task/im.test(at)) findings.push('audience-and-task-model.md has no Task section');

  // 5. the navigation hub indexes every other required item
  const nav = items['navigation-and-search'] || '';
  const navMissing = REQUIRED_ITEMS.filter((n) => n !== 'navigation-and-search' && !nav.includes(`${n}.md`));
  if (navMissing.length) findings.push(`navigation-and-search.md does not index: ${navMissing.join(', ')}`);

  return {
    schema: 'labview-benchmark-actor/information-for-users-26514@1',
    requiredItems: REQUIRED_ITEMS.length,
    commandsCovered: commandTitles.length - missingCmds.length,
    commandsTotal: commandTitles.length,
    findings,
    ok: findings.length === 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = buildInformationForUsersReport({ repoRoot: process.cwd() });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  if (!r.ok) { process.stderr.write(`information-for-users 26514 FAIL:\n  - ${r.findings.join('\n  - ')}\n`); process.exit(1); }
  process.stderr.write(`information-for-users 26514 OK: ${r.requiredItems} items, ${r.commandsCovered}/${r.commandsTotal} commands covered\n`);
}
