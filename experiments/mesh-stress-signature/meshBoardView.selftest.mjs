// Self-test for meshBoardView.mjs -- the Concurrent Mesh BOARD (overview §3.6 / VW-1, LBA-REQ-032). Browser-free:
// build the HTML from the COMMITTED concurrent-actors receipt and assert the rendered board -- one tile per
// concurrent actor with its stress bar (widths monotone idle -> saturate) + the inverse-read rung + recovered
// mark, the simultaneity/invariant badges, and that the surface is inert (CSP script-src 'none') + escapes
// hostile input. Run: node meshBoardView.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMeshBoardHtml, MESH_BOARD_VIEW_SCHEMA } from './meshBoardView.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'mesh-concurrent-actors-receipt.json'), 'utf8'));
const html = buildMeshBoardHtml(receipt, { cspSource: 'vscode-resource:' });
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- 1. an inert, well-formed document ---
{
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'emits a full HTML document');
  assert.match(html, /script-src 'none'/, "the surface is script-free (script-src 'none')");
  assert.ok(!/<script/i.test(html), 'contains no <script> element');
  assert.ok(MESH_BOARD_VIEW_SCHEMA.length > 0, 'exports a view schema id');
  ok('renders an inert, script-free HTML board with a CSP');
}

// --- 2. one tile per concurrent actor, with its commanded rung ---
{
  for (const a of receipt.actors) {
    assert.ok(html.includes(`<b>${a.actor}</b>`), `board shows a tile for ${a.actor}`);
    assert.ok(html.includes(`>${a.rung}</span>`), `tile ${a.actor} shows its rung ${a.rung}`);
  }
  ok(`renders one tile per actor (${receipt.actors.length} actors)`);
}

// --- 3. each actor's stress bar tracks its cpuPoolPct, monotone idle -> saturate ---
{
  const widths = [...html.matchAll(/class="mb-bar" style="width:([\d.]+)%"/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, receipt.actors.length, 'one stress bar per actor');
  for (let i = 1; i < widths.length; i += 1) assert.ok(widths[i] >= widths[i - 1], `stress bars climb idle -> saturate (${widths.join(',')})`);
  assert.ok(widths[widths.length - 1] > widths[0], 'the saturate actor bar is wider than the idle actor bar');
  ok(`stress bars track cpuPoolPct monotonically [${widths.join(', ')}]%`);
}

// --- 4. each actor's inverse-read rung + recovered mark; all recovered ---
{
  for (const x of receipt.perActorInverseRead) {
    assert.ok(html.includes(`read \u2192 <b>${x.inferredRung}</b>`), `tile shows ${x.actor} inferred ${x.inferredRung}`);
  }
  const recoveredMarks = (html.match(/mb-mark ok">\u2713/g) || []).length;
  assert.equal(recoveredMarks, receipt.perActorInverseRead.filter((x) => x.correct).length, 'a recovered check per correctly-read actor');
  ok(`each tile shows the inverse-read rung + recovered mark (${recoveredMarks} recovered)`);
}

// --- 5. the simultaneity + invariant badges reflect the receipt ---
{
  assert.match(html, /class="mb-badge ok">\u2713 all actors recovered/, 'all-actors-recovered badge is green');
  assert.match(html, /class="mb-badge ok">\u2713 exactly 12 FPS/, 'exactly-12-FPS badge is green');
  assert.match(html, /actors \/ frame \(simultaneous\)/, 'shows the simultaneous actors-per-frame badge');
  assert.match(html, /class="mb-badge ok">\u2713 separable/, 'separable badge is green');
  ok('simultaneity + invariant badges are green (recovered / 12 FPS / simultaneous / separable)');
}

// --- 6. hostile input is escaped ---
{
  const evil = buildMeshBoardHtml({
    schema: '<img src=x onerror=alert(1)>',
    host: { cpus: 4 },
    actors: [{ actor: '</b><script>bad()</script>', rung: '<x>', cpuPoolPctMean: 10 }],
    perActorInverseRead: [{ actor: '</b><script>bad()</script>', inferredRung: '<y>', correct: true, confidence: 1 }],
    invariants: {}, concurrency: {}, measured: {},
  });
  assert.ok(!evil.includes('<script>bad()</script>'), 'hostile actor name is escaped');
  assert.ok(!evil.includes('<img src=x onerror'), 'hostile schema is escaped');
  assert.ok(evil.includes('&lt;'), 'markup is entity-escaped');
  ok('escapes hostile input (no HTML/script injection)');
}

console.log(`\nmeshBoardView.selftest: ${passed}/${passed} checks passed`);
