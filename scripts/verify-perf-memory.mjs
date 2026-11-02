/**
 * WP8 内存采样（调试用，不进产品）。
 *
 * 场景 1：6000 行长会话连续 300 个 revision，观察投影期间堆峰值。
 * 场景 2：连续切换 50 个会话（每轮新建 4000 行状态，旧状态丢弃后强制 GC），
 *         观察是否单调增长。
 *
 * 只做宽松上界断言（防泄漏级回归），真实上限见 3.DOCS 施工记录。
 * Run: node --expose-gc scripts/verify-perf-memory.mjs
 */
import { createChannelReadView, markChannelReadDirty } from '../lib/types/adapter/channel/read-view.js'

const gc = globalThis.gc ?? (() => {})
const heapMb = () => process.memoryUsage().heapUsed / (1024 * 1024)
const makeRows = count => Array.from({ length: count }, (_, index) => ({ id: index, kind: 'assistant', text: 'line ' + index, streaming: false }))
const stateOf = rowCount => ({
  rows: makeRows(rowCount),
  tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextSegments: { system: 1, prompt: 2, assistant: 3, thinking: 0, tools: 0 },
  lastUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, at: 1 },
  goal: undefined,
  todos: [],
  pending: [],
  notifications: [],
  commandList: [],
  tpsSamples: [],
})

let version = 0
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || detail === '' ? '' : ': ' + detail))
}

gc()
const baseline = heapMb()
const view = createChannelReadView(() => undefined)
const state = stateOf(6000)
let peak = baseline
for (let index = 0; index < 300; index++) {
  markChannelReadDirty(state.rows)
  view(state, ++version)
  if (index % 60 === 0) {
    gc()
    peak = Math.max(peak, heapMb())
  }
}
console.log('scenario=long-session rows=6000 revisions=300 baseline=' + baseline.toFixed(1) + 'MB peak=' + peak.toFixed(1) + 'MB delta=' + (peak - baseline).toFixed(1) + 'MB')
check('长会话 300 revision 堆增长 < 120MB', peak - baseline < 120, (peak - baseline).toFixed(1))

// 会话切换：旧状态丢弃后 GC，看堆是否回到基准附近。
gc()
const beforeSwitches = heapMb()
const samples = []
for (let session = 0; session < 50; session++) {
  const next = stateOf(4000)
  markChannelReadDirty(next.rows)
  view(next, ++version)
  if (session % 10 === 0) {
    gc()
    samples.push(heapMb())
  }
}
gc()
const afterSwitches = heapMb()
console.log('scenario=session-switch switches=50 heapStart=' + beforeSwitches.toFixed(1) + 'MB heapEnd=' + afterSwitches.toFixed(1) + 'MB samples=' + samples.map(value => value.toFixed(1)).join(','))
check('50 次会话切换后堆不高于起始 + 60MB', afterSwitches - beforeSwitches < 60, (afterSwitches - beforeSwitches).toFixed(1))

console.log(failures === 0 ? 'verify-perf-memory: PASS' : 'verify-perf-memory: FAIL')
process.exitCode = failures === 0 ? 0 : 1
