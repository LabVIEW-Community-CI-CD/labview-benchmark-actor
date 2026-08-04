// Transient test shim (NOT part of the repo tree; lives under C:\lba-validate, outside the checkout).
// Masks ONLY the two LabVIEW.exe candidate paths in fs.existsSync so resolveLabview() returns null on this
// real-LabVIEW WIN host -- reproducing the LabVIEW-less CI condition that the captureLaunch not-found
// assertion is written for. No repo/source/test file is modified. Used via: node --require <thisfile>.
const fs = require('fs');
const realExistsSync = fs.existsSync.bind(fs);
const MASKED = new Set([
  'C:\\Program Files (x86)\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
  'C:\\Program Files\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
]);
fs.existsSync = function (p) {
  try { if (MASKED.has(String(p))) return false; } catch { /* fall through to real */ }
  return realExistsSync(p);
};
