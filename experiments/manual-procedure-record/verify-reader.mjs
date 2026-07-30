// verify-reader.mjs — self-test for the deterministic known-digit reader.
//
// Renders a large sample of counters, reads them back, and asserts BYTE-EXACT round-trip
// (render(n) -> read == n) — the deterministic-read claim behind the manual-procedure
// record's correlate-then-seal. Also proves the reader FAILS (throws) on a corrupted
// cell rather than guessing. Writes a machine-readable receipt.
//
//   node verify-reader.mjs        # exits 0 iff every case round-trips + the tamper case fails

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderCounter, readCounter } from './known-digit-reader.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const MIN_DIGITS = 6;
const cases = [];
for (let n = 0; n <= 5000; n++) cases.push(n); // dense low range (typical session counters)
for (const n of [9, 10, 99, 100, 999, 1000, 99999, 123456, 999999, 1000000, 9999999]) cases.push(n); // boundaries + width growth

let passed = 0;
const failures = [];
for (const n of cases) {
  let read;
  try {
    read = readCounter(renderCounter(n, MIN_DIGITS));
  } catch (e) {
    read = `ERR:${e.message}`;
  }
  if (read === n) passed += 1;
  else if (failures.length < 10) failures.push({ n, read });
}

// Negative control: a corrupted cell must THROW (deterministic failure, never a silent misread).
let tamperFailsClosed = false;
try {
  const bmp = renderCounter(123456, MIN_DIGITS);
  bmp.rows[2] = bmp.rows[2].replace(/./, (c) => (c === '1' ? '0' : '1')); // flip one pixel in the first cell
  readCounter(bmp);
} catch {
  tamperFailsClosed = true;
}

const total = cases.length;
const roundTripOk = passed === total;
const verdict = roundTripOk && tamperFailsClosed ? 'PASS' : 'FAIL';

const receipt = {
  schema: 'labview-benchmark-actor/known-digit-reader-receipt-v1',
  ranAt: new Date().toISOString(),
  minDigits: MIN_DIGITS,
  total,
  passed,
  failed: total - passed,
  roundTripByteExact: roundTripOk,
  tamperFailsClosed,
  sampleFailures: failures,
  verdict,
};
writeFileSync(join(here, 'reader-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

console.log(`known-digit-reader: ${passed}/${total} byte-exact round-trips; tamper-fails-closed=${tamperFailsClosed}; verdict=${verdict}`);
if (failures.length) console.log('sample failures:', JSON.stringify(failures));
process.exit(verdict === 'PASS' ? 0 : 1);
