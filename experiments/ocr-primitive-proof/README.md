# WIN-side OCR-primitive proof (image-fidelity leg)

Goal: de-risk the single Windows-bound dependency of the mprr image-fidelity
conformance — `Windows.Media.Ocr` via the shipped
`scripts/readWindowsImageOcr.js` — on a **real native-Windows host**, ahead of
the authoritative golden-VM conformance run.

This is NOT the transport conformance receipt (that is the golden VM's job,
producing `mprr-self-test-transport-conformance-v1`). It isolates and proves the
OCR primitive the conformance depends on, and reports the portability gaps hit
when the OCR path is driven from native Windows PowerShell rather than a
WSL/VirtualBox host.

## What was run

1. `render-surface.ps1` renders a faithful mprr self-test surface (light
   background `250,250,248`, dark text: a stopwatch time, a 40-char bit stream,
   and a status line) to an **offscreen PNG** via `System.Drawing` — no
   fullscreen takeover.
2. `ocr-driver.js` drives the SHIPPED `mprr/scripts/readWindowsImageOcr.js`
   (`Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages()`) against
   that PNG and asserts the text reads back.

Reproduce (needs an mprr checkout + Windows PowerShell 5.1 + a display):

```
pwsh -NoProfile -File render-surface.ps1 -OutPath surface.png
# VIHS_MPRR_ROOT defaults to C:\dev\mprr
node ocr-driver.js surface.png "00:00:12.34"
```

## Findings

1. **OCR ENGINE IS FUNCTIONAL on a real Windows host.**
   `OcrEngine.TryCreateFromUserProfileLanguages()` returns a live engine;
   `AvailableRecognizerLanguages = [en-US]`; latency ~0.4–0.7 s per 1600×500
   frame. The 40-char digit bit stream read back **byte-exact** and the status
   sentence read back **exactly**. See `receipt.json`.

2. **TWO native-Windows portability gaps in the shipped interop** (relevant to
   running the OCR path from native Windows PowerShell rather than a WSL/VBox
   host — e.g. inside the Win11 VM guest invoked natively):
   - `runInstalledRuntimeVirtualBoxVmBootstrap.js#translateAnyPathToWindows`
     only maps `/mnt/*` paths (or shells `wslpath`); a native Windows path
     yields `null`, so `spawnPowerShellScript` throws *"Unable to translate
     PowerShell script path to a Windows path"*. Workaround: inject an identity
     `translateAnyPathToWindowsImpl`.
   - `virtualBoxHostInterop.js#spawnPowerShellScript` hardcodes `cwd: '/mnt/c'`,
     which does not exist on native Windows, so the spawn fails silently
     (empty stdout/stderr → *"Windows OCR execution failed."*). Workaround:
     inject a `spawnSyncImpl` that forces a valid Windows `cwd`.
   Both are injected as deps in `ocr-driver.js`; the OCR PowerShell logic
   itself is unchanged.

3. **Surface rendering + crop/scale is the real fidelity variable, not the
   engine.** A bold colon-formatted monospace time is fragile for whole-image
   OCR: at 64/48/40 pt the time line was dropped entirely; at 32 pt it read
   `ee : ee:12.34` (bold leading `00` misread as `ee`), while same-image digit
   and word lines read perfectly. Implication: the surface producer's time
   rendering plus `readWindowsImageOcr`'s `cropRelativeJson`+`scale` options
   materially drive OCR fidelity, and OCR should be treated as a **tolerant
   cross-check** against the authoritative `ground-truth-ledger`, not an exact
   string match.

## Environment

- Host: native Windows 11 dev host (not a VM, not WSL).
- Windows PowerShell 5.1 (`powershell.exe`) — required for the WinRT
  `Windows.Media.Ocr` projection; `pwsh` 7 cannot load it.
- mprr `develop`; `readWindowsImageOcr.js` driven verbatim via injected deps.
