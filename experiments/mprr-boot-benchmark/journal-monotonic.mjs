// journal-monotonic.mjs — parse `journalctl -o short-monotonic` into the AUTHORITATIVE guest milestone times.
//
// Per the LINUX<->WIN design, the timing numbers of record come from the guest's CLOCK_MONOTONIC via journald,
// NOT the serial arrival clock (serial is buffered/flushed and jitters). The recorder runs ONE post-MESH-OK
// read in the guest:
//
//     journalctl -o short-monotonic -u lba-lbabus-build.service -u lba-mesh -t lbabench
//
// short-monotonic lines look like:  `[   21.234567] host unit[pid]: <message>`
// The leading `[ seconds ]` IS the guest CLOCK_MONOTONIC since boot. We match each milestone to a known log
// line and take that timestamp. BUILD-START/BUILT/MESH-OK use the unit lines that ALREADY exist (no new
// instrumentation); BOOT-START uses the marker the early emit drop-in loggers to the journal.

// Default matchers (first matching line wins per milestone). Substrings/regexes are case-insensitive.
export const DEFAULT_MATCHERS = {
  'BOOT-START': /LBABENCH\s+BOOT-START|lbabench.*boot-start/i,
  'LBABUS-BUILD-START': /building lbabus/i,
  'LBABUS-BUILT': /lbabus built/i,
  'MESH-OK': /MESH OK/i,
};

const TS_RE = /^\s*\[\s*(\d+(?:\.\d+)?)\]\s*(.*)$/;

/** Parse one short-monotonic line -> { monotonicMs, message } or null. */
export function parseShortMonotonicLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(TS_RE);
  if (!m) return null;
  return { monotonicMs: Math.round(Number.parseFloat(m[1]) * 1000), message: m[2] };
}

function toTester(matcher) {
  if (matcher instanceof RegExp) return (s) => matcher.test(s);
  const needle = String(matcher).toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

/**
 * Parse a `journalctl -o short-monotonic` dump into { <caseId>: guestMonotonicMs } for the milestones whose
 * matcher first matches a line. Milestones with no matching line are simply absent (the seal then fails
 * closed on the missing authoritative time — determinism).
 * @param {string} text journalctl short-monotonic output
 * @param {Record<string, RegExp|string>} [matchers] caseId -> line matcher (defaults DEFAULT_MATCHERS)
 * @returns {Record<string, number>}
 */
export function parseJournalMonotonic(text, matchers = DEFAULT_MATCHERS) {
  const testers = Object.entries(matchers).map(([caseId, m]) => ({ caseId, test: toTester(m) }));
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const parsed = parseShortMonotonicLine(line);
    if (!parsed) continue;
    for (const { caseId, test } of testers) {
      if (out[caseId] === undefined && test(parsed.message)) out[caseId] = parsed.monotonicMs;
    }
  }
  return out;
}
