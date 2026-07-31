#!/usr/bin/env python3
# in-guest resource sampler (LBA-REQ-011 live capture + sampling). Samples SYSTEM-WIDE CPU% / RAM-MB /
# disk-util% every INTERVAL ms, each stamped with the GUEST epoch-ms wall clock, and appends one JSON object
# per line (JSONL) so the host orchestrator can correlate the series to the visual-ring frame timeline.
#
# Guest-only deps: Python 3 stdlib + /proc (the scratch VM has Python 3.12, no Node). Metrics:
#   cpuPct  = 100 * (1 - idle_delta / total_delta)      from /proc/stat   (idle + iowait)
#   ramMb   = (MemTotal - MemAvailable) / 1024           from /proc/meminfo
#   diskPct = io_ms_delta / wall_ms * 100 (clamped 100)  from /proc/diskstats field 10 (time doing I/Os, ms),
#             summed over WHOLE physical block devices (sdX / vdX / xvdX / nvmeXnY), partitions/loop/ram skipped.
#
# Usage: python3 in-guest-resource-sampler.py <out.jsonl> <durationMs> [intervalMs=100]
import sys, time, json, re

DEV_RE = re.compile(r'^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$')


def read_cpu():
    with open('/proc/stat') as f:
        parts = f.readline().split()
    vals = list(map(int, parts[1:]))
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
    return sum(vals), idle


def read_ram_mb():
    mt = ma = None
    with open('/proc/meminfo') as f:
        for line in f:
            if line.startswith('MemTotal:'):
                mt = int(line.split()[1])
            elif line.startswith('MemAvailable:'):
                ma = int(line.split()[1])
            if mt is not None and ma is not None:
                break
    if mt is None or ma is None:
        return None
    return round((mt - ma) / 1024.0, 1)  # KB -> MB


def read_disk_io_ms():
    total = 0
    with open('/proc/diskstats') as f:
        for line in f:
            p = line.split()
            if len(p) > 12 and DEV_RE.match(p[2]):
                total += int(p[12])  # field 10 (0-based index 12): time spent doing I/Os (ms)
    return total


def main():
    out = sys.argv[1]
    duration_ms = int(sys.argv[2])
    interval_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    end = time.time() + duration_ms / 1000.0
    prev_total, prev_idle = read_cpu()
    prev_io = read_disk_io_ms()
    prev_t = time.time()
    with open(out, 'w') as fo:
        while time.time() < end:
            time.sleep(interval_ms / 1000.0)
            now = time.time()
            total, idle = read_cpu()
            dt_total = total - prev_total
            dt_idle = idle - prev_idle
            cpu_pct = round(100.0 * (1 - dt_idle / dt_total), 1) if dt_total > 0 else None
            io = read_disk_io_ms()
            wall_ms = (now - prev_t) * 1000.0
            disk_pct = round(min(100.0, (io - prev_io) / wall_ms * 100.0), 1) if wall_ms > 0 else None
            fo.write(json.dumps({
                'epochMs': int(now * 1000),
                'cpuPct': cpu_pct,
                'ramMb': read_ram_mb(),
                'diskPct': disk_pct,
            }) + '\n')
            fo.flush()
            prev_total, prev_idle, prev_io, prev_t = total, idle, io, now


if __name__ == '__main__':
    main()
