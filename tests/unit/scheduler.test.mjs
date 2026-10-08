import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Xoshiro128, sampleBounded } from '../../src/shared/prng.ts';
import { Scheduler } from '../../src/shared/scheduler.ts';

const budget = { commit_ms: 10, activate_ms: 5, margin_ms: 0, draw_budget: 10 };
const make = (cap = 2, count = 1) => new Scheduler(Array.from({ length: count }, (_, i) => ({ root_id: `r${i}`, image_ms: 100, isi_ms: 50 })), cap, 100, [1, 2, 3, 4], budget);
function perform(s, number, notified = 50) {
  const op = `stage-${number}`; const e = s.queue[0]; s.stage(op, notified - 20, 'test-intent'); s.acknowledge(op, notified);
  s.onset(e.candidate.instance_id); s.windowClosed(e.candidate.instance_id); return e;
}
test('TS unsigned PRNG matches every locked C golden output and little-endian seed', () => {
  const golden = JSON.parse(readFileSync(new URL('../../references/prng/golden-vectors.json', import.meta.url)));
  for (const vector of golden.vectors) {
    const rng = new Xoshiro128(vector.state);
    assert.deepEqual(vector.outputs.map(() => rng.next()), vector.outputs);
  }
  const seed = new Uint8Array(16); const view = new DataView(seed.buffer);
  [1, 2, 3, 4].forEach((v, i) => view.setUint32(i * 4, v, true));
  assert.deepEqual(Xoshiro128.fromSeed(seed).snapshot(), [1, 2, 3, 4]);
  assert.throws(() => new Xoshiro128([0, 0, 0, 0]), /INVALID/);
});
test('bounded draws reject the biased tail, have a finite budget and consume nothing for M=1', () => {
  let draws = 0; assert.deepEqual(sampleBounded(1, () => { draws++; return 0; }, 1), { index: 0, attempts: [], rejected: 0 });
  assert.equal(draws, 0);
  const source = [0xffffffff, 4];
  assert.deepEqual(sampleBounded(3, () => source.shift(), 2), { index: 1, attempts: [0xffffffff, 4], rejected: 1 });
  assert.throws(() => sampleBounded(3, () => 0xffffffff, 2), /DRAW_BUDGET_EXHAUSTED/);
  assert.equal(sampleBounded(2 ** 32, () => 0xffffffff, 1).index, 0xffffffff);
});
test('K=0/1/2 consume each fixed candidate once and end after the exact cap', () => {
  for (const cap of [0, 1, 2]) {
    const s = make(cap);
    for (let number = 1; number <= cap + 1; number++) {
      const target = s.queue[0].target; const e = perform(s, number, target - 30);
      const op = `repeat-${number}`;
      const proposal = s.proposeRepeat('r0', `p${number}`, op, target + 100, 'timeout-snapshot');
      if (number <= cap) { assert.ok(proposal); s.acknowledge(op, target + 110); }
      else assert.equal(proposal, null);
      s.ended(e.candidate.instance_id);
    }
    s.closing(false); assert.equal(s.state, 'GROUP_CLOSING'); assert.equal(s.observed.length, cap + 1);
  }
});
test('no zero/short ISI in dynamic mode, and a late tail cannot stretch fixed phases', () => {
  assert.throws(() => new Scheduler([{ root_id: 'r', image_ms: 100, isi_ms: 0 }], 2, 100, [1, 2, 3, 4], budget), /ISI_BUDGET/);
  const s = make(); perform(s, 1); const end = s.queue[0].target + 150;
  assert.throws(() => s.proposeRepeat('r0', 'p', 'late', end - 1, 'timeout'), /NO_SAFE/);
  assert.equal(s.state, 'TERMINATED'); assert.equal(s.queue[0].target, 100);
});
test('safe suffix choice preserves original order and prefers three other instances', () => {
  const s = make(2, 5); const first = perform(s, 1);
  const operation = s.proposeRepeat('r0', 'p', 'insert', 200, 'timeout');
  assert.deepEqual(operation.random.candidates, [4, 5]);
  s.acknowledge('insert', 210);
  assert.deepEqual(s.queue.filter(e => e.candidate.number === 1).map(e => e.candidate.root_id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.ok(operation.random.expected_gap >= 3); s.ended(first.candidate.instance_id);
});
test('effective queue changes only after notified commit; delayed notifications permanently terminate', () => {
  const s = make(); perform(s, 1);
  s.proposeRepeat('r0', 'p', 'insert', 200, 'timeout'); assert.equal(s.queue.length, 1);
  assert.throws(() => s.stage('concurrent', 205, 'intent'), /LOCAL_OPERATION_PENDING/);
  assert.throws(() => s.acknowledge('insert', 246), /LOCAL_COMMIT_NOTIFICATION_LATE/);
  assert.equal(s.state, 'TERMINATED'); assert.throws(() => s.stage('retry', 205, 'intent'), /RUN_NOT_ACTIVE/);
});
test('queued correction cancels before earliest shifted boundary, allows a NEW proposal for an unused candidate', () => {
  const s = make(); const first = perform(s, 1); s.proposeRepeat('r0', 'p', 'insert', 200, 'timeout'); s.acknowledge('insert', 210);
  const cancel = s.cancel('p', 'cancel', 215, 'first-input-correction'); s.acknowledge('cancel', 225);
  assert.equal(cancel.earliest_boundary, 250); assert.equal(s.proposals.get('p'), 'CANCELLED');
  const next = s.proposeRepeat('r0', 'p2', 'insert2', 230, 'new-trigger'); assert.equal(next.instance_id, 'r0:2');
  s.acknowledge('insert2', 235); s.ended(first.candidate.instance_id);
});
test('STAGED correction terminates, after-onset correction preserves complete phases and stops repeats', () => {
  for (const onset of [false, true]) {
    const s = make(); const first = perform(s, 1); s.proposeRepeat('r0', 'p', 'insert', 200, 'timeout'); s.acknowledge('insert', 210);
    s.ended(first.candidate.instance_id); s.stage('stage-repeat', 215, 'intent'); s.acknowledge('stage-repeat', 225);
    if (!onset) { assert.throws(() => s.correctRoot('r0', 230, 'correct', 'first-input'), /BEFORE_SOFTWARE_ONSET/); }
    else {
      s.onset('r0:2'); s.correctRoot('r0', 255, 'correct', 'first-input'); s.windowClosed('r0:2');
      assert.equal(s.proposeRepeat('r0', 'p2', 'repeat2', 350, 'timeout'), null);
      s.ended('r0:2'); s.closing(false); assert.equal(s.executions.get('r0:2'), 'ENDED_OBSERVED');
    }
  }
});
test('crash with pending intention is UNKNOWN, cannot reuse a candidate or reopen a closing group', () => {
  const s = make(); s.stage('intent', 20, 'intent'); s.interrupt(false);
  assert.equal(s.executions.get('r0:1'), 'UNKNOWN'); assert.throws(() => s.stage('restart', 0, 'intent'), /RUN_NOT_ACTIVE/);
  const t = make(0); const first = perform(t, 1); t.ended(first.candidate.instance_id);
  assert.throws(() => t.closing(true), /UNRESOLVED_GROUP_TAIL/);
});
