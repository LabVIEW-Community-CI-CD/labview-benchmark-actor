// perActorProcSampler.mjs -- sample a set of live mesh ACTOR processes at EXACTLY 12 FPS, reading each actor's
// OWN /proc/<pid>/stat CPU time (utime+stime) + thread count, so N actors stressed SIMULTANEOUSLY each get a
// frame-locked per-actor series. The 12-FPS loop is wall-clock target-locked (target = t0 + k*period) so the
// effective rate holds at 12 even under scheduling jitter -- the same discipline as linuxProcSampler. Node
// builtins only; deterministic given the same process CPU behaviour.

import { readFileSync } from 'node:fs';

export const CLK_TCK = 100; // getconf CLK_TCK on Linux (jiffies per second)

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const round2 = (x) => Math.round(x * 100) / 100;
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Read an actor's cumulative CPU jiffies (utime+stime) + OS thread count from /proc/<pid>/stat. Robust to the
 * comm field (field 2, parenthesised) containing spaces/parens: parse everything after the LAST ')'.
 */
export function readProcStat(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  // after comm, index = (field number - 3): state=field3->0, utime=field14->11, stime=field15->12, threads=field20->17
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const threads = Number(rest[17]);
  return {
    jiffies: (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0),
    threads: Number.isFinite(threads) ? threads : 0,
  };
}

function safeStat(pid) {
  try { return readProcStat(pid); } catch { return { jiffies: 0, threads: 0 }; }
}

/**
 * Capture a per-actor frame-locked series at frameRateHz. Each frame reads every actor's /proc CPU delta and
 * converts it to cpuPoolPct = (busy-core-equivalents / poolSize) * 100 -- a 0..100% "fraction of this actor's
 * own core budget" signal that is directly comparable across actors with different pool sizes.
 * @param {{actors:Array<{actor:string,pid:number,poolSize:number}>, frameRateHz?:number, samples?:number, clkTck?:number}} p
 */
export async function captureActors({ actors, frameRateHz = 12, samples = 48, clkTck = CLK_TCK }) {
  const periodMs = 1000 / frameRateHz;
  const prev = new Map();
  const series = new Map(actors.map((a) => [a.actor, []]));
  const t0 = Date.now();
  for (const a of actors) prev.set(a.pid, { jiffies: safeStat(a.pid).jiffies, epochMs: t0 });
  const phaseErrors = [];

  for (let k = 1; k <= samples; k += 1) {
    const target = t0 + k * periodMs;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    phaseErrors.push(Math.abs(now - target));
    for (const a of actors) {
      const st = safeStat(a.pid);
      const p = prev.get(a.pid);
      const dJ = Math.max(0, st.jiffies - p.jiffies);
      const dS = (now - p.epochMs) / 1000;
      const busyCores = dS > 0 ? dJ / clkTck / dS : 0; // fully-busy-core equivalents this frame
      const cpuPoolPct = Math.max(0, Math.min(100, (busyCores / Math.max(1, a.poolSize)) * 100));
      series.get(a.actor).push({ epochMs: now, frameIndex: k - 1, counters: { cpuPoolPct: round2(cpuPoolPct), threadCount: st.threads } });
      prev.set(a.pid, { jiffies: st.jiffies, epochMs: now });
    }
  }

  const elapsedS = (Date.now() - t0) / 1000;
  const effectiveFps = elapsedS > 0 ? samples / elapsedS : 0;
  return {
    frameRateHz,
    measured: {
      effectiveFps: round2(effectiveFps),
      exactly12fps: Math.abs(effectiveFps - frameRateHz) < 0.5,
      medianPhaseErrorMs: round2(median(phaseErrors)),
      maxPhaseErrorMs: round2(Math.max(0, ...phaseErrors)),
    },
    actors: actors.map((a) => ({ actor: a.actor, poolSize: a.poolSize, samples: series.get(a.actor) })),
  };
}
