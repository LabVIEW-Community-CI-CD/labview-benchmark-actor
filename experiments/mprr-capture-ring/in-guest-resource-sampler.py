#!/usr/bin/env python3
# in-guest resource sampler (LBA-REQ-011 live capture + sampling). Samples SYSTEM-WIDE CPU% / RAM-MB /
# disk-util% every INTERVAL ms, each stamped with the GUEST epoch-ms wall clock, and appends one JSON object
# per line (JSONL) so the host orchestrator can correlate the series to the visual-ring frame timeline. Each line
# ALSO carries a v2 counters{} object -- the full Linux /proc catalog subset, key-for-key at PARITY with the host
# linuxProcSampler -- so a Linux actor emits the same performance-counter-correlation@v2 shape a Windows PDH actor does.
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


def read_full_snapshot(now):
    # Cumulative /proc + /sys counters for the v2 catalog, mirroring linuxProcSampler.readProcSnapshot so a Linux
    # actor emits the SAME counters{} keys a Windows PDH actor does (performance-counter-correlation@v2).
    with open('/proc/stat') as f:
        stat = f.read()
    cpu_line = next((l for l in stat.split('\n') if l.startswith('cpu ')), 'cpu 0 0 0 0 0 0 0 0')
    j = [int(x) for x in cpu_line.split()[1:]]
    while len(j) < 8:
        j.append(0)
    user, nice, system, idle, iowait = j[0], j[1], j[2], j[3], j[4]
    cpu_total = sum(j[:8])
    cpu_busy = cpu_total - idle - iowait
    ctxt = procs_running = 0
    for l in stat.split('\n'):
        if l.startswith('ctxt '):
            ctxt = int(l.split()[1])
        elif l.startswith('procs_running '):
            procs_running = int(l.split()[1])
    mem_total = mem_avail = committed = 0
    with open('/proc/meminfo') as f:
        for l in f:
            if l.startswith('MemTotal:'):
                mem_total = int(l.split()[1])
            elif l.startswith('MemAvailable:'):
                mem_avail = int(l.split()[1])
            elif l.startswith('Committed_AS:'):
                committed = int(l.split()[1])
    d_reads = d_sread = d_writes = d_swrite = 0
    with open('/proc/diskstats') as f:
        for l in f:
            p = l.split()
            if len(p) > 9 and DEV_RE.match(p[2]):
                d_reads += int(p[3]); d_sread += int(p[5]); d_writes += int(p[7]); d_swrite += int(p[9])
    rx = tx = 0
    with open('/proc/net/dev') as f:
        for l in f:
            if ':' not in l:
                continue
            name, rest = l.split(':', 1)
            if name.strip() == 'lo':
                continue
            c = rest.split()
            if len(c) >= 9:
                rx += int(c[0]); tx += int(c[8])
    with open('/proc/loadavg') as f:
        load1 = float(f.read().split()[0])
    return {
        't': now,
        'cpuTotal': cpu_total, 'cpuBusy': cpu_busy, 'user': user + nice, 'system': system,
        'ctxt': ctxt, 'dReads': d_reads, 'dSread': d_sread, 'dWrites': d_writes, 'dSwrite': d_swrite,
        'rx': rx, 'tx': tx, 'procsRunning': procs_running, 'load1': load1,
        'memTotal': mem_total, 'memAvail': mem_avail, 'committed': committed,
    }


def counters_from(prev, cur):
    # v2 counters{} sample (rates over the measured interval), matching linuxProcSampler.sampleFromSnapshots.
    dt_sec = cur['t'] - prev['t']
    d_total = cur['cpuTotal'] - prev['cpuTotal']

    def pct(d):
        return round(d / d_total * 100.0, 3) if d_total > 0 else None

    def rate(key, mult=1):
        return round((cur[key] - prev[key]) * mult / dt_sec, 2) if dt_sec > 0 else None

    mt, ma = cur['memTotal'], cur['memAvail']
    return {
        'cpuTotalPct': pct(cur['cpuBusy'] - prev['cpuBusy']),
        'cpuUserPct': pct(cur['user'] - prev['user']),
        'cpuPrivilegedPct': pct(cur['system'] - prev['system']),
        'contextSwitchesPerSec': rate('ctxt'),
        'memAvailableMb': round(ma / 1024.0, 1),
        'memCommittedBytes': cur['committed'] * 1024,
        'memCommittedInUsePct': round((1 - ma / mt) * 100.0, 2) if mt > 0 else None,
        'diskReadsPerSec': rate('dReads'),
        'diskWritesPerSec': rate('dWrites'),
        'diskReadBytesPerSec': rate('dSread', 512),
        'diskWriteBytesPerSec': rate('dSwrite', 512),
        'netBytesReceivedPerSec': rate('rx'),
        'netBytesSentPerSec': rate('tx'),
        'procsRunning': cur['procsRunning'],
        'loadAvg1': cur['load1'],
    }


def main():
    out = sys.argv[1]
    duration_ms = int(sys.argv[2])
    interval_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    end = time.time() + duration_ms / 1000.0
    prev_total, prev_idle = read_cpu()
    prev_io = read_disk_io_ms()
    prev_t = time.time()
    prev_snap = read_full_snapshot(prev_t)
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
            cur_snap = read_full_snapshot(now)
            fo.write(json.dumps({
                'epochMs': int(now * 1000),
                'cpuPct': cpu_pct,
                'ramMb': read_ram_mb(),
                'diskPct': disk_pct,
                'counters': counters_from(prev_snap, cur_snap),  # v2 42-counter catalog (Linux /proc subset)
            }) + '\n')
            fo.flush()
            prev_total, prev_idle, prev_io, prev_t = total, idle, io, now
            prev_snap = cur_snap


if __name__ == '__main__':
    main()
