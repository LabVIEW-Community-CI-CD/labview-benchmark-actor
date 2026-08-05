#!/usr/bin/env python3
# vbox-sdk-capture.py -- WIN-plane visual-ring capturer via the VirtualBox SDK (vboxapi).
#
# WHY THIS EXISTS: VirtualBox's VRDE VNC server is BLIND to the Windows guest's WDDM framebuffer -- it streams a
# near-black screen (verified: every pixel [0,0,0]/[1,1,1]) even while the guest renders normally, so the RFB
# capture core (vnc-source.mjs) that measures the LINUX plane cannot see a Windows LabVIEW launch. The VBox SDK's
# IDisplay.takeScreenShotToArray(RGBA), by contrast, reads the REAL composited guest screen in-process (~17fps).
#
# WHAT IT DOES: for each iteration it triggers a cold LabVIEW launch (scheduled task, so LabVIEW renders in the
# interactive session-1 desktop the screenshot captures -- NOT session 0), samples the framebuffer at a governed
# cadence, and computes the PINNED dhash-64 (fingerprint.mjs spec, re-implemented here and CROSS-VALIDATED
# byte-identical to Node's dhash64FromRgba). It emits the SAME {ms,dhashHex} frame stream the LINUX VBox-VNC
# runner emits, so Node runs the SAME gated settle-detect + trend on both planes. Only the capture TRANSPORT
# differs (SDK screenshot vs RFB) -- an acknowledged cross-plane capture-path bias (launch durations are compared
# as a witness, never hard-gated). The launch trigger is SSH-driven (same as the LINUX/VNC runners).
#
#   Env: LBA_VM(actor) LBA_SSH_KEY(~/.ssh/lba_scratch) LBA_SSH_PORT(2200) LBA_SSH_USER(vagrant)
#        LBA_WIN_TASK(LBA-LaunchLabVIEW) LBA_WIN_KILL_CMD LBA_WIN_LAUNCH_CMD
#        LBA_ITERATIONS(3) LBA_DURATION_MS(16000) LBA_FPS(12) LBA_OUT(<frames json>)
#   Prereqs: the VirtualBox SDK python bindings (vboxapi, shipped with VirtualBox); the `actor` VM RUNNING with a
#   logged-in interactive desktop; OpenSSH to the guest; and the LBA-LaunchLabVIEW scheduled task registered.
import time, os, json, subprocess

OUT_W, OUT_H = 9, 8  # dhash-64 grid: 9 cols -> 8 horizontal compares per row, 8 rows -> 64 bits (fingerprint.mjs)

def dhash_hex(buf, w, h):
    # PINNED dhash-64 (fingerprint.mjs): nearest-neighbor 9x8 sample, integer Rec.601 luma (77R+150G+29B)>>8,
    # row-major g[x]>g[x+1] compares, MSB-first hex. Cross-validated byte-identical to Node dhash64FromRgba.
    gray = []
    for oy in range(OUT_H):
        sy = (oy * h) // OUT_H
        for ox in range(OUT_W):
            sx = (ox * w) // OUT_W
            p = (sy * w + sx) * 4
            gray.append((77 * buf[p] + 150 * buf[p + 1] + 29 * buf[p + 2]) >> 8)
    bits = []
    for oy in range(OUT_H):
        for ox in range(OUT_W - 1):
            bits.append(1 if gray[oy * OUT_W + ox] > gray[oy * OUT_W + ox + 1] else 0)
    s = ''
    for i in range(0, 64, 4):
        s += format((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3], 'x')
    return s

SSH_KEY = os.environ.get('LBA_SSH_KEY', os.path.expanduser('~/.ssh/lba_scratch'))
SSH_PORT = os.environ.get('LBA_SSH_PORT', '2200')
SSH_USER = os.environ.get('LBA_SSH_USER', 'vagrant')
VM = os.environ.get('LBA_VM', 'actor')
TASK = os.environ.get('LBA_WIN_TASK', 'LBA-LaunchLabVIEW')
KILL = os.environ.get('LBA_WIN_KILL_CMD', 'taskkill /F /IM LabVIEW.exe')
LAUNCH = os.environ.get('LBA_WIN_LAUNCH_CMD', 'schtasks /run /tn ' + TASK)
ITERS = int(os.environ.get('LBA_ITERATIONS', '3'))
DUR = int(os.environ.get('LBA_DURATION_MS', '16000'))
FPS = int(os.environ.get('LBA_FPS', '12'))
OUT = os.environ.get('LBA_OUT', '/tmp/win-sdk-frames.json')

def ssh(cmd, wait=True):
    args = ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12', '-i', SSH_KEY, '-p', SSH_PORT, SSH_USER + '@127.0.0.1', cmd]
    if wait:
        subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return None
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def ssh_out(cmd):
    args = ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12', '-i', SSH_KEY, '-p', SSH_PORT, SSH_USER + '@127.0.0.1', cmd]
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode('utf-8', 'ignore')

def ensure_labview_closed(timeout_s=12):
    # Cold pre-clean: kill LabVIEW, then POLL until it is ACTUALLY gone. A FIXED wait races the relaunch and can
    # leave the Getting-Started window on screen for the whole capture -> a static frame -> a bogus ~60ms settle
    # (settle-detect pins the first frame). Polling guarantees a true cold desktop before each launch.
    ssh(KILL + ' 2>NUL & exit 0', wait=True)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if 'LabVIEW.exe' not in ssh_out('tasklist /fi "IMAGENAME eq LabVIEW.exe" 2>NUL'):
            return True
        time.sleep(0.5)
    return False

def hamming_hex(a, b):
    d = 0
    for ca, cb in zip(a, b):
        x = int(ca, 16) ^ int(cb, 16)
        while x:
            d += x & 1
            x >>= 1
    return d

from vboxapi import VirtualBoxManager
mgr = VirtualBoxManager()
vbox = mgr.getVirtualBox()
const = mgr.constants
machine = vbox.findMachine(VM)
try:
    session = mgr.getSessionObject(vbox)
except TypeError:
    session = mgr.getSessionObject()
machine.lockMachine(session, const.LockType_Shared)
records = []
try:
    display = session.console.display
    keyboard = session.console.keyboard
    fmt = const.BitmapFormat_RGBA
    period = 1.0 / FPS
    for it in range(ITERS):
        rec = None
        max_delta = 0
        for attempt in range(5):
            ensure_labview_closed()  # kill + POLL-until-gone
            res = display.getScreenResolution(0)
            w, h = int(res[0]), int(res[1])
            # Win+D (show desktop) to clear the STALE Getting-Started pixels a killed LabVIEW leaves in the WDDM
            # framebuffer. Win+D TOGGLES, so a given press may not land on "bare" -- we DON'T trust it. Instead we
            # VALIDATE below that the capture actually saw a desktop->GS transition and RETRY if not; the toggle
            # flips each attempt, so a bare-start attempt lands within a couple of tries.
            keyboard.putScancodes([0xE0, 0x5B, 0x20, 0xA0, 0xE0, 0xDB])
            time.sleep(1.2)
            frames = []
            launch_start_ms = int(time.time() * 1000)  # host clock (matches Date.now() on the LINUX runner)
            ssh(LAUNCH + ' & echo TRIGGERED', wait=False)  # fire-and-continue so capture spans the launch
            t_end = time.time() + DUR / 1000.0
            while time.time() < t_end:
                tick = time.time()
                data = display.takeScreenShotToArray(0, w, h, fmt)
                frames.append({'ms': int(time.time() * 1000), 'dhashHex': dhash_hex(data, w, h)})
                sl = period - (time.time() - tick)
                if sl > 0:
                    time.sleep(sl)
            # A real cold launch (desktop->splash->Getting-Started) moves the whole-screen dhash a lot. If the frames
            # barely change, the pre-launch frame was a STALE GS (no delta) -> static-screen artifact -> retry.
            first = frames[0]['dhashHex']
            max_delta = max((hamming_hex(fr['dhashHex'], first) for fr in frames), default=0)
            if max_delta >= 6:
                rec = {'launchStartMs': launch_start_ms, 'frames': frames, 'res': [w, h]}
                break
            print('iter %d attempt %d: static capture (maxHamming=%d) -> retry' % (it + 1, attempt + 1, max_delta))
        if rec is None:
            raise SystemExit('iter %d: no real launch transition captured after retries (framebuffer stuck?)' % (it + 1))
        records.append(rec)
        print('iter %d/%d: %d frames, res %dx%d (maxHamming=%d)' % (it + 1, ITERS, len(rec['frames']), rec['res'][0], rec['res'][1], max_delta))
finally:
    session.unlockMachine()
with open(OUT, 'w') as f:
    json.dump(records, f)
print('wrote %s (%d iterations)' % (OUT, len(records)))
