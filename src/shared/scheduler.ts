import { PRNG_ALGORITHM, sampleBounded, Xoshiro128, type State } from './prng.js';

export interface Root { root_id: string; image_ms: number; isi_ms: number }
export interface Candidate extends Root { instance_id: string; number: number }
export interface Entry { candidate: Candidate; proposal_id: string | null; target: number }
export type Execution = 'UNSTARTED' | 'STAGED' | 'ONSET_OBSERVED' | 'WINDOW_CLOSED'
  | 'ENDED_OBSERVED' | 'ABORTED_BEFORE_SOFTWARE_ONSET' | 'ABORTED_AFTER_SOFTWARE_ONSET' | 'UNKNOWN';
export interface ScheduleAudit {
  op_id: string; type: 'INSERT' | 'CANCEL' | 'INTENT'; before_version: number; after_version: number;
  before: string[]; after: string[]; earliest_boundary: number; evidence: string;
  before_plan: Entry[]; after_plan: Entry[];
  proposal_id: string | null; instance_id: string; random: {
    algorithm: string; state: State; candidates: number[]; attempts: number[]; rejected: number;
    selected: number; expected_gap: number; relaxed: boolean;
  } | null;
}
interface Pending { audit: ScheduleAudit; queue: Entry[] }
// Pure software timeline model. The caller must persist the complete audit/intention
// and call acknowledge only after transaction completion AND notification.
export class Scheduler {
  readonly candidates: Candidate[];
  readonly executions = new Map<string, Execution>();
  readonly proposals = new Map<string, 'QUEUED' | 'CANCELLED' | 'INTENT_COMMITTED'>();
  readonly audit: ScheduleAudit[] = [];
  readonly observed: string[] = [];
  readonly satisfied = new Set<string>();
  queue: Entry[];
  version = 0;
  state: 'RUNNING' | 'TERMINATED' | 'GROUP_CLOSING' = 'RUNNING';
  reason: string | null = null;
  private pending: Pending | null = null;
  private ids = new Set<string>();
  private base: number;
  private rng: Xoshiro128;
  constructor(roots: Root[], readonly cap: number, start: number, state: State,
    readonly budget: { commit_ms: number; activate_ms: number; margin_ms: number; draw_budget: number }) {
    if (!roots.length || roots.length > 100 || new Set(roots.map(r => r.root_id)).size !== roots.length
      || !Number.isInteger(cap) || cap < 0 || cap > 2 || !Number.isFinite(start)
      || [budget.commit_ms, budget.activate_ms, budget.margin_ms].some(v => !Number.isFinite(v) || v < 0)
      || !Number.isInteger(budget.draw_budget) || budget.draw_budget < 1
      || roots.some(r => !r.root_id || !Number.isFinite(r.image_ms) || r.image_ms <= 0
        || !Number.isFinite(r.isi_ms) || r.isi_ms < 0)) throw new Error('INVALID_TEST_PLAN');
    if (cap > 0 && roots.some(r => r.isi_ms < budget.commit_ms + budget.activate_ms + budget.margin_ms))
      throw new Error('DYNAMIC_ISI_BUDGET_INSUFFICIENT');
    this.rng = new Xoshiro128(state); this.base = start;
    this.candidates = roots.flatMap(r => Array.from({ length: cap + 1 }, (_, i) => ({
      ...r, number: i + 1, instance_id: `${r.root_id}:${i + 1}`,
    })));
    for (const c of this.candidates) this.executions.set(c.instance_id, 'UNSTARTED');
    this.queue = this.retime(this.candidates.filter(c => c.number === 1).map(candidate => ({
      candidate, proposal_id: null, target: 0,
    })));
  }
  private retime(entries: Entry[]): Entry[] {
    let target = this.base;
    return entries.map(e => {
      const item = { ...e, target }; target += e.candidate.image_ms + e.candidate.isi_ms; return item;
    });
  }
  private stop(reason: string): never {
    for (const [id, state] of this.executions) {
      if (state === 'STAGED') this.executions.set(id, 'ABORTED_BEFORE_SOFTWARE_ONSET');
      if (state === 'ONSET_OBSERVED' || state === 'WINDOW_CLOSED') this.executions.set(id, 'ABORTED_AFTER_SOFTWARE_ONSET');
    }
    if (this.pending?.audit.type === 'INTENT') this.executions.set(this.pending.audit.instance_id, 'UNKNOWN');
    this.state = 'TERMINATED'; this.reason = reason; throw new Error(reason);
  }
  private ready(op: string) {
    if (this.state !== 'RUNNING') throw new Error('RUN_NOT_ACTIVE');
    if (this.pending) throw new Error('LOCAL_OPERATION_PENDING');
    if (!op || this.ids.has(op)) throw new Error('DUPLICATE_OPERATION_ID');
  }
  private prepare(audit: ScheduleAudit, queue: Entry[], now: number): ScheduleAudit {
    if (!Number.isFinite(now)) throw new Error('INVALID_CLOCK');
    if (audit.earliest_boundary - now < this.budget.commit_ms + this.budget.activate_ms + this.budget.margin_ms)
      return this.stop('COMMIT_DEADLINE_UNSAFE');
    this.ids.add(audit.op_id); this.pending = { audit, queue }; return audit;
  }
  private earliest(before: Entry[], after: Entry[]) {
    const old = new Map(before.map(e => [e.candidate.instance_id, e.target]));
    const changed: number[] = [];
    for (const e of after) {
      const target = old.get(e.candidate.instance_id);
      if (target !== e.target) { changed.push(e.target); if (target !== undefined) changed.push(target); }
      old.delete(e.candidate.instance_id);
    }
    changed.push(...old.values());
    if (!changed.length) throw new Error('EMPTY_MUTATION');
    return Math.min(...changed);
  }
  private make(op_id: string, type: ScheduleAudit['type'], after: Entry[], entry: Entry,
    evidence: string, boundary: number, random: ScheduleAudit['random'] = null): ScheduleAudit {
    if (!evidence) throw new Error('MISSING_DECISION_EVIDENCE');
    return { op_id, type, before_version: this.version, after_version: this.version + 1,
      before: this.queue.map(e => e.candidate.instance_id), after: after.map(e => e.candidate.instance_id),
      before_plan: structuredClone(this.queue), after_plan: structuredClone(after),
      earliest_boundary: boundary, evidence, proposal_id: entry.proposal_id,
      instance_id: entry.candidate.instance_id, random };
  }
  proposeRepeat(root: string, proposal: string, op: string, now: number, evidence: string): ScheduleAudit | null {
    this.ready(op);
    if (!proposal || this.proposals.has(proposal)) throw new Error('DUPLICATE_PROPOSAL');
    const templates = this.candidates.filter(c => c.root_id === root);
    if (!templates.length) throw new Error('UNKNOWN_ROOT');
    if (this.satisfied.has(root) || this.cap === 0) return null;
    if (this.queue.some(e => e.candidate.root_id === root
      && this.executions.get(e.candidate.instance_id) !== 'WINDOW_CLOSED')) throw new Error('ROOT_ALREADY_QUEUED');
    const candidate = templates.find(c => c.number > 1 && this.executions.get(c.instance_id) === 'UNSTARTED');
    if (!candidate) return null;
    const entry: Entry = { candidate, proposal_id: proposal, target: 0 };
    const protectedCount = this.queue.findIndex(e => this.executions.get(e.candidate.instance_id) === 'UNSTARTED');
    const first = protectedCount === -1 ? this.queue.length : protectedCount;
    const safe: number[] = []; const spaced: number[] = [];
    const gaps = new Map<number, number>();
    const last = this.observed.lastIndexOf(root);
    if (last < 0) throw new Error('ROOT_HAS_NO_ONSET');
    for (let i = first; i <= this.queue.length; i++) {
      const after = this.retime([...this.queue.slice(0, i), entry, ...this.queue.slice(i)]);
      if (this.earliest(this.queue, after) - now >= this.budget.commit_ms + this.budget.activate_ms + this.budget.margin_ms) {
        safe.push(i);
        const gap = this.observed.length - last - 1 + this.queue.slice(0, i).filter(e => e.candidate.root_id !== root
          && ['UNSTARTED', 'STAGED'].includes(this.executions.get(e.candidate.instance_id)!)).length;
        gaps.set(i, gap); if (gap >= 3) spaced.push(i);
      }
    }
    // No soft-gap position: choose only the safe tail, never an arbitrary early position.
    const choices = spaced.length ? spaced : safe.includes(this.queue.length) ? [this.queue.length] : [];
    if (!choices.length) return this.stop('NO_SAFE_REPEAT_BOUNDARY');
    const initial = this.rng.snapshot();
    let draw: ReturnType<typeof sampleBounded>;
    try { draw = sampleBounded(choices.length, () => this.rng.next(), this.budget.draw_budget); }
    catch { return this.stop('DRAW_BUDGET_EXHAUSTED'); }
    const position = choices[draw.index]!;
    const after = this.retime([...this.queue.slice(0, position), entry, ...this.queue.slice(position)]);
    return this.prepare(this.make(op, 'INSERT', after, entry, evidence, this.earliest(this.queue, after), {
      algorithm: PRNG_ALGORITHM, state: initial, candidates: choices, attempts: draw.attempts,
      rejected: draw.rejected, selected: position, expected_gap: gaps.get(position)!, relaxed: !spaced.length,
    }), after, now);
  }
  cancel(proposal: string, op: string, now: number, evidence: string) {
    this.ready(op);
    const entry = this.queue.find(e => e.proposal_id === proposal);
    if (!entry || this.proposals.get(proposal) !== 'QUEUED'
      || this.executions.get(entry.candidate.instance_id) !== 'UNSTARTED') return this.stop('CANCEL_PROTECTED_INSTANCE');
    const after = this.retime(this.queue.filter(e => e !== entry));
    return this.prepare(this.make(op, 'CANCEL', after, entry, evidence, this.earliest(this.queue, after)), after, now);
  }
  stage(op: string, now: number, evidence: string) {
    this.ready(op);
    const next = this.queue.find(e => this.executions.get(e.candidate.instance_id) === 'UNSTARTED');
    if (!next || this.queue.some(e => this.executions.get(e.candidate.instance_id) === 'STAGED'))
      throw new Error('NO_SINGLE_STAGE_TARGET');
    return this.prepare(this.make(op, 'INTENT', this.queue, next, evidence, next.target), this.queue, now);
  }
  acknowledge(op: string, notifiedAt: number) {
    if (this.state !== 'RUNNING') throw new Error('RUN_NOT_ACTIVE');
    const pending = this.pending;
    if (!pending || pending.audit.op_id !== op || pending.audit.before_version !== this.version)
      return this.stop('LOCAL_VERSION_FORK');
    if (!Number.isFinite(notifiedAt) || notifiedAt > pending.audit.earliest_boundary - this.budget.activate_ms - this.budget.margin_ms)
      return this.stop('LOCAL_COMMIT_NOTIFICATION_LATE');
    const a = pending.audit;
    if (a.type === 'INTENT') {
      this.executions.set(a.instance_id, 'STAGED');
      if (a.proposal_id) this.proposals.set(a.proposal_id, 'INTENT_COMMITTED');
    } else if (a.proposal_id) this.proposals.set(a.proposal_id, a.type === 'INSERT' ? 'QUEUED' : 'CANCELLED');
    this.queue = pending.queue.filter(e => this.executions.get(e.candidate.instance_id) !== 'ENDED_OBSERVED');
    this.version = a.after_version; this.audit.push(a); this.pending = null;
  }
  onset(instance: string) {
    if (this.state !== 'RUNNING' || this.queue[0]?.candidate.instance_id !== instance
      || this.executions.get(instance) !== 'STAGED') throw new Error('ILLEGAL_ONSET');
    this.executions.set(instance, 'ONSET_OBSERVED'); this.observed.push(this.queue[0].candidate.root_id);
  }
  windowClosed(instance: string) {
    if (this.state !== 'RUNNING' || this.executions.get(instance) !== 'ONSET_OBSERVED') throw new Error('ILLEGAL_WINDOW_CLOSE');
    this.executions.set(instance, 'WINDOW_CLOSED');
  }
  ended(instance: string) {
    if (this.state !== 'RUNNING' || this.queue[0]?.candidate.instance_id !== instance
      || this.executions.get(instance) !== 'WINDOW_CLOSED') throw new Error('ILLEGAL_END');
    const entry = this.queue.shift()!;
    this.base = entry.target + entry.candidate.image_ms + entry.candidate.isi_ms;
    this.executions.set(instance, 'ENDED_OBSERVED');
  }
  correctRoot(root: string, now: number, op: string, evidence: string) {
    if (this.state !== 'RUNNING') throw new Error('RUN_NOT_ACTIVE');
    // Only independently verified correction of first legal input may call this method.
    this.satisfied.add(root);
    if (this.pending) return this.stop('CORRECTION_DURING_PENDING_INTENT_OR_MUTATION');
    const next = this.queue.find(e => e.candidate.root_id === root && e.proposal_id);
    if (!next) return null;
    const status = this.executions.get(next.candidate.instance_id);
    if (status === 'STAGED') {
      this.executions.set(next.candidate.instance_id, 'ABORTED_BEFORE_SOFTWARE_ONSET');
      return this.stop('CORRECTION_BEFORE_SOFTWARE_ONSET');
    }
    if (status === 'UNSTARTED') return this.cancel(next.proposal_id!, op, now, evidence);
    // Observed instance keeps its complete fixed phases and consumed slot.
    return null;
  }
  closing(unresolvedObligations: boolean) {
    if (this.state !== 'RUNNING') throw new Error('RUN_NOT_ACTIVE');
    if (this.queue.length || this.pending || unresolvedObligations) return this.stop('UNRESOLVED_GROUP_TAIL');
    this.state = 'GROUP_CLOSING';
  }
  interrupt(knownBeforeOnset: boolean) {
    for (const [id, state] of this.executions) {
      if (state === 'STAGED') this.executions.set(id, knownBeforeOnset ? 'ABORTED_BEFORE_SOFTWARE_ONSET' : 'UNKNOWN');
      if (state === 'ONSET_OBSERVED' || state === 'WINDOW_CLOSED') this.executions.set(id, 'ABORTED_AFTER_SOFTWARE_ONSET');
    }
    if (this.pending?.audit.type === 'INTENT') this.executions.set(this.pending.audit.instance_id, 'UNKNOWN');
    this.state = 'TERMINATED'; this.reason = 'INTERRUPTED';
  }
}
