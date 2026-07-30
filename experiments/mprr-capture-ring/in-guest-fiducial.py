#!/usr/bin/env python3
# in-guest-fiducial.py — the GUEST-side renderer of the visual dual-clock. Runs INSIDE the VM and paints a
# host-agreed "stopwatch" fiducial to the guest framebuffer (/dev/fb0), advancing it on the GUEST monotonic
# clock. The host captures the guest display over VNC and reads which step each frame shows (by dhash), pairing
# guest-display-time with host-capture-time -> the VISUAL analog of the boot-benchmark dual-clock (the guest
# clock read straight off the pixels). See experiments/mprr-capture-ring/visual-dual-clock.mjs (host side).
#
# Pure Python 3 stdlib (the guest has no Node). Renders the SAME pattern as WIN's fiducial-vnc-server.mjs
# fiducialFrame: 8 vertical grayscale bands, a fixed lit CENTER band (band 4) so no frame is uniform, the other
# 7 bands carry the low 7 bits of `tick`. Grayscale => the framebuffer's R/B byte order is irrelevant.
#
#   sudo systemctl stop gdm    # free the display so /dev/fb0 writes are visible + stable (no compositor)
#   sudo python3 in-guest-fiducial.py --ticks 0,1,2,4,5,16,17,18,20,21,32,33 --interval-ms 400
#
# Emits one line per step to stdout (the guest-side ground truth the host correlates against):
#   FIDUCIAL step=<s> tick=<t> guestMonoNs=<CLOCK_MONOTONIC ns>
import argparse
import mmap
import os
import time

BANDS = 8
ANCHOR = BANDS // 2  # 4 — always lit


def band_on(tick, b):
    if b == ANCHOR:
        return True
    bit = b if b < ANCHOR else b - 1  # bands 0..3 -> bits 0..3; bands 5..7 -> bits 4..6
    return ((tick >> bit) & 1) == 1


def make_row(tick, width):
    band_w = width // BANDS
    row = bytearray(width * 4)
    for x in range(width):
        b = min(BANDS - 1, x // band_w)
        v = 230 if band_on(tick, b) else 20
        o = x * 4
        row[o] = v
        row[o + 1] = v
        row[o + 2] = v
        row[o + 3] = 255
    return bytes(row)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ticks', required=True, help='comma-separated tick sequence (host-agreed, distinct dhashes)')
    ap.add_argument('--interval-ms', type=int, default=400)
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=800)
    ap.add_argument('--stride', type=int, default=0, help='0 => width*4')
    ap.add_argument('--fb', default='/dev/fb0')
    a = ap.parse_args()

    ticks = [int(t) for t in a.ticks.split(',') if t != '']
    stride = a.stride or a.width * 4
    fb_size = stride * a.height
    fd = os.open(a.fb, os.O_RDWR)
    mm = mmap.mmap(fd, fb_size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)

    interval_ns = a.interval_ms * 1_000_000
    start = time.monotonic_ns()
    for step, tick in enumerate(ticks):
        row = make_row(tick, a.width)
        rl = len(row)
        for y in range(a.height):
            off = y * stride
            mm[off:off + rl] = row  # leave any stride padding untouched
        mm.flush()
        print(f"FIDUCIAL step={step} tick={tick} guestMonoNs={time.monotonic_ns()}", flush=True)
        target = start + (step + 1) * interval_ns
        while True:
            now = time.monotonic_ns()
            if now >= target:
                break
            time.sleep(min(0.02, (target - now) / 1e9))

    mm.close()
    os.close(fd)


if __name__ == '__main__':
    main()
