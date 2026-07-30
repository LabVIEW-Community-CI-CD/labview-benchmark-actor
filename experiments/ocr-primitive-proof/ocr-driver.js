// WIN-side OCR-primitive proof driver.
// Drives the SHIPPED mprr scripts/readWindowsImageOcr.js (Windows.Media.Ocr via
// PowerShell) against a rendered stopwatch-surface PNG on a real Windows host
// and asserts the surface time text reads back.
//
// Requires: an mprr checkout (LBA_MPRR_ROOT, default C:\dev\mprr) and Windows
// PowerShell 5.1 (the WinRT Windows.Media.Ocr projection does not load in pwsh 7).
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mprrRoot = process.env.LBA_MPRR_ROOT || process.env.VIHS_MPRR_ROOT || 'C:/dev/mprr';
const { readWindowsImageOcr } = require(path.join(mprrRoot, 'scripts', 'readWindowsImageOcr.js'));

const imagePath = process.argv[2] || path.join(process.env.TEMP || '.', 'ocr-proof', 'surface.png');
const expectTime = process.argv[3] || '00:00:12.34';

// On a NATIVE-Windows host the mprr interop's WSL/VBox assumptions do not apply:
//  (1) translateAnyPathToWindows only maps /mnt/* paths -> inject identity;
//  (2) spawnPowerShellScript hardcodes cwd:'/mnt/c' -> force a valid Windows cwd.
// The OCR PowerShell logic itself is unchanged.
const winCwd = (process.env.SystemDrive || 'C:') + '\\';
const deps = {
  translateAnyPathToWindowsImpl: (p) => p,
  powerShellCommand: 'powershell',
  spawnSyncImpl: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, cwd: winCwd })
};

const started = Date.now();
let result;
try {
  result = readWindowsImageOcr(imagePath, {}, deps);
} catch (err) {
  console.error('OCR_ERROR: ' + (err && err.message ? err.message : String(err)));
  process.exit(3);
}
const ms = Date.now() - started;

const text = String((result && result.text) || '');
const normalized = text.replace(/\s+/g, ' ').trim();
const expectDigits = expectTime.replace(/[^0-9]/g, '');
const gotDigits = normalized.replace(/[^0-9]/g, '');
const timeHit = normalized.includes(expectTime) || gotDigits.includes(expectDigits);

console.log(JSON.stringify({
  schema: 'lba/ocr-primitive-proof@1',
  host: 'windows-native',
  imagePath,
  ocrMs: ms,
  width: result.width,
  height: result.height,
  lineCount: Array.isArray(result.lines) ? result.lines.length : 0,
  expectTime,
  expectDigits,
  gotDigits,
  ocrTextNormalized: normalized,
  timeReadBack: timeHit
}, null, 2));
process.exit(timeHit ? 0 : 2);
