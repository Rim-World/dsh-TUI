/**
 * WP4 读投影成本与身份回归。
 *
 * P5：subagentControl / jobControl / pluginScene 的包装在同一 version 内
 *     身份稳定；version 递增后换新；lease 结束后方法调用仍抛错。
 * P3：测量「每个 version 全量拷贝普通对象」的成本（tokens / contextSegments /
 *     lastUsage / goal / todos / pending / notifications / commandList /
 *     tpsSamples + 6000 行容器），输出 ms/帧，供决策「修 / 记录为已知」。
 * P4：测量效果方法返回值经 query() 深拷贝的单次成本（每次按键）。
 *
 * 本脚本不做性能硬门禁（机器抖动），只对身份/lease 语义做硬断言。
 *
 * Run: node --import tsx/esm scripts/verify-perf-read-view.ts
 */
import assert from 'node:assert/strict'

const { createChannelReadView, markChannelReadDirty } = await import('../src/adapter/channel/read-view.js')
const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')

let checks = 0
const check = (name: string, ok: boolean): void => {
  checks += 1
  if (!ok) throw new Error('FAIL ' + name)
  console.log('ok   ' + name)
}

// ---- 构造器：一份典型长会话状态 ------------------------------------------
function makeRows(count: number): { id: number; kind: string; text: string; streaming: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({ id: index, kind: 'assistant', text: 'line ' + index, streaming: false }))
}
const makeState = (rowCount: number) => ({
  rows: makeRows(rowCount),
  tokens: { input: 1000, output: 2000, cacheRead: 10, cacheWrite: 5, peak: { input: 1, output: 2 }, idle: { input: 3, output: 4 } },
  contextSegments: { system: 100, prompt: 200, assistant: 300, thinking: 40, tools: 50 },
  lastUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, at: 1 },
  goal: { text: 'goal', status: 'active', roundsStarted: 1 },
  todos: Array.from({ length: 30 }, (_, index) => ({ id: index, text: 'todo ' + index, status: 'pending' })),
  pending: [{ id: 'p1', title: 'pending' }],
  notifications: Array.from({ length: 10 }, (_, index) => ({ id: index, text: 'n' + index })),
  commandList: Array.from({ length: 100 }, (_, index) => ({ name: 'cmd' + index, description: 'd' })),
  tpsSamples: Array.from({ length: 500 }, (_, index) => ({ tps: index, at: index })),
})

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

// ---- P3：每个 version 的投影拷贝成本 -------------------------------------
function measureProjection(rowCount: number, dirtyRows: boolean): number {
  const state = makeState(rowCount)
  const view = createChannelReadView(() => undefined)
  let version = 0
  // Warm caches, then measure 40 revisions.
  for (let index = 0; index < 5; index++) {
    if (dirtyRows) markChannelReadDirty(state.rows)
    view(state, ++version)
  }
  const samples: number[] = []
  for (let index = 0; index < 40; index++) {
    if (dirtyRows) markChannelReadDirty(state.rows)
    const start = performance.now()
    view(state, ++version)
    samples.push(performance.now() - start)
  }
  return median(samples)
}
const p3NoRows = measureProjection(0, false)
const p3RowsNoDirty = measureProjection(6000, false)
const p3RowsStreaming = measureProjection(6000, true)
console.log('P3 投影耗时（中位数）：')
console.log('  普通字段（0 行）            : ' + p3NoRows.toFixed(3) + ' ms/version')
console.log('  6000 行容器（未标脏）       : ' + p3RowsNoDirty.toFixed(3) + ' ms/version')
console.log('  6000 行容器（流式每帧标脏） : ' + p3RowsStreaming.toFixed(3) + ' ms/version')
check('P3 单次投影耗时可测（< 50 ms）', p3RowsStreaming < 50)

// 同 version 重复读：普通对象身份稳定（read-view 既有行为）。
{
  const state = makeState(10)
  const view = createChannelReadView(() => undefined)
  const first = view(state, 7)
  const second = view(state, 7)
  check('同 version 重复读身份稳定', first === second)
  check('投影结果冻结', Object.isFrozen(first))
}

// 标记数组：未标脏时跨 version 复用；标脏后换新且内容更新（tpsSamples 路径）。
{
  const state = { tpsSamples: Array.from({ length: 500 }, (_, index) => ({ tps: index, at: index })) }
  const view = createChannelReadView(() => undefined)
  // 模拟真实流程：数组变化后由 projection 标脏，之后未变时跨 version 复用。
  markChannelReadDirty(state.tpsSamples)
  const first = view(state, 1) as unknown as { tpsSamples: readonly unknown[] }
  const second = view(state, 2) as unknown as { tpsSamples: readonly unknown[] }
  check('标记数组未标脏时跨 version 身份稳定', second.tpsSamples === first.tpsSamples)
  state.tpsSamples.push({ tps: 999, at: 999 })
  markChannelReadDirty(state.tpsSamples)
  const third = view(state, 3) as unknown as { tpsSamples: readonly unknown[] }
  check('标记数组标脏后身份变化', third.tpsSamples !== first.tpsSamples)
  check('标记数组更新可见', third.tpsSamples.length === 501)
  check('旧快照不可变', first.tpsSamples.length === 500)
}

// ---- P4：query() 每次调用的拷贝成本 -------------------------------------
{
  const payload = Array.from({ length: 100 }, (_, index) => ({ name: 'cmd' + index, description: 'd' + index }))
  const query = createChannelReadView((mutation: boolean) => { void mutation })
  const samples: number[] = []
  for (let index = 0; index < 300; index++) {
    const start = performance.now()
    query({ items: payload }, 0)
    samples.push(performance.now() - start)
  }
  console.log('P4 query() 深拷贝（100 项）：' + median(samples).toFixed(4) + ' ms/次')
}

// ---- P5：控制包装身份与 lease 语义 --------------------------------------
{
  let interrupts = 0
  const subagentControl = { interrupt: () => { interrupts += 1 }, history: undefined }
  const raw = {
    version: 0,
    subagentControl,
    jobControl: { kill: () => undefined, watchOutput: () => () => undefined },
    pluginScene: { id: 'scene-1', title: 'Scene' },
  } as never
  const lease = createChannelUiLease(() => true)
  const ui = createChannelUi(raw as never, 'legacy', lease)
  const rawVersioned = raw as unknown as { version: number }

  const controlA = ui.subagentControl
  const controlB = ui.subagentControl
  check('subagentControl 同 version 身份稳定', controlA === controlB)
  check('subagentControl 内容正确', typeof controlA.interrupt === 'function')

  rawVersioned.version = 1
  const controlC = ui.subagentControl
  check('version 递增后 subagentControl 换新', controlC !== controlA)
  controlC.interrupt()
  check('包装方法仍可调用', interrupts === 1)

  rawVersioned.version = 2
  const jobA = ui.jobControl
  const jobB = ui.jobControl
  check('jobControl 同 version 身份稳定', jobA === jobB)
  rawVersioned.version = 3
  check('version 递增后 jobControl 换新', ui.jobControl !== jobA)

  const sceneA = ui.pluginScene
  const sceneB = ui.pluginScene
  check('pluginScene 同 version 身份稳定', sceneA === sceneB)
  check('pluginScene 内容正确', sceneA!.id === 'scene-1' && sceneA!.title === 'Scene')

  lease.dispose()
  let threw = false
  try {
    controlA.interrupt()
  } catch (error) {
    threw = error instanceof Error && /lifetime/i.test(error.message)
  }
  check('lease 结束后方法调用抛错', threw)
  check('lease 结束后调用未生效', interrupts === 1)
}

console.log('\n' + checks + '/' + checks + ' checks passed')
