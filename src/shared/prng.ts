export const PRNG_ALGORITHM = 'xoshiro128ss-reject-u32-v1';
export type State = [number, number, number, number];
const rotate = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
export class Xoshiro128 {
  private state: State;
  constructor(state: State) {
    if (state.length !== 4 || state.some(v => !Number.isInteger(v) || v < 0 || v > 0xffffffff)
      || state.every(v => v === 0)) throw new Error('INVALID_PRNG_STATE');
    this.state = [...state];
  }
  static fromSeed(seed: Uint8Array) {
    if (seed.byteLength !== 16) throw new Error('INVALID_SEED_LENGTH');
    const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
    return new Xoshiro128([0, 4, 8, 12].map(i => view.getUint32(i, true)) as State);
  }
  snapshot(): State { return [...this.state]; }
  next(): number {
    const s = this.state;
    const result = Math.imul(rotate(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] = (s[2] ^ s[0]) >>> 0; s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0; s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0; s[3] = rotate(s[3], 11);
    return result;
  }
}
export function sampleBounded(size: number, next: () => number, drawBudget: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 2 ** 32
    || !Number.isSafeInteger(drawBudget) || drawBudget < 1) throw new Error('INVALID_DRAW_BUDGET_OR_RANGE');
  const attempts: number[] = [];
  if (size === 1) return { index: 0, attempts, rejected: 0 };
  const ceiling = Math.floor(2 ** 32 / size) * size;
  for (let i = 0; i < drawBudget; i++) {
    const value = next();
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('INVALID_U32');
    attempts.push(value);
    if (value < ceiling) return { index: value % size, attempts, rejected: i };
  }
  throw new Error('DRAW_BUDGET_EXHAUSTED');
}
