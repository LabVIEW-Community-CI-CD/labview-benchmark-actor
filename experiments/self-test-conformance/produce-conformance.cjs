// LBA self-test transport conformance generator (OPTION 1, binary-strip-anchored),
// produced CROSS-PLATFORM. Proves that the mprr-self-test-transport-conformance-v1
// image-fidelity leg is NOT Windows-bound: the machine timing channel is the
// mprr-binary-strip-v1 strip, DECODED BY PIXEL INTENSITY (extractBinaryStripReading-
// FromPortableGrayMap: 8 sync 10100101 + 24 centisecond payload + 8 XOR checksum,
// dark<128 -> 1) -- pure Node, no Windows.Media.Ocr. See ADR-0007.
//
// Usage (Linux OR Windows):
//   LBA_MPRR_ROOT=/path/to/mprr [LBA_CONFORMANCE_OUT=/tmp/out] node produce-conformance.cjs
//   (on a runtime newer than .NET 8, prefix DOTNET_ROLL_FORWARD=LatestMajor)
//
// Binds the committed shared inputs (./inputs/, contract-a shapes). The committed
// receipt-linux.json + image-derived-timing.json + transport-output/ + strips/ are a
// SNAPSHOT from the Linux authoritative run (authoritativeOutcome=authoritative,
// missingComparisons=0, all maxAbsoluteSkew 0). Re-running writes fresh artifacts to
// LBA_CONFORMANCE_OUT (default: a temp dir) so the committed snapshot is never clobbered.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MPRR = process.env.LBA_MPRR_ROOT || process.env.VIHS_MPRR_ROOT;
if (!MPRR) { console.error('Set LBA_MPRR_ROOT to an mprr checkout (develop).'); process.exit(64); }
const INPUTS = path.join(__dirname, 'inputs');
const OUT = process.env.LBA_CONFORMANCE_OUT || process.env.VIHS_CONFORMANCE_OUT || path.join(os.tmpdir(), 'mprr-self-test-conformance-out');

const mod = require(path.join(MPRR, 'scripts', 'vmLiveStopwatchTimingValidation.js'));
const decode = mod.extractBinaryStripReadingFromPortableGrayMap;
const fmt = mod.formatStopwatchTextFromMilliseconds;
if (typeof decode !== 'function' || typeof fmt !== 'function') {
  throw new Error('mprr strip decoder/formatter not exported; exports=' + Object.keys(mod).join(','));
}

// encoder derived from the decoder spec (sync + 24-bit centiseconds + 8-bit XOR checksum)
function buildStripBits(cs) {
  const sync = '10100101';
  const payload = (cs >>> 0).toString(2).padStart(24, '0').slice(-24);
  const checksum = (((cs >> 16) & 0xff) ^ ((cs >> 8) & 0xff) ^ (cs & 0xff));
  return sync + payload + checksum.toString(2).padStart(8, '0');
}
// render 40 blocks to a REAL portable gray map (P5 PGM): bit '1' = dark(0), '0' = light(255)
function renderStripPgm(bits, file, blockW = 12, h = 16) {
  const W = bits.length * blockW;
  const header = `P5\n${W} ${h}\n255\n`;
  const body = Buffer.alloc(W * h);
  for (let y = 0; y < h; y += 1) {
    for (let bi = 0; bi < bits.length; bi += 1) {
      const v = bits[bi] === '1' ? 0 : 255;
      for (let dx = 0; dx < blockW; dx += 1) body[y * W + bi * blockW + dx] = v;
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'ascii'), body]));
}
function readPgm(file) {
  const buf = fs.readFileSync(file);
  let i = 0;
  const ws = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const token = () => { while (i < buf.length && ws(buf[i])) i += 1; let s = ''; while (i < buf.length && !ws(buf[i])) { s += String.fromCharCode(buf[i]); i += 1; } return s; };
  token(); const W = parseInt(token(), 10); const h = parseInt(token(), 10); token(); i += 1;
  return { width: W, height: h, pixels: Array.from(buf.subarray(i, i + W * h)) };
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'strips'), { recursive: true });

// 1) image-derived-timing via the REAL binary-strip render -> pixel-decode round-trip
const plan = [
  { id: 'stopwatch-010', cs: 10, relMs: 100 },
  { id: 'stopwatch-012', cs: 12, relMs: 120 },
  { id: 'stopwatch-015', cs: 15, relMs: 150 }
];
const timingSamples = plan.map((p) => {
  const bits = buildStripBits(p.cs);
  const pgm = path.join(OUT, 'strips', p.id + '.pgm');
  renderStripPgm(bits, pgm);
  const reading = decode(readPgm(pgm));
  if (reading.observedCentiseconds !== p.cs) throw new Error(`strip round-trip mismatch ${p.id}: ${reading.observedCentiseconds} != ${p.cs}`);
  return {
    sampleId: p.id,
    observedRelativeMilliseconds: p.relMs,
    observedCentiseconds: reading.observedCentiseconds,
    observedText: fmt(reading.observedMilliseconds),
    fidelity: {
      channel: 'mprr-binary-strip-v1',
      stripBits: bits,
      stripImage: path.posix.join('strips', p.id + '.pgm'),
      decodeMethod: 'extractBinaryStripReadingFromPortableGrayMap',
      colonOcr: 'human-only-not-machine-timing'
    }
  };
});
const imageDerivedTiming = {
  schemaVersion: 'mprr-self-test-image-derived-timing-v1',
  timingSamples,
  expectedTransportEvents: [
    { comparisonId: 'capture-start', expectedKind: 'governed-trigger', expectedRelativeMilliseconds: 0, expectedTextContains: 'capture-start' },
    { comparisonId: 'cursor-sample-1', expectedKind: 'cursor-sample', expectedRelativeMilliseconds: 101 },
    { comparisonId: 'click-1', expectedKind: 'click', expectedRelativeMilliseconds: 121 },
    { comparisonId: 'keyboard-1', expectedKind: 'keyboard', expectedRelativeMilliseconds: 151 },
    { comparisonId: 'capture-stop', expectedKind: 'governed-trigger', expectedRelativeMilliseconds: 152, expectedTextContains: 'capture-stop' }
  ]
};
const idtPath = path.join(OUT, 'image-derived-timing.json');
fs.writeFileSync(idtPath, JSON.stringify(imageDerivedTiming, null, 2) + '\n');

// 2) bind committed ground-truth + operator-events; local surface-metadata with ABSOLUTE
//    groundTruthLedgerPath (pre-fix2 workaround; mprr MR #137 fix2 accepts a relative ref)
const gtlPath = path.join(OUT, 'ground-truth-ledger.json');
fs.copyFileSync(path.join(INPUTS, 'ground-truth-ledger.json'), gtlPath);
const surfaceMeta = JSON.parse(fs.readFileSync(path.join(INPUTS, 'surface-metadata.json'), 'utf8'));
surfaceMeta.groundTruthLedgerPath = path.resolve(gtlPath);
const smPath = path.join(OUT, 'surface-metadata.json');
fs.writeFileSync(smPath, JSON.stringify(surfaceMeta, null, 2) + '\n');

// 3) recorder -> fixture-manifest + capture-bus (net8.0; DOTNET_ROLL_FORWARD if newer runtime)
const recOut = path.join(OUT, 'transport-output');
fs.mkdirSync(recOut, { recursive: true });
const rec = spawnSync('dotnet', ['run', '--project', path.join(MPRR, 'tools', 'review-capture-transport-recorder', 'ReviewCaptureTransportRecorder.csproj'), '-c', 'Release', '--', '--event-log-path', path.join(INPUTS, 'operator-events.jsonl'), '--output-dir', recOut, '--attempt-id', 'linux-conformance-prelim', '--target-fps', '12', '--captured-frame-count', '48', '--source-monitor-bounds-json', '{"x":0,"y":0,"width":1280,"height":800}'], { encoding: 'utf8', env: process.env });
if (rec.status !== 0) { console.error('RECORDER FAILED\n' + rec.stdout + '\n' + rec.stderr); process.exit(2); }
const recSummary = JSON.parse(rec.stdout);
const fixtureManifestPath = path.join(recOut, recSummary.fixtureManifestPath);
const captureBusPath = path.join(recOut, recSummary.captureBusPath);

// 4) comparator -> mprr-self-test-transport-conformance-v1
const receiptPath = path.join(OUT, 'self-test-transport-conformance-receipt.json');
const cmp = spawnSync('node', [path.join(MPRR, 'scripts', 'runReviewCaptureSelfTestTransportConformance.js'), '--ground-truth-ledger-path', gtlPath, '--surface-metadata-path', smPath, '--image-derived-timing-path', idtPath, '--fixture-manifest-path', fixtureManifestPath, '--capture-bus-path', captureBusPath, '--output-path', receiptPath, '--json'], { encoding: 'utf8', cwd: MPRR, env: process.env });
console.log(cmp.stdout || '');
if (cmp.stderr) console.log('stderr:\n' + cmp.stderr);
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
console.log(`\nRESULT: schemaVersion=${receipt.schemaVersion} authoritativeOutcome=${receipt.authoritativeOutcome} missingComparisons=${receipt.missingComparisons.length} maxImageSkew=${receipt.imageTimingComparison.maxAbsoluteSkewMilliseconds} maxTdmsSkew=${receipt.tdmsShortPacketTimingComparison.maxAbsoluteSkewMilliseconds} maxReaderSkew=${receipt.readerProjectionComparison.maxAbsoluteSkewMilliseconds}`);
process.exit(receipt.authoritativeOutcome === 'authoritative' ? 0 : 1);
