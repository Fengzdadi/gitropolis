// Setup timings (and, in --bench runs where gc() is exposed, retained heap per step), so we can see
// where startup time and memory go.
export const PERF = {};
export const HEAP = {};
const heap = () => { globalThis.gc?.(); return performance.memory ? performance.memory.usedJSHeapSize / 1e6 : 0; };
export function timed(name, fn) {
  const h0 = globalThis.gc ? heap() : 0;
  const t = performance.now();
  const r = fn();
  PERF[name] = (PERF[name] || 0) + performance.now() - t;
  if (globalThis.gc) HEAP[name] = (HEAP[name] || 0) + heap() - h0;
  return r;
}
