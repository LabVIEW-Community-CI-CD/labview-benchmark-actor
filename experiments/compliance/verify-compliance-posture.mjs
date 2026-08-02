#!/usr/bin/env node
// Continuous compliance self-audit (LBA-REQ-037): the CAPSTONE meta-gate. It scores THIS repository
// against the `repo-standards-review` five-lens rubric (REQ/ARCH/TEST/CM/DOC) at clause-evidence
// granularity, and GENERATES docs/compliance/compliance-posture.md. The `continuous-compliance-self-audit`
// gate fails closed if any lens drops below its target, so full compliance is verified continuously and
// cannot silently regress: delete the test report, unwire a gate, or drop a clause anchor and the build
// goes red.
//
// The rubric's level-5 meaning per lens (references/scoring-rubric.md) is encoded as the set of concrete
// evidence a lens needs to reach target: real files (information items), wired fail-closed gates (the
// enforcement), and clause-anchor phrases (the 29148/42010/29119/10007/15289 hooks in common-clauses.md).
// Dependency-free. `computePosture` + `scoreLens` are exported for the selftest (scoreLens is pure).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const OUT_REL = 'docs/compliance/compliance-posture.md';

// The five lenses. Each requirement is one piece of clause-evidence that the rubric's level-5 needs.
export const LENSES = [
  {
    id: 'REQ', standard: 'ISO/IEC/IEEE 29148', target: 5,
    requirements: [
      { kind: 'file', path: 'docs/requirements/srs.md', note: 'requirement specification (SRS)' },
      { kind: 'file', path: 'docs/requirements/rtm.csv', note: 'requirements traceability matrix (Req->Test->Code)' },
      { kind: 'file', path: 'docs/requirements/traceability-matrix.md', note: 'generated traceability artifact' },
      { kind: 'regex', path: 'docs/requirements/srs.md', re: /###\s+LBA-REQ-\d+/, note: 'requirement IDs' },
      { kind: 'phrase', path: 'docs/requirements/srs.md', any: ['Acceptance Criteria', 'fit criterion'], note: 'fit / acceptance criteria (verifiability)' },
      { kind: 'gate', id: 'requirements-quality-29148', note: 'singular-requirement enforcement (29148 §5.2.5)' },
      { kind: 'gate', id: 'rtm-proven-rows-cite-existing-evidence', note: 'Req->Code evidence resolves on disk' },
      { kind: 'gate', id: 'traceability-matrix-current', note: 'traceability generated + drift-gated' },
      { kind: 'gate', id: 'test-requirement-correspondence', note: 'Req<->Test correspondence (TR-1)' },
    ],
  },
  {
    id: 'ARCH', standard: 'ISO/IEC/IEEE 42010', target: 5,
    requirements: [
      { kind: 'file', path: 'docs/architecture/overview.md', note: 'architecture description' },
      { kind: 'file', path: 'docs/architecture/adr/README.md', note: 'decision register (retained rationale)' },
      { kind: 'count', path: 'docs/architecture/overview.md', re: /^###\s+\d+\.\d+\s/gm, min: 4, note: 'at least the 4 architecture views' },
      { kind: 'phrase', path: 'docs/architecture/overview.md', any: ['stakeholder'], note: 'named stakeholders' },
      { kind: 'phrase', path: 'docs/architecture/overview.md', any: ['concern'], note: 'stakeholder concerns' },
      { kind: 'gate', id: 'adr-index-integrity', note: 'ADR decision-register integrity' },
      { kind: 'gate', id: 'test-requirement-correspondence', note: 'enforced 42010 correspondence graph (AD-1/VW-1)' },
    ],
  },
  {
    id: 'TEST', standard: 'ISO/IEC/IEEE 29119-2/3', target: 5,
    requirements: [
      { kind: 'file', path: 'docs/testing/test-plan.md', note: 'test plan (29119-3)' },
      { kind: 'file', path: 'docs/testing/test-report.md', note: 'test report — executed evidence (29119-3)' },
      { kind: 'file', path: 'coverage-thresholds.json', note: 'coverage thresholds' },
      { kind: 'phrase', path: 'docs/testing/test-plan.md', any: ['completion criteria', 'exit criteria'], note: 'completion / exit criteria (29119-2)' },
      { kind: 'gate', id: 'coverage-artifact-meets-floor', note: 'PR Coverage Gate (threshold enforced)' },
      { kind: 'gate', id: 'test-report-current', note: 'test report current + drift-gated' },
      { kind: 'gate', id: 'test-requirement-correspondence', note: 'test<->requirement (TR-1)' },
    ],
  },
  {
    id: 'CM', standard: 'ISO 10007 / ISO/IEC/IEEE 12207', target: 5,
    requirements: [
      { kind: 'file', path: 'docs/cm/cm-plan.md', note: 'configuration management plan' },
      { kind: 'file', path: 'docs/release/release-procedure.md', note: 'release procedure (12207 release process)' },
      { kind: 'file', path: '.github/workflows/extension-release.yml', note: 'release workflow' },
      { kind: 'phrase', path: 'docs/cm/cm-plan.md', any: ['baseline'], note: 'configuration baselines (10007)' },
      { kind: 'phrase', path: 'docs/cm/cm-plan.md', any: ['status accounting'], note: 'status accounting (10007)' },
      { kind: 'phrase', path: 'docs/cm/cm-plan.md', any: ['SemVer'], note: 'SemVer identification' },
      { kind: 'gate', id: 'gitflow-branch-governance-documented', note: 'complete GitFlow branch governance' },
      { kind: 'gate', id: 'adr-index-integrity', note: 'CM status accounting (CM-1)' },
      { kind: 'gate', id: 'release-procedure-references-resolve', note: 'release procedure resolvable + invariant-complete' },
    ],
  },
  {
    id: 'DOC', standard: 'ISO/IEC/IEEE 15289 / 26514', target: 5,
    requirements: [
      { kind: 'file', path: 'docs/information-item-map.md', note: '15289 information item map' },
      { kind: 'file', path: 'docs/requirements/srs.md', note: 'doc-type: specification' },
      { kind: 'file', path: 'docs/testing/test-plan.md', note: 'doc-type: plan' },
      { kind: 'file', path: 'docs/testing/test-report.md', note: 'doc-type: report' },
      { kind: 'file', path: 'docs/release/release-procedure.md', note: 'doc-type: procedure' },
      { kind: 'file', path: 'docs/information-for-users/navigation-and-search.md', note: '26514 information-for-users set' },
      { kind: 'file', path: '.github/workflows/docs-link-check.yml', note: 'docs link-check (lychee)' },
      { kind: 'gate', id: 'information-for-users-26514', note: '26514 bounded product set gated' },
      { kind: 'gate', id: 'test-requirement-correspondence', note: 'information-item coverage (II-1/II-2)' },
    ],
  },
];

// ---- pure scoring: a lens reaches its target only when EVERY clause-evidence requirement is met --------
export function scoreLens(lens, probe) {
  const findings = [];
  for (const req of lens.requirements) {
    let met;
    if (req.kind === 'file') met = probe.file(req.path);
    else if (req.kind === 'phrase') met = probe.phrase(req.path, req.any);
    else if (req.kind === 'regex') met = probe.regex(req.path, req.re);
    else if (req.kind === 'count') met = probe.count(req.path, req.re, req.min);
    else if (req.kind === 'gate') met = probe.gate(req.id);
    else met = false;
    if (!met) findings.push(`[${lens.id}] missing ${req.note}${req.path ? ` (${req.path})` : req.id ? ` (gate ${req.id})` : ''}`);
  }
  const total = lens.requirements.length;
  const satisfied = total - findings.length;
  const score = satisfied === total ? lens.target : Math.floor((lens.target * satisfied) / total);
  return { id: lens.id, standard: lens.standard, target: lens.target, score, satisfied, total, findings };
}

// ---- disk-backed probe (reads the committed sources under repoRoot) -----------------------------------
function diskProbe({ repoRoot }) {
  const cache = new Map();
  const read = (p) => {
    if (!cache.has(p)) {
      const abs = join(repoRoot, p);
      cache.set(p, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
    }
    return cache.get(p);
  };
  return {
    file: (p) => existsSync(join(repoRoot, p)),
    phrase: (p, any) => { const t = read(p); return t != null && any.some((a) => t.toLowerCase().includes(a.toLowerCase())); },
    regex: (p, re) => { const t = read(p); return t != null && re.test(t); },
    count: (p, re, min) => { const t = read(p); if (t == null) return false; const m = t.match(re); return (m ? m.length : 0) >= min; },
    gate: (id) => { const t = read('experiments/verify-local-gates.mjs'); return t != null && t.includes(`check('${id}'`); },
  };
}

export function computePosture({ repoRoot }) {
  const probe = diskProbe({ repoRoot });
  const lenses = LENSES.map((l) => scoreLens(l, probe));
  const totalScore = lenses.reduce((s, l) => s + l.score, 0);
  const targetTotal = LENSES.reduce((s, l) => s + l.target, 0);
  const checks = LENSES.reduce((s, l) => s + l.requirements.length, 0);
  const ok = lenses.every((l) => l.score >= l.target);
  return { ok, lenses, totalScore, targetTotal, checks, findings: lenses.flatMap((l) => l.findings) };
}

// ---- render the scorecard deterministically -----------------------------------------------------------
export function renderScorecard(posture) {
  const lines = [
    '# Compliance posture — labview-benchmark-actor',
    '',
    '> GENERATED + fail-closed self-audit (LBA-REQ-037) by',
    '> `experiments/compliance/verify-compliance-posture.mjs`. Scores this repository against the',
    '> `repo-standards-review` five-lens rubric (REQ/ARCH/TEST/CM/DOC) at clause-evidence granularity. The',
    '> `continuous-compliance-self-audit` gate fails closed if any lens drops below its target or a required',
    '> clause-evidence item / wired gate is missing, so full compliance is verified **continuously** and',
    '> cannot silently regress. Do NOT edit by hand — run the generator and commit.',
    '',
    `## Posture: ${posture.totalScore}/${posture.targetTotal} — ${posture.ok ? 'CONFORMANT' : 'NON-CONFORMANT'}`,
    '',
    '| Lens | Standard | Score | Target | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...posture.lenses.map((l) => `| ${l.id} | ${l.standard} | ${l.score} | ${l.target} | ${l.satisfied}/${l.total} |`),
    '',
    'Each lens reaches its target only when **every** clause-evidence item below is present — a real',
    'information item, a wired fail-closed gate, or a standard clause anchor. Removing any one fails the',
    'build.',
    '',
    '## Required clause-evidence per lens',
    '',
  ];
  for (const l of LENSES) {
    const scored = posture.lenses.find((x) => x.id === l.id);
    lines.push(`### ${l.id} — ${l.standard} (${scored.score}/${l.target})`, '');
    for (const req of l.requirements) {
      const ref = req.path || (req.id ? `gate: ${req.id}` : '');
      const met = !scored.findings.some((f) => f.includes(req.note));
      lines.push(`- [${met ? 'x' : ' '}] ${req.note}${ref ? ` — \`${ref}\`` : ''}`);
    }
    lines.push('');
  }
  lines.push(`_Self-audited across ${posture.checks} clause-evidence checks over ${LENSES.length} lenses._`);
  return lines.join('\n') + '\n';
}

// ---- CLI (write or --check) ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const checkOnly = process.argv.slice(2).includes('--check');
  const posture = computePosture({ repoRoot });
  const rendered = renderScorecard(posture);
  const OUT = join(repoRoot, OUT_REL);
  if (checkOnly) {
    if (!posture.ok) {
      console.error(`compliance-posture: NON-CONFORMANT (${posture.totalScore}/${posture.targetTotal}):`);
      for (const f of posture.findings) console.error(`  - ${f}`);
      process.exit(1);
    }
    const committed = (existsSync(OUT) ? readFileSync(OUT, 'utf8') : '').replace(/\r\n/g, '\n');
    if (committed !== rendered) {
      console.error(`compliance-posture: STALE — ${OUT_REL} is out of date. Run: node experiments/compliance/verify-compliance-posture.mjs`);
      process.exit(1);
    }
    console.log(`compliance-posture: CONFORMANT ${posture.totalScore}/${posture.targetTotal} (${posture.checks} checks, ${LENSES.length} lenses)`);
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, rendered);
    console.log(`compliance-posture: wrote ${OUT_REL} — ${posture.totalScore}/${posture.targetTotal} (${posture.checks} checks)`);
  }
}
