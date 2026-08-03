// handoffRequest.mjs -- the Handoff Beacon agent<->human request payloads (LBA-REQ-056, ADR-0036).
//
// The reviewer VM exists because some steps need a human. The capture-status beacon (LBA-REQ-055) let the AGENT
// AWAIT a human step (Stop). This closes the OTHER direction of the Handoff Beacon Protocol (ADR-0035): the agent
// ASKS the human to perform a manual step, and the ask surfaces IN the VM as a VS Code notification with a
// "Mark step done" action -- a reusable human-step BARRIER for any manual op (activate LabVIEW, run a VI, log in
// to VIPM, ...), not a one-off. Two payloads:
//   - agent-request@1: the agent's ask   { id, title, body, kind, createdAt }        -> handoff/requests/<id>.json
//   - op-done@1:       the human's answer { id, requestId, outcome, note, doneAt }    -> handoff/done/<id>.json
// The agent writes the request (host-side, via the VM bridge) and then polls handoff/done/ ONCE (the one
// sanctioned poll in the flow) for the op-done answer.
//
// PURE + deterministic (no Node built-ins) so it is unit-testable + gated, and stageable into the extension's
// media/ dir (loaded like captureStatus.mjs).

export const AGENT_REQUEST_SCHEMA = 'labview-benchmark-actor/agent-request@1';
export const OP_DONE_SCHEMA = 'labview-benchmark-actor/op-done@1';
export const OP_DONE_OUTCOMES = Object.freeze(['done', 'skipped']);
export const REQUEST_KINDS = Object.freeze(['step', 'ack']);

const str = (v, dflt = null) => (v != null ? String(v) : dflt);

/**
 * Build an agent->human request beacon. `id` should be stable (the op-done keys off it); `title` is the
 * one-line ask shown in the notification, `body` the optional detail. `kind` is 'step' (do a manual step)
 * or 'ack' (just acknowledge).
 */
export function buildAgentRequest(opts = {}) {
  const kind = REQUEST_KINDS.includes(opts.kind) ? opts.kind : 'step';
  return {
    schema: AGENT_REQUEST_SCHEMA,
    id: str(opts.id),
    title: str(opts.title, ''),
    body: str(opts.body, ''),
    kind,
    createdAt: str(opts.createdAt),
  };
}

/** Build the human's op-done answer to a request (outcome 'done' or 'skipped', with an optional note). */
export function buildOpDone(opts = {}) {
  const outcome = OP_DONE_OUTCOMES.includes(opts.outcome) ? opts.outcome : 'done';
  const note = opts.note != null && String(opts.note).length ? String(opts.note) : null;
  return {
    schema: OP_DONE_SCHEMA,
    id: str(opts.id, str(opts.requestId)), // op-done id defaults to the request id (one answer per request)
    requestId: str(opts.requestId),
    outcome,
    note,
    doneAt: str(opts.doneAt),
  };
}

/** Fail-closed shape check for an agent-request beacon before the extension surfaces it. */
export function validateAgentRequest(req) {
  const errors = [];
  const r = req && typeof req === 'object' ? req : {};
  if (r.schema !== AGENT_REQUEST_SCHEMA) errors.push(`schema must be ${AGENT_REQUEST_SCHEMA}`);
  if (!r.id || typeof r.id !== 'string') errors.push('agent-request needs a non-empty string id');
  if (typeof r.title !== 'string' || !r.title.length) errors.push('agent-request needs a non-empty title');
  if (r.kind != null && !REQUEST_KINDS.includes(r.kind)) errors.push(`kind must be one of ${REQUEST_KINDS.join('|')}`);
  return { ok: errors.length === 0, errors };
}

/** Fail-closed shape check for an op-done beacon before a consumer (the awaiting agent) trusts it. */
export function validateOpDone(done) {
  const errors = [];
  const d = done && typeof done === 'object' ? done : {};
  if (d.schema !== OP_DONE_SCHEMA) errors.push(`schema must be ${OP_DONE_SCHEMA}`);
  if (!d.requestId || typeof d.requestId !== 'string') errors.push('op-done needs a requestId');
  if (!OP_DONE_OUTCOMES.includes(d.outcome)) errors.push(`outcome must be one of ${OP_DONE_OUTCOMES.join('|')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * Select the newest PENDING request from a list of parsed request objects: validated, and its id NOT already
 * in `answeredIds` (the ids that have an op-done). Deterministic -- sorts by createdAt then id, descending --
 * so the extension always surfaces the most recent unanswered ask. Returns null when none are pending.
 */
export function selectPendingRequest(requests, answeredIds) {
  const answered = new Set(Array.isArray(answeredIds) ? answeredIds.map(String) : []);
  const pending = (Array.isArray(requests) ? requests : [])
    .filter((r) => validateAgentRequest(r).ok && !answered.has(String(r.id)))
    .sort((a, b) => {
      const ca = String(a.createdAt ?? '');
      const cb = String(b.createdAt ?? '');
      if (ca !== cb) return ca < cb ? 1 : -1;
      return String(a.id) < String(b.id) ? 1 : -1;
    });
  return pending.length ? pending[0] : null;
}
