/**
 * T2 缓存差分 fuzz（计划 2.PLANS/004-M-深化测试计划v1.1.md §4 T2，判据 §7 / 附录命令）。
 *
 * 目的：证明三类缓存在任意事件序列下都不改变输出，且就地变更后必然失效。
 * 参考结果用「克隆身份强制重算」构造（计划 D4）：不新增生产接缝、不改 src/。
 *
 *   T2a 可见窗口缓存：src/components/MessageList.tsx 的 deriveVisibleRows。
 *       实际路径：同一 rows 数组身份连续调用，命中模块内缓存。
 *       参考路径：每次传入深克隆的 rows + 克隆的 options 且 previous=null，
 *                身份不同 / 无前项，必然全量重算。
 *       断言：派生行数组、margins、windowStart 逐项相等；每帧指纹访问数
 *             等于窗口长度（showAll 时为总行数），不随总行数增长；
 *             窗口外更新必命中、窗口内更新必重建。
 *   T2b createChannelUi 身份与投影：src/adapter/channel/ui.ts（read-view 容器
 *       复用、projectAgentViewRows 快照缓存、memoControl 包装缓存）。
 *       实际路径：同一 channel 对象、同一 rows 身份连续投影。
 *       参考路径：深克隆 channel 状态后新建 createChannelUi 实例投影
 *               （身份不同，强制重算）。
 *       就地变更：流式行文本、工具卡状态、job 状态、待办、通知、清屏等在
 *                 源对象上直接改写 + 按投影层契约标脏（markChannelReadDirty）
 *                 + 递增 channel.version，断言下一次投影可见。
 *   T2c 读投影复用：src/adapter/channel/read-view.ts 的 createChannelReadView
 *       与 markChannelReadDirty。
 *       实际路径：单实例连续读取。
 *       参考路径：每次新建读投影实例。
 *       断言：容器内容逐字段相等；markChannelReadDirty 之后必须读到新内容；
 *             未标脏时身份复用规则与 dirtyRevision 语义一致。
 *
 * 确定性：xorshift32 PRNG + 固定种子表；失败输出种子、步号、操作序列与首个
 * 差异快照；--seed 可只跑单个种子。行数覆盖 {0,1,120,600,3000,6000,12000}，
 * 列宽 {80,120,200} 只作为文本长度因子参与数据生成（T2 断言不依赖终端尺寸）。
 * 时钟：被测单元不读系统时钟；失败日志文件名用 ISO 时间。
 *
 * 运行：
 *   DSH_TUI_EQUIV_QUICK=1 node --import tsx/esm scripts/verify-perf-equiv-fuzz.ts
 *   node --import tsx/esm scripts/verify-perf-equiv-fuzz.ts --steps 10000
 *   node --import tsx/esm scripts/verify-perf-equiv-fuzz.ts --seed 0x9e3779b9 --steps 64
 * 可选：--failure-dir <dir> 在失败时写 JSON 快照（默认不写文件）。
 */
import type { ChatRow, JobRow, SubagentRow, ToolRow } from '../src/dsh-adapter/channel.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 计划 §3.4：固定语言 / 清空调试开关（必须在被测模块导入前设置）。
process.env.DSH_TUI_LANG = 'zh'
delete process.env.DSH_TUI_DEBUG
delete process.env.DSH_TUI_RENDER_LOG
delete process.env.DSH_TUI_BOOT_TRACE

const argv = process.argv.slice(2)
function argValue(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const quick = process.env.DSH_TUI_EQUIV_QUICK === '1'
const QUICK_STEPS = 2000
const FULL_STEPS = 10000
const stepsArg = argValue('--steps')
const totalSteps = stepsArg === undefined ? (quick ? QUICK_STEPS : FULL_STEPS) : Number(stepsArg)
if (!Number.isInteger(totalSteps) || totalSteps <= 0) {
  console.error('T2: --steps 必须是正整数，收到 ' + String(stepsArg))
  process.exit(2)
}

/** 固定种子表（xorshift32，≥8 个）。失败时打印种子与步号，可用 --seed 复现。 */
const SEEDS = [
  0x9e3779b9, 0x243f6a88, 0x85a308d3, 0x13198a2e,
  0x03707344, 0xa4093822, 0x299f31d0, 0x082efa98,
] as const
const seedArg = argValue('--seed')
function parseSeed(text: string): number {
  const value = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text)
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    console.error('T2: --seed 须为 0x00000000..0xffffffff，收到 ' + text)
    process.exit(2)
  }
  return value >>> 0
}
const seeds = seedArg === undefined ? SEEDS : [parseSeed(seedArg)]
const failureDir = argValue('--failure-dir')

const ml = await import('../src/components/MessageList.js')
const rv = await import('../src/adapter/channel/read-view.js')
const uiMod = await import('../src/adapter/channel/ui.js')
const { deriveVisibleRows, RENDERED_ROW_CAP, readVisibleWindowProbe, resetVisibleWindowProbe } = ml
const { createChannelReadView, markChannelReadDirty } = rv
const { createChannelUi, createChannelUiLease } = uiMod

type VisibleRowsOptions = Parameters<typeof deriveVisibleRows>[1]
type VisibleRowsCacheEntry = ReturnType<typeof deriveVisibleRows>

// ── 通用工具：PRNG / 克隆 / 逐字段深比较 ──────────────────────────────────
interface Rng {
  next(): number
  int(maxExclusive: number): number
  pick<T>(items: readonly T[]): T
  bool(probability: number): boolean
}
function createRng(seed: number): Rng {
  let state = seed >>> 0 || 0x1
  const next = (): number => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
  return {
    next,
    int: maxExclusive => next() % maxExclusive,
    pick: items => items[next() % items.length]!,
    bool: probability => (next() % 10000) < probability * 10000,
  }
}

function cloneData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => cloneData(item)) as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (value instanceof Map) return new Map([...value.entries()].map(([key, item]) => [cloneData(key), cloneData(item)])) as T
  if (value instanceof Set) return new Set([...value].map(item => cloneData(item))) as T
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = cloneData(item)
  return result as T
}

interface DiffPath {
  path: string
  actual: unknown
  expected: unknown
}
const MAX_SNAPSHOT_CHARS = 320
function snapshotText(value: unknown, budget = MAX_SNAPSHOT_CHARS): string {
  let text: string
  try {
    text = JSON.stringify(value, (_key, item) => (typeof item === 'function' ? '[function]' : item)) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > budget ? text.slice(0, budget) + '…' : text
}
/** 逐字段深比较，返回第一个差异（path/两侧值）。Map/Set/Date/函数有专门语义。 */
function deepDiff(actual: unknown, expected: unknown, path = '$'): DiffPath | null {
  if (Object.is(actual, expected)) return null
  if (typeof actual === 'number' && typeof expected === 'number' && Number.isNaN(actual) && Number.isNaN(expected)) return null
  if (typeof actual === 'function' || typeof expected === 'function') {
    return typeof actual === typeof expected ? null : { path, actual: '[function]', expected: '[function]' }
  }
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    return { path, actual, expected }
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return { path, actual, expected }
    if (actual.length !== expected.length) return { path: path + '.length', actual: actual.length, expected: expected.length }
    for (let index = 0; index < actual.length; index += 1) {
      const diff = deepDiff(actual[index], expected[index], path + '[' + index + ']')
      if (diff !== null) return diff
    }
    return null
  }
  if (actual instanceof Date || expected instanceof Date) {
    if (!(actual instanceof Date) || !(expected instanceof Date)) return { path, actual, expected }
    return actual.getTime() === expected.getTime() ? null : { path: path + '.time', actual: actual.getTime(), expected: expected.getTime() }
  }
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map) || !(expected instanceof Map)) return { path, actual, expected }
    if (actual.size !== expected.size) return { path: path + '.size', actual: actual.size, expected: expected.size }
    const actualEntries = [...actual.entries()].sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    const expectedEntries = [...expected.entries()].sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    for (let index = 0; index < actualEntries.length; index += 1) {
      const diff = deepDiff(actualEntries[index]![1], expectedEntries[index]![1], path + '.get(' + String(actualEntries[index]![0]) + ')')
      if (diff !== null) return diff
    }
    return null
  }
  if (actual instanceof Set || expected instanceof Set) {
    if (!(actual instanceof Set) || !(expected instanceof Set)) return { path, actual, expected }
    if (actual.size !== expected.size) return { path: path + '.size', actual: actual.size, expected: expected.size }
    const actualItems = [...actual].map(item => JSON.stringify(item)).sort()
    const expectedItems = [...expected].map(item => JSON.stringify(item)).sort()
    return actualItems.join('\u0000') === expectedItems.join('\u0000') ? null : { path, actual, expected }
  }
  const actualKeys = Object.keys(actual as Record<string, unknown>).sort()
  const expectedKeys = Object.keys(expected as Record<string, unknown>).sort()
  if (actualKeys.join('\u0000') !== expectedKeys.join('\u0000')) {
    return { path: path + '.keys', actual: actualKeys, expected: expectedKeys }
  }
  for (const key of actualKeys) {
    const diff = deepDiff(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
      path + '.' + key,
    )
    if (diff !== null) return diff
  }
  return null
}

// ── 报告基础设施 ────────────────────────────────────────────────────────
type SubName = 'T2a' | 'T2b' | 'T2c'
interface SubStats {
  steps: number
  diffs: number
  assertionFailures: number
  preflightChecks: number
  preflightFailures: number
  firstDiff: DiffPath | null
  firstFailureCase: string | null
  failedCases: string[]
  extra: Record<string, number>
}
const stats: Record<SubName, SubStats> = {
  T2a: { steps: 0, diffs: 0, assertionFailures: 0, preflightChecks: 0, preflightFailures: 0, firstDiff: null, firstFailureCase: null, failedCases: [], extra: { hits: 0, rebuilds: 0, probeViolations: 0, hitViolations: 0 } },
  T2b: { steps: 0, diffs: 0, assertionFailures: 0, preflightChecks: 0, preflightFailures: 0, firstDiff: null, firstFailureCase: null, failedCases: [], extra: { invalidationChecks: 0 } },
  T2c: { steps: 0, diffs: 0, assertionFailures: 0, preflightChecks: 0, preflightFailures: 0, firstDiff: null, firstFailureCase: null, failedCases: [], extra: { invalidationChecks: 0 } },
}
interface FailureRecord {
  sub: SubName
  seed: number
  step: number
  op: string
  path: string
  actual: unknown
  expected: unknown
  ops: string[]
}
const failures: FailureRecord[] = []
const MAX_FAILURE_RECORDS = 20
function recordFailure(record: FailureRecord): void {
  if (failures.length < MAX_FAILURE_RECORDS) failures.push(record)
}
function failDiff(sub: SubName, seed: number, step: number, op: string, diff: DiffPath, ops: string[]): void {
  const target = stats[sub]
  target.diffs += 1
  if (target.firstDiff === null) target.firstDiff = diff
  if (target.firstFailureCase === null) target.firstFailureCase = sub + ' ' + op + ' seed=0x' + seed.toString(16) + ' step=' + String(step)
  if (target.failedCases.length < 12) target.failedCases.push(op + '@' + String(step))
  recordFailure({ sub, seed, step, op, path: diff.path, actual: diff.actual, expected: diff.expected, ops })
  console.error(
    'FAIL ' + sub + ' seed=0x' + seed.toString(16) + ' step=' + String(step) + ' op=' + op +
    ' path=' + diff.path +
    '\n  actual  : ' + snapshotText(diff.actual) +
    '\n  expected: ' + snapshotText(diff.expected) +
    '\n  recent ops: ' + ops.slice(-10).join(' | '),
  )
}
function failCheck(sub: SubName, seed: number, step: number, caseName: string, detail: string, ops: string[]): void {
  const target = stats[sub]
  target.assertionFailures += 1
  if (target.firstFailureCase === null) target.firstFailureCase = sub + ' ' + caseName + ' seed=0x' + seed.toString(16) + ' step=' + String(step)
  if (target.failedCases.length < 12) target.failedCases.push(caseName + '@' + String(step))
  recordFailure({ sub, seed, step, op: caseName, path: '$check', actual: detail, expected: caseName, ops })
  if (failures.length > 10) return
  console.error('FAIL ' + sub + ' seed=0x' + seed.toString(16) + ' step=' + String(step) + ' case=' + caseName + ' detail=' + detail + '\n  recent ops: ' + ops.slice(-10).join(' | '))
}
function pushOp(ring: string[], op: string): void {
  ring.push(op)
  if (ring.length > 16) ring.shift()
}

// ── 行构造 ──────────────────────────────────────────────────────────────
const ROW_SIZES = [0, 1, 120, 600, 3000, 6000, 12000] as const
const ROW_SIZE_WEIGHTS = [1, 1, 2, 2, 2, 1, 1] as const
const COLUMNS = [80, 120, 200] as const
function pickRowSize(rng: Rng): number {
  const total = ROW_SIZE_WEIGHTS.reduce((sum, weight) => sum + weight, 0)
  let ticket = rng.int(total)
  for (let index = 0; index < ROW_SIZES.length; index += 1) {
    ticket -= ROW_SIZE_WEIGHTS[index]!
    if (ticket < 0) return ROW_SIZES[index]!
  }
  return ROW_SIZES[0]!
}

interface RowFactory {
  nextId: number
  rng: Rng
  columns: number
}
function makeToolRow(factory: RowFactory, id: number, status: ToolRow['status'] = 'running'): ChatRow {
  const tool: ToolRow = {
    callId: 'call-' + String(id),
    name: 'bash',
    argsText: 'ls -la # ' + 'x'.repeat(factory.columns % 7),
    status,
    startedAt: id,
    ...(status === 'running' ? {} : { resultText: 'out-' + String(id) }),
  }
  return { id, kind: 'tool', text: '', tool, time: id } as ChatRow
}
function makeJobRow(factory: RowFactory, id: number, status: JobRow['status'] = 'completed'): ChatRow {
  const job: JobRow = {
    id: 'job-' + String(id),
    kind: 'bash',
    label: 'run #' + String(id),
    status,
    startedAt: id,
    ...(status === 'running' ? {} : { finishedAt: id + 1 }),
    outputLines: [{ text: 'line ' + String(id) }],
  }
  return { id, kind: 'job', text: '', job, time: id } as ChatRow
}
function makeAssistantRow(factory: RowFactory, id: number, streaming = false, text?: string): ChatRow {
  return { id, kind: 'assistant', text: text ?? ('reply ' + String(id) + ' ' + 'w'.repeat(factory.columns % 13)), streaming, time: id } as ChatRow
}
function makeReasoningRow(factory: RowFactory, id: number): ChatRow {
  return { id, kind: 'reasoning', text: 'thinking ' + String(id), streaming: true, time: id } as ChatRow
}
function makeUserRow(id: number): ChatRow {
  return { id, kind: 'user', text: 'prompt ' + String(id), time: id } as ChatRow
}
function makeTurnSummaryRow(id: number): ChatRow {
  return { id, kind: 'turn-summary', text: '', turnUsage: { input: id, output: id, cacheRead: 0, cacheWrite: 0, totalTokens: id * 2 }, time: id } as ChatRow
}
function makeSubagentRow(id: number): ChatRow {
  const subagent: SubagentRow = { agentId: 'agent-' + String(id), description: 'work ' + String(id), status: 'running' } as SubagentRow
  return { id, kind: 'subagent', text: '', subagent, time: id } as ChatRow
}
function randomRow(factory: RowFactory): ChatRow {
  const id = factory.nextId++
  const roll = factory.rng.int(100)
  if (roll < 46) return makeAssistantRow(factory, id, factory.rng.bool(0.25))
  if (roll < 58) return makeReasoningRow(factory, id)
  if (roll < 70) return makeUserRow(id)
  if (roll < 80) return makeToolRow(factory, id, factory.rng.pick(['running', 'ok', 'error'] as const))
  if (roll < 91) return makeJobRow(factory, id, factory.rng.pick(['running', 'completed', 'failed', 'killed'] as const))
  if (roll < 95) return makeTurnSummaryRow(id)
  if (roll < 98) return makeSubagentRow(id)
  return { id, kind: 'compact', text: 'compact ' + String(id), time: id } as ChatRow
}
function makeRowSequence(rng: Rng, count: number, columns: number): ChatRow[] {
  const factory: RowFactory = { nextId: 1, rng, columns }
  return Array.from({ length: count }, () => randomRow(factory))
}

function windowStartOf(rows: readonly ChatRow[], options: VisibleRowsOptions): number {
  const hidden = rows.length - RENDERED_ROW_CAP
  return options.showAll || hidden <= 0 ? 0 : hidden
}
function expectedWindowLength(rows: readonly ChatRow[], options: VisibleRowsOptions): number {
  return options.showAll || rows.length <= RENDERED_ROW_CAP ? rows.length : RENDERED_ROW_CAP
}
function cloneOptions(options: VisibleRowsOptions): VisibleRowsOptions {
  return { ...options, expandedRows: new Set(options.expandedRows) }
}
function diffVisibleEntries(actual: VisibleRowsCacheEntry, reference: VisibleRowsCacheEntry): DiffPath | null {
  return deepDiff(
    {
      windowStart: actual.windowStart,
      rowCount: actual.rowCount,
      thinkingVisible: actual.thinkingVisible,
      turnRowOn: actual.turnRowOn,
      out: actual.out,
      margins: [...actual.margins.entries()].sort((left, right) => left[0] - right[0]),
    },
    {
      windowStart: reference.windowStart,
      rowCount: reference.rowCount,
      thinkingVisible: reference.thinkingVisible,
      turnRowOn: reference.turnRowOn,
      out: reference.out,
      margins: [...reference.margins.entries()].sort((left, right) => left[0] - right[0]),
    },
    'visible',
  )
}

// ── T2a 前置手写用例（验证参考路径本身） ─────────────────────────────────
function preflightT2a(): void {
  const rng = createRng(0x51a1)
  const columns = 120
  const rows = makeRowSequence(rng, 600, columns)
  const options: VisibleRowsOptions = { showAll: false, thinkingVisible: true, turnUsageRow: false, expanded: false, expandedRows: new Set<number>(), jobGroupFold: 'auto' }
  let checks = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks += 1
    stats.T2a.preflightChecks += 1
    if (!ok) {
      stats.T2a.preflightFailures += 1
      console.error('FAIL preflight-T2a ' + name + (detail === '' ? '' : ': ' + detail))
      stats.T2a.assertionFailures += 1
    }
  }
  const first = deriveVisibleRows(rows, options, null)
  resetVisibleWindowProbe()
  const second = deriveVisibleRows(rows, options, first)
  const hitProbe = readVisibleWindowProbe()
  check('同输入第二次调用命中缓存', second === first)
  check('命中的指纹访问数 = 窗口长度', hitProbe.fingerprintVisits === RENDERED_ROW_CAP, String(hitProbe.fingerprintVisits))
  check('命中不重建', hitProbe.rebuilds === 0, String(hitProbe.rebuilds))

  const outside = rows.slice()
  outside[3] = makeAssistantRow({ nextId: 1000, rng, columns }, 4, false, 'outside-updated')
  resetVisibleWindowProbe()
  const outsideEntry = deriveVisibleRows(outside, options, first)
  check('窗口外更新命中缓存', outsideEntry === first)
  check('窗口外更新的指纹访问数 = 窗口长度', readVisibleWindowProbe().fingerprintVisits === RENDERED_ROW_CAP)

  const inside = outside.slice()
  inside[inside.length - 1] = makeAssistantRow({ nextId: 1001, rng, columns }, inside[inside.length - 1]!.id, true, 'inside-updated')
  const insideEntry = deriveVisibleRows(inside, options, outsideEntry)
  check('窗口内更新重建', insideEntry !== first)
  check('窗口内更新内容刷新', insideEntry.out[insideEntry.out.length - 1]?.text === 'inside-updated')
  const referenceInside = deriveVisibleRows(cloneData(inside), cloneOptions(options), null)
  check('参考路径逐字段相等', diffVisibleEntries(insideEntry, referenceInside) === null, snapshotText(diffVisibleEntries(insideEntry, referenceInside)))
  console.log('preflight T2a: ' + String(checks) + ' checks')
}

// ── T2b 合成 channel + 前置手写用例 ──────────────────────────────────────
interface T2bData {
  version: number
  rows: ChatRow[]
  nextId: number
  notifications: Array<{ id: number; text: string; color?: string }>
  todos: Array<{ id: number; text: string; status: string }>
  goal: { text: string; status: string } | undefined
  pending: Array<{ id: string; title: string }>
  compaction: { summary: string } | undefined
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  turnUsage: { input: number; output: number } | undefined
  tpsSamples: Array<{ tps: number; at: number }>
  contextSegments: { system: number; prompt: number; assistant: number }
  contextWindow: number
  working: boolean
  activeToolCount: number
  responseChars: number
  agentViewSource: Array<{ id: string; status: string; updatedAt: number }>
  agentViewData: Array<{ id: string; status: string; updatedAt: number }>
  subagents: Array<{ agentId: string; status: string }>
  preferences: { thinkingFold: 'preview' | 'full'; contextBarEnabled: boolean; activityEnabled: boolean; activityFrames: string; minimalUi: boolean; turnUsageRow: boolean }
  scene: { id: string; title: string } | undefined
  subagentCalls: number
  jobKills: number
}
function createT2bData(rng: Rng, rowCount: number): T2bData {
  const data: T2bData = {
    version: 0,
    rows: makeRowSequence(rng, rowCount, rng.pick(COLUMNS)),
    nextId: rowCount + 1,
    notifications: [{ id: 1, text: 'n1' }],
    todos: [{ id: 1, text: 'todo-1', status: 'pending' }],
    goal: { text: 'goal', status: 'active' },
    pending: [{ id: 'p1', title: 'pending-1' }],
    compaction: undefined,
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    turnUsage: { input: 10, output: 20 },
    tpsSamples: Array.from({ length: 20 }, (_value, index) => ({ tps: index, at: index })),
    contextSegments: { system: 1000, prompt: 500, assistant: 250 },
    contextWindow: 128000,
    working: true,
    activeToolCount: 0,
    responseChars: 0,
    agentViewSource: [{ id: 'agent-a', status: 'idle', updatedAt: 1 }],
    agentViewData: [{ id: 'agent-a', status: 'idle', updatedAt: 1 }],
    subagents: [{ agentId: 'agent-a', status: 'running' }],
    preferences: { thinkingFold: 'preview', contextBarEnabled: true, activityEnabled: true, activityFrames: 'dots', minimalUi: false, turnUsageRow: false },
    scene: { id: 'scene-1', title: 'Scene' },
    subagentCalls: 0,
    jobKills: 0,
  }
  return data
}
function createT2bChannel(data: T2bData): Record<string, unknown> {
  const subagentControl = { interrupt: () => { data.subagentCalls += 1 }, history: undefined }
  const jobControl = { kill: () => { data.jobKills += 1 }, watchOutput: () => () => undefined }
  return {
    get version() { return data.version },
    get rows() { return data.rows },
    get notifications() { return data.notifications },
    get todos() { return data.todos },
    get goal() { return data.goal },
    get pending() { return data.pending },
    get compaction() { return data.compaction },
    get tokens() { return data.tokens },
    get turnUsage() { return data.turnUsage },
    get tpsSamples() { return data.tpsSamples },
    get contextSegments() { return data.contextSegments },
    get contextWindow() { return data.contextWindow },
    get working() { return data.working },
    get activeToolCount() { return data.activeToolCount },
    get responseChars() { return data.responseChars },
    get subagents() { return data.subagents },
    get thinkingFold() { return data.preferences.thinkingFold },
    get contextBarEnabled() { return data.preferences.contextBarEnabled },
    get activityEnabled() { return data.preferences.activityEnabled },
    get activityFrames() { return data.preferences.activityFrames },
    get minimalUi() { return data.preferences.minimalUi },
    get turnUsageRow() { return data.preferences.turnUsageRow },
    get pluginScene() { return data.scene },
    get subagentControl() { return subagentControl },
    get jobControl() { return jobControl },
    agentViewRows: () => data.agentViewSource,
    subscribeAgentView: () => () => undefined,
    subscribe: () => () => undefined,
  }
}
const T2B_PROPS = [
  'rows', 'notifications', 'todos', 'goal', 'pending', 'compaction', 'tokens', 'turnUsage',
  'tpsSamples', 'contextSegments', 'contextWindow', 'working', 'activeToolCount', 'responseChars',
  'thinkingFold', 'contextBarEnabled', 'activityEnabled', 'activityFrames', 'minimalUi', 'turnUsageRow',
  'subagents', 'pluginScene',
] as const

function preflightT2b(): void {
  let checks = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks += 1
    stats.T2b.preflightChecks += 1
    if (!ok) {
      stats.T2b.preflightFailures += 1
      console.error('FAIL preflight-T2b ' + name + (detail === '' ? '' : ': ' + detail))
      stats.T2b.assertionFailures += 1
    }
  }
  const rng = createRng(0x7b2)
  const data = createT2bData(rng, 300)
  const raw = createT2bChannel(data)
  const lease = createChannelUiLease(() => true)
  const actual = createChannelUi(raw as never, 'legacy', lease)

  // 1. 同一 rows 身份跨 version 递增：投影身份稳定（read-view 容器复用）。
  const rowsA = actual.rows
  data.version += 1
  check('无变化 version bump 后 rows 身份稳定', actual.rows === rowsA)
  check('rows 投影冻结', Object.isFrozen(rowsA) && Object.isFrozen(rowsA[0]!))

  // 2. 就地改文本 + 标脏 + version 递增：可见；旧快照不变。
  const targetIndex = data.rows.length - 1
  const targetRow = data.rows[targetIndex]!
  targetRow.text = 'streamed-in-place'
  targetRow.streaming = true
  markChannelReadDirty(targetRow)
  markChannelReadDirty(data.rows)
  data.version += 1
  const rowsB = actual.rows
  check('就地文本变更后可见', rowsB[targetIndex]!.text === 'streamed-in-place', String(rowsB[targetIndex]!.text))
  check('旧快照未被改写', rowsA[targetIndex]!.text !== 'streamed-in-place')
  check('变更后 rows 身份换新', rowsB !== rowsA)

  // 3. push + 标脏：新行可见。
  data.rows.push({ id: data.nextId++, kind: 'assistant', text: 'appended', streaming: false } as ChatRow)
  markChannelReadDirty(data.rows)
  data.version += 1
  check('push + 标脏后新行可见', actual.rows.length === rowsB.length + 1 && actual.rows[actual.rows.length - 1]!.text === 'appended')

  // 4. 清屏（splice 全部）+ 标脏：可见。
  const beforeClear = actual.rows
  data.rows.length = 0
  markChannelReadDirty(data.rows)
  data.version += 1
  check('清屏后 rows 为空', actual.rows.length === 0)
  check('清屏后旧快照保留', beforeClear.length > 0)

  // 5. 标记数组（tps ring）：标脏后跨 version 身份稳定；未标脏的 push 不可见（契约）；
  //    再次标脏后内容可见。
  markChannelReadDirty(data.tpsSamples)
  data.version += 1
  const tpsA = actual.tpsSamples
  data.version += 1
  check('已标脏 tpsSamples 跨 version 身份稳定', actual.tpsSamples === tpsA)
  data.tpsSamples.push({ tps: 999, at: 999 })
  data.version += 1
  check('未标脏 tpsSamples 的 push 不可见（dirty gate 契约）', actual.tpsSamples === tpsA && actual.tpsSamples.length === tpsA.length)
  markChannelReadDirty(data.tpsSamples)
  data.version += 1
  check('再次标脏 tpsSamples 内容可见', actual.tpsSamples.length === tpsA.length + 1)

  // 6. agentViewRows：同一源数组跨 version 身份稳定；源数组换新后可见。
  const viewA = actual.agentViewRows()
  data.version += 1
  check('agentViewRows 同源身份稳定', actual.agentViewRows() === viewA)
  data.agentViewSource = [{ id: 'agent-b', status: 'needs-input', updatedAt: 2 }]
  const viewB = actual.agentViewRows()
  check('agentViewRows 源换新后身份变化', viewB !== viewA)
  check('agentViewRows 新内容可见', viewB.length === 1 && viewB[0]!.id === 'agent-b')

  // 7. 控制包装：同 version 身份稳定；version 递增换新；就地替换方法 + bump 后生效。
  const controlA = actual.subagentControl
  check('subagentControl 同 version 身份稳定', actual.subagentControl === controlA)
  data.version += 1
  const controlB = actual.subagentControl
  check('subagentControl version 递增后换新', controlB !== controlA)
  const beforeCalls = data.subagentCalls
  controlB.interrupt()
  check('控制包装方法可调用', data.subagentCalls === beforeCalls + 1)

  // 8. job 状态就地改写 + 标脏 + bump：可见。
  data.rows.push({ id: 9001, kind: 'job', text: '', job: { id: 'job-x', kind: 'bash', label: 'x', status: 'running', startedAt: 1, outputLines: [] } } as ChatRow)
  markChannelReadDirty(data.rows)
  data.version += 1
  const sourceJobRow = data.rows[data.rows.length - 1]!
  const jobRow = actual.rows[actual.rows.length - 1]!
  check('job 行初态可见', jobRow.job?.status === 'running')
  sourceJobRow.job!.status = 'completed'
  markChannelReadDirty(sourceJobRow)
  markChannelReadDirty(data.rows)
  data.version += 1
  check('job 状态就地改写后可见', actual.rows[actual.rows.length - 1]!.job?.status === 'completed')

  lease.dispose()
  // 就地变更 / 身份失效断言计数：就地文本、push、清屏、tps 标脏、job 状态、agent-view 源换新。
  stats.T2b.extra.invalidationChecks = 6
  console.log('preflight T2b: ' + String(checks) + ' checks')
}

// ── T2c 前置手写用例（验证参考路径本身） ─────────────────────────────────
interface T2cData {
  rows: ChatRow[]
  notifications: Array<{ id: number; text: string }>
  todos: Array<{ id: number; text: string; status: string }>
  goal: { text: string; status: string } | undefined
  pending: Array<{ id: string; title: string }>
  compaction: { summary: string } | undefined
  tpsSamples: Array<{ tps: number; at: number }>
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextSegments: { system: number; prompt: number; assistant: number }
  commandList: Array<{ name: string; description: string }>
  lastUsage: { input: number; output: number } | undefined
  loadedContext: { system: string; tools: string } | undefined
}
function createT2cData(rng: Rng, rowCount: number): T2cData {
  return {
    rows: makeRowSequence(rng, rowCount, rng.pick(COLUMNS)),
    notifications: [{ id: 1, text: 'n1' }],
    todos: [{ id: 1, text: 'todo-1', status: 'pending' }],
    goal: { text: 'goal', status: 'active' },
    pending: [{ id: 'p1', title: 'pending-1' }],
    compaction: undefined,
    tpsSamples: Array.from({ length: 20 }, (_value, index) => ({ tps: index, at: index })),
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    contextSegments: { system: 1000, prompt: 500, assistant: 250 },
    commandList: Array.from({ length: 50 }, (_value, index) => ({ name: 'cmd-' + String(index), description: 'd' })),
    lastUsage: { input: 10, output: 20 },
    loadedContext: { system: 'sys', tools: 'tools' },
  }
}

function preflightT2c(): void {
  let checks = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks += 1
    stats.T2c.preflightChecks += 1
    if (!ok) {
      stats.T2c.preflightFailures += 1
      console.error('FAIL preflight-T2c ' + name + (detail === '' ? '' : ': ' + detail))
    }
  }
  const rng = createRng(0x3c9)
  const data = createT2cData(rng, 300)
  const view = createChannelReadView(() => undefined)
  const first = view(data, 1) as unknown as { rows: readonly ChatRow[]; tokens: { input: number } }
  const second = view(data, 2) as unknown as { rows: readonly ChatRow[]; tokens: { input: number } }
  check('无标脏跨 version：transcript 容器身份复用', first.rows === second.rows)
  check('无标脏跨 version：内容逐字段相等', deepDiff(first, second) === null, snapshotText(deepDiff(first, second)))
  check('旧快照冻结', Object.isFrozen(first) && Object.isFrozen(first.rows))

  markChannelReadDirty(data.rows)
  const third = view(data, 3) as unknown as { rows: readonly ChatRow[] }
  check('标脏容器后换新', third.rows !== second.rows)

  const sourceRow = data.rows[data.rows.length - 1]!
  sourceRow.text = 'in-place-visible'
  markChannelReadDirty(sourceRow)
  markChannelReadDirty(data.rows)
  const fourth = view(data, 4) as unknown as { rows: readonly ChatRow[] }
  check('就地改字段 + 标脏后可见', fourth.rows[fourth.rows.length - 1]!.text === 'in-place-visible')
  check('就地改字段前的旧快照未被改写', third.rows[third.rows.length - 1]!.text !== 'in-place-visible')

  // 就地改字段但只递增 version、不标脏：dirty gate 契约下保持旧拷贝。
  sourceRow.text = 'in-place-unmarked'
  const fifth = view(data, 5) as unknown as { rows: readonly ChatRow[] }
  check('未标脏的就地改字段保持旧副本（dirty gate 契约）', fifth.rows === fourth.rows && fifth.rows[fifth.rows.length - 1]!.text === 'in-place-visible')

  // 标记数组：标脏后跨 version 身份稳定；再次标脏换新。
  markChannelReadDirty(data.tpsSamples)
  const tpsA = view(data, 6) as unknown as { tpsSamples: readonly unknown[] }
  const tpsB = view(data, 7) as unknown as { tpsSamples: readonly unknown[] }
  check('已标脏数组跨 version 身份稳定', tpsA.tpsSamples === tpsB.tpsSamples)
  data.tpsSamples.push({ tps: 999, at: 999 })
  markChannelReadDirty(data.tpsSamples)
  const tpsC = view(data, 8) as unknown as { tpsSamples: readonly unknown[] }
  check('标脏后数组内容可见', tpsC.tpsSamples.length === tpsA.tpsSamples.length + 1)
  stats.T2c.extra.invalidationChecks = 6
  console.log('preflight T2c: ' + String(checks) + ' checks')
}

// ── T2a fuzz 驱动 ──────────────────────────────────────────────────────
interface T2aFuzzState {
  rng: Rng
  factory: RowFactory
  rows: ChatRow[]
  options: VisibleRowsOptions
  entry: VisibleRowsCacheEntry
  ops: string[]
}
function defaultVisibleOptions(): VisibleRowsOptions {
  return { showAll: false, thinkingVisible: true, turnUsageRow: false, expanded: false, expandedRows: new Set<number>(), jobGroupFold: 'auto' }
}
function initT2aFuzz(rng: Rng): T2aFuzzState {
  const factory: RowFactory = { nextId: 1, rng, columns: rng.pick(COLUMNS) }
  const rows = makeRowSequence(rng, pickRowSize(rng), factory.columns)
  factory.nextId = rows.length + 1
  const options = defaultVisibleOptions()
  return { rng, factory, rows, options, entry: deriveVisibleRows(rows, options, null), ops: [] }
}
function mutateT2a(state: T2aFuzzState): { label: string; rebuild: boolean } {
  const { rng, rows, options } = state
  const windowStart = windowStartOf(rows, options)
  const roll = rng.int(22)
  if (roll <= 4 || rows.length === 0) {
    const row = randomRow(state.factory)
    rows.push(row)
    return { label: 'append:' + row.kind, rebuild: true }
  }
  if (roll === 5) {
    const index = rows.length - 1
    const previous = rows[index]!
    rows[index] = makeAssistantRow(state.factory, previous.id, true, (previous.text || '') + ' delta')
    return { label: 'stream-last-new-object', rebuild: true }
  }
  if (roll === 6) {
    const index = rows.length - 1
    const previous = rows[index]!
    rows[index] = { ...previous, streaming: false } as ChatRow
    return { label: 'settle-last', rebuild: true }
  }
  if (roll === 7) {
    const index = windowStart + rng.int(Math.max(1, rows.length - windowStart))
    const previous = rows[index]!
    rows[index] = { ...previous, streaming: previous.streaming !== true } as ChatRow
    return { label: 'toggle-stream-window', rebuild: true }
  }
  if (roll === 8) {
    if (windowStart > 0) {
      const index = rng.int(windowStart)
      const previous = rows[index]!
      rows[index] = { ...previous, text: (previous.text || '') + ' outside-only' } as ChatRow
      return { label: 'update-outside-window', rebuild: false }
    }
    const row = randomRow(state.factory)
    rows.push(row)
    return { label: 'append(no-outside)', rebuild: true }
  }
  if (roll === 9) {
    if (windowStart > 1) {
      rows.splice(rng.int(windowStart), 1)
      return { label: 'splice-outside', rebuild: true }
    }
    const row = randomRow(state.factory)
    rows.push(row)
    return { label: 'append(no-outside)', rebuild: true }
  }
  if (roll === 10) {
    if (rows.length > windowStart) {
      rows.splice(windowStart + rng.int(rows.length - windowStart), 1)
      return { label: 'splice-window', rebuild: true }
    }
    return { label: 'noop-splice-empty', rebuild: true }
  }
  if (roll === 11) {
    let size = pickRowSize(rng)
    if (size === rows.length) size = size === 0 ? 1 : size - 1
    const nextRows = makeRowSequence(rng, size, state.factory.columns)
    state.factory.nextId = Math.max(state.factory.nextId, size + 1)
    state.rows = nextRows
    state.options = { ...options, expandedRows: new Set<number>() }
    return { label: 'resize:' + String(size), rebuild: true }
  }
  if (roll === 12) {
    // showAll 只通过 windowStart 进入缓存键：短会话（<= 120 行）切换后窗口相同，
    // 派生结果不变，必须命中缓存；长会话窗口起点在 0 / hiddenCount 间移动，必须重建。
    const windowMoves = rows.length > RENDERED_ROW_CAP
    options.showAll = !options.showAll
    return { label: 'toggle-showAll', rebuild: windowMoves }
  }
  if (roll === 13) { options.thinkingVisible = !options.thinkingVisible; return { label: 'toggle-thinkingVisible', rebuild: true } }
  if (roll === 14) { options.turnUsageRow = !options.turnUsageRow; return { label: 'toggle-turnUsageRow', rebuild: true } }
  if (roll === 15) { options.expanded = !options.expanded; return { label: 'toggle-expanded', rebuild: true } }
  if (roll === 16) {
    options.jobGroupFold = options.jobGroupFold === 'auto' ? 'always' : options.jobGroupFold === 'always' ? 'never' : 'auto'
    return { label: 'cycle-jobGroupFold:' + options.jobGroupFold, rebuild: true }
  }
  if (roll === 17) {
    const count = 2 + rng.int(3)
    for (let index = 0; index < count; index += 1) rows.push(makeJobRow(state.factory, state.factory.nextId++, rng.pick(['running', 'completed', 'failed'] as const)))
    return { label: 'append-job-run:' + String(count), rebuild: true }
  }
  if (roll === 18) {
    for (let index = rows.length - 1; index >= Math.max(0, windowStart); index -= 1) {
      const row = rows[index]!
      if (row.kind === 'job' && row.job !== undefined) {
        rows[index] = { ...row, job: { ...row.job, status: rng.pick(['running', 'completed', 'failed', 'killed'] as const) } } as ChatRow
        return { label: 'update-window-job-status', rebuild: true }
      }
    }
    rows.push(makeJobRow(state.factory, state.factory.nextId++, 'completed'))
    return { label: 'append-job(no-window-job)', rebuild: true }
  }
  if (roll === 19) {
    for (let index = Math.min(windowStart, rows.length) - 1; index >= 0; index -= 1) {
      const row = rows[index]!
      if (row.kind === 'job' && row.job !== undefined) {
        rows[index] = { ...row, job: { ...row.job, status: rng.pick(['running', 'completed', 'failed'] as const) } } as ChatRow
        return { label: 'update-outside-job-status', rebuild: false }
      }
    }
    if (windowStart > 0) {
      const index = rng.int(windowStart)
      const previous = rows[index]!
      rows[index] = { ...previous, text: (previous.text || '') + ' outside-only' } as ChatRow
      return { label: 'update-outside-window(fallback)', rebuild: false }
    }
    const row = randomRow(state.factory)
    rows.push(row)
    return { label: 'append(no-outside)', rebuild: true }
  }
  if (roll === 20) {
    const unknownId = 1_000_000_000 + rng.int(1000)
    if (options.expandedRows.has(unknownId)) options.expandedRows.delete(unknownId)
    else options.expandedRows.add(unknownId)
    return { label: 'toggle-expandedRows-unknown', rebuild: false }
  }
  // 21：窗口内插入一个空文本的已落定 assistant（empty-assistant 过滤边界）。
  const emptyIndex = windowStart + rng.int(Math.max(1, rows.length - windowStart))
  rows.splice(emptyIndex, 0, makeAssistantRow(state.factory, state.factory.nextId++, false, '   '))
  return { label: 'insert-empty-assistant', rebuild: true }
}
function stepT2a(state: T2aFuzzState, seed: number, step: number): void {
  const mutation = mutateT2a(state)
  pushOp(state.ops, mutation.label)
  stats.T2a.steps += 1
  const rows = state.rows
  const windowLength = expectedWindowLength(rows, state.options)
  const previous = state.entry
  resetVisibleWindowProbe()
  const next = deriveVisibleRows(rows, state.options, previous)
  state.entry = next
  const probe = readVisibleWindowProbe()
  if (probe.frames !== 1) {
    stats.T2a.extra.probeViolations += 1
    failCheck('T2a', seed, step, 'probe:frames', String(probe.frames), state.ops)
  }
  if (probe.fingerprintVisits !== windowLength) {
    stats.T2a.extra.probeViolations += 1
    failCheck('T2a', seed, step, 'probe:fingerprintVisits', 'got=' + String(probe.fingerprintVisits) + ' want=' + String(windowLength), state.ops)
  }
  const rebuilt = next !== previous
  if (rebuilt !== mutation.rebuild) {
    stats.T2a.extra.hitViolations += 1
    failCheck('T2a', seed, step, 'cache-decision:' + mutation.label, 'rebuilt=' + String(rebuilt) + ' expected=' + String(mutation.rebuild), state.ops)
  }
  if (mutation.rebuild) {
    stats.T2a.extra.rebuilds += 1
    if (probe.rebuilds !== 1) failCheck('T2a', seed, step, 'probe:rebuilds', String(probe.rebuilds), state.ops)
    // 空窗口（rows.length === 0 或 resize:0）的重建派生循环访问 0 个元素，只断言上界。
    const derivationFloor = windowLength > 0 ? 1 : 0
    if (probe.derivationVisits < derivationFloor || probe.derivationVisits > 8 * windowLength + 64) {
      failCheck('T2a', seed, step, 'probe:derivationVisits', String(probe.derivationVisits), state.ops)
    }
  } else {
    stats.T2a.extra.hits += 1
    if (probe.rebuilds !== 0) failCheck('T2a', seed, step, 'probe:rebuilds(hit)', String(probe.rebuilds), state.ops)
    if (probe.derivationVisits !== 0) failCheck('T2a', seed, step, 'probe:derivationVisits(hit)', String(probe.derivationVisits), state.ops)
  }
  const reference = deriveVisibleRows(cloneData(rows), cloneOptions(state.options), null)
  const diff = diffVisibleEntries(next, reference)
  if (diff !== null) failDiff('T2a', seed, step, mutation.label, diff, state.ops)
}

// ── T2b fuzz 驱动 ──────────────────────────────────────────────────────
interface T2bFuzzState {
  rng: Rng
  data: T2bData
  channel: Record<string, unknown>
  ui: ReturnType<typeof createChannelUi>
  lease: ReturnType<typeof createChannelUiLease>
  refLease: ReturnType<typeof createChannelUiLease>
  ops: string[]
}
function initT2bFuzz(rng: Rng): T2bFuzzState {
  const data = createT2bData(rng, pickRowSize(rng))
  const channel = createT2bChannel(data)
  const lease = createChannelUiLease(() => true)
  return { rng, data, channel, ui: createChannelUi(channel as never, 'legacy', lease), lease, refLease: createChannelUiLease(() => true), ops: [] }
}
function findLastIndex(rows: readonly ChatRow[], predicate: (row: ChatRow) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) if (predicate(rows[index]!)) return index
  return -1
}
function mutateT2b(state: T2bFuzzState): string {
  const { rng, data } = state
  const roll = rng.int(30)
  if (data.rows.length === 0 && roll >= 10) {
    data.rows.push(makeAssistantRow({ nextId: data.nextId++, rng, columns: rng.pick(COLUMNS) }, data.nextId, true))
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'seed-append(empty)'
  }
  if (roll <= 2) {
    data.rows.push(randomRow({ nextId: data.nextId++, rng, columns: rng.pick(COLUMNS) }))
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'append-row'
  }
  if (roll === 3 || roll === 4) {
    const index = findLastIndex(data.rows, row => row.kind === 'assistant')
    if (index < 0) {
      data.rows.push(makeAssistantRow({ nextId: data.nextId++, rng, columns: 120 }, data.nextId, true))
      markChannelReadDirty(data.rows)
      data.version += 1
      return 'append-assistant(fallback)'
    }
    const row = data.rows[index]!
    row.text = (row.text || '') + ' chunk-' + String(roll)
    row.streaming = true
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'stream-delta-in-place'
  }
  if (roll === 5) {
    const index = findLastIndex(data.rows, row => row.streaming === true)
    if (index < 0) return 'noop-settle'
    const row = data.rows[index]!
    row.streaming = false
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'settle-in-place'
  }
  if (roll === 6) {
    const index = findLastIndex(data.rows, row => row.kind === 'tool')
    if (index < 0) {
      data.rows.push(makeToolRow({ nextId: data.nextId++, rng, columns: 120 }, data.nextId, 'running'))
      markChannelReadDirty(data.rows)
      data.version += 1
      return 'tool-start(fallback)'
    }
    const row = data.rows[index]!
    if (row.tool === undefined) return 'noop-tool-stream'
    row.tool.status = 'running'
    row.tool.resultText = (row.tool.resultText ?? '') + 'out;'
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'tool-stream-in-place'
  }
  if (roll === 7) {
    const index = findLastIndex(data.rows, row => row.tool?.status === 'running')
    if (index < 0) return 'noop-tool-settle'
    const row = data.rows[index]!
    row.tool!.status = rng.bool(0.8) ? 'ok' : 'error'
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'tool-settle-in-place'
  }
  if (roll === 8) {
    data.rows.push(makeJobRow({ nextId: data.nextId++, rng, columns: 120 }, data.nextId, 'running'))
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'job-append'
  }
  if (roll === 9) {
    const index = findLastIndex(data.rows, row => row.kind === 'job')
    if (index < 0) return 'noop-job-update'
    const row = data.rows[index]!
    if (row.job === undefined) return 'noop-job-update'
    row.job.status = rng.pick(['running', 'stopping', 'completed', 'failed', 'killed'] as const)
    if (row.job.status !== 'running' && row.job.status !== 'stopping') row.job.finishedAt = row.id + 1
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'job-status-in-place'
  }
  if (roll === 10) {
    data.rows.push(makeSubagentRow(data.nextId++))
    data.subagents = [...data.subagents, { agentId: 'agent-' + String(data.nextId), status: rng.pick(['running', 'idle', 'failed'] as const) }]
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'subagent-append'
  }
  if (roll === 11) {
    data.notifications.push({ id: data.notifications.length + 1, text: 'notice-' + String(roll) })
    data.version += 1
    return 'notification-push'
  }
  if (roll === 12) {
    data.notifications.length = 0
    data.version += 1
    return 'notification-clear'
  }
  if (roll === 13) {
    data.todos = [...data.todos, { id: data.todos.length + 1, text: 'todo-' + String(roll), status: 'pending' }]
    data.version += 1
    return 'todos-push'
  }
  if (roll === 14) {
    data.goal = { text: 'goal-' + String(data.version), status: rng.pick(['active', 'paused'] as const) }
    data.version += 1
    return 'goal-replace'
  }
  if (roll === 15) {
    data.pending = [...data.pending, { id: 'p' + String(data.pending.length + 1), title: 'pending' }]
    data.version += 1
    return 'pending-push'
  }
  if (roll === 16) {
    data.compaction = data.compaction === undefined ? { summary: 'compacted-' + String(data.version) } : undefined
    data.version += 1
    return 'compaction-toggle'
  }
  if (roll === 17) {
    data.rows.length = 0
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'clear-rows-in-place'
  }
  if (roll === 18) {
    const count = 1 + rng.int(5)
    for (let index = 0; index < count; index += 1) data.rows.push(randomRow({ nextId: data.nextId++, rng, columns: 120 }))
    markChannelReadDirty(data.rows)
    data.version += 1
    return 'append-batch:' + String(count)
  }
  if (roll === 19) {
    data.tpsSamples.push({ tps: data.tpsSamples.length, at: data.tpsSamples.length })
    markChannelReadDirty(data.tpsSamples)
    data.version += 1
    return 'tps-push-marked'
  }
  if (roll === 20) { data.preferences.thinkingFold = data.preferences.thinkingFold === 'preview' ? 'full' : 'preview'; data.version += 1; return 'pref-thinkingFold' }
  if (roll === 21) { data.preferences.contextBarEnabled = !data.preferences.contextBarEnabled; data.version += 1; return 'pref-contextBar' }
  if (roll === 22) { data.preferences.activityEnabled = !data.preferences.activityEnabled; data.version += 1; return 'pref-activity' }
  if (roll === 23) { data.preferences.activityFrames = rng.pick(['dots', 'line', 'spinner'] as const); data.version += 1; return 'pref-activityFrames' }
  if (roll === 24) { data.preferences.minimalUi = !data.preferences.minimalUi; data.version += 1; return 'pref-minimalUi' }
  if (roll === 25) { data.preferences.turnUsageRow = !data.preferences.turnUsageRow; data.version += 1; return 'pref-turnUsageRow' }
  if (roll === 26) { data.version += 1; return 'unrelated-version-bump' }
  if (roll === 27) {
    data.agentViewSource = data.agentViewSource.map(row => ({ ...row, updatedAt: row.updatedAt + 1, status: rng.pick(['idle', 'running', 'needs-input'] as const) }))
    data.version += 1
    return 'agentview-source-replace'
  }
  if (roll === 28) { data.scene = { id: 'scene-' + String(data.version), title: 'Scene ' + String(data.version) }; data.version += 1; return 'plugin-scene-replace' }
  data.responseChars += 5 + rng.int(20)
  data.activeToolCount = rng.int(4)
  data.working = !data.working
  data.version += 1
  return 'status-fields'
}
function checkT2bAgainstReference(state: T2bFuzzState, seed: number, step: number, op: string): void {
  const actualProps: unknown[] = T2B_PROPS.map(key => (state.ui as unknown as Record<string, unknown>)[key])
  const actualAgentView = state.ui.agentViewRows()
  const cloned = cloneData(state.data)
  const refUi = createChannelUi(createT2bChannel(cloned) as never, 'legacy', state.refLease)
  for (let index = 0; index < T2B_PROPS.length; index += 1) {
    const key = T2B_PROPS[index]!
    const diff = deepDiff(actualProps[index], (refUi as unknown as Record<string, unknown>)[key], 'props.' + key)
    if (diff !== null) {
      failDiff('T2b', seed, step, op + ':' + key, diff, state.ops)
      return
    }
  }
  const agentDiff = deepDiff(actualAgentView, refUi.agentViewRows(), 'agentViewRows')
  if (agentDiff !== null) failDiff('T2b', seed, step, op + ':agentViewRows', agentDiff, state.ops)
}
function stepT2b(state: T2bFuzzState, seed: number, step: number): void {
  stats.T2b.steps += 1
  const op = mutateT2b(state)
  pushOp(state.ops, op)
  checkT2bAgainstReference(state, seed, step, op)
}

// ── T2c fuzz 驱动 ──────────────────────────────────────────────────────
interface T2cFuzzState {
  rng: Rng
  data: T2cData
  view: ReturnType<typeof createChannelReadView>
  version: number
  ops: string[]
}
function initT2cFuzz(rng: Rng): T2cFuzzState {
  return { rng, data: createT2cData(rng, pickRowSize(rng)), view: createChannelReadView(() => undefined), version: 0, ops: [] }
}
function mutateT2c(state: T2cFuzzState): string {
  const { rng, data } = state
  const roll = rng.int(22)
  if (data.rows.length === 0 && roll <= 9) {
    data.rows.push(randomRow({ nextId: 100000, rng, columns: 120 }))
    markChannelReadDirty(data.rows)
    return 'append-row(empty)'
  }
  if (roll <= 3) {
    data.rows.push(randomRow({ nextId: 100000 + data.rows.length, rng, columns: 120 }))
    markChannelReadDirty(data.rows)
    return 'append-row'
  }
  if (roll === 4) {
    const index = findLastIndex(data.rows, row => row.kind === 'assistant')
    if (index < 0) return 'noop-stream'
    const row = data.rows[index]!
    row.text = (row.text || '') + ' chunk'
    row.streaming = true
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    return 'stream-in-place'
  }
  if (roll === 5) {
    const index = findLastIndex(data.rows, row => row.streaming === true)
    if (index < 0) return 'noop-settle'
    const row = data.rows[index]!
    row.streaming = false
    markChannelReadDirty(row)
    markChannelReadDirty(data.rows)
    return 'settle-in-place'
  }
  if (roll === 6) {
    const index = rng.int(data.rows.length)
    const previous = data.rows[index]!
    data.rows[index] = { ...previous, text: (previous.text || '') + ' replaced' } as ChatRow
    markChannelReadDirty(data.rows)
    return 'replace-row-object'
  }
  if (roll === 7) {
    data.rows.splice(rng.int(data.rows.length), 1)
    markChannelReadDirty(data.rows)
    return 'splice-row'
  }
  if (roll === 8) {
    data.rows.length = 0
    markChannelReadDirty(data.rows)
    return 'clear-rows'
  }
  if (roll === 9) {
    const count = 1 + rng.int(3)
    for (let index = 0; index < count; index += 1) data.rows.unshift(randomRow({ nextId: 200000 + index, rng, columns: 120 }))
    markChannelReadDirty(data.rows)
    return 'prepend-older:' + String(count)
  }
  if (roll === 10) { data.tpsSamples.push({ tps: 500 + data.tpsSamples.length, at: data.tpsSamples.length }); markChannelReadDirty(data.tpsSamples); return 'tps-push' }
  if (roll === 11) { markChannelReadDirty(data.tpsSamples); return 'tps-mark-only' }
  if (roll === 12) { data.notifications.push({ id: data.notifications.length + 1, text: 'n' }); return 'notification-push-unmarked-array' }
  if (roll === 13) { data.todos = [...data.todos, { id: data.todos.length + 1, text: 't', status: 'done' }]; return 'todos-replace' }
  if (roll === 14) { data.goal = { text: 'goal-' + String(data.todos.length), status: 'active' }; return 'goal-replace' }
  if (roll === 15) { data.pending = [...data.pending, { id: 'p' + String(data.pending.length + 1), title: 'p' }]; return 'pending-push' }
  if (roll === 16) { data.compaction = data.compaction === undefined ? { summary: 'c' } : undefined; return 'compaction-toggle' }
  if (roll === 17) { data.commandList = [...data.commandList, { name: 'cmd-x', description: 'd' }]; return 'commandList-push' }
  if (roll === 18) { data.lastUsage = { input: data.commandList.length, output: data.todos.length }; return 'lastUsage-replace' }
  if (roll === 19) { data.contextSegments = { system: data.contextSegments.system + 1, prompt: data.contextSegments.prompt, assistant: data.contextSegments.assistant }; return 'contextSegments-replace' }
  if (roll === 20) { data.tokens = { ...data.tokens, output: data.tokens.output + 1 }; return 'tokens-replace' }
  if (roll === 21) {
    if (data.rows.length === 0) return 'noop-mark-row-only'
    const index = rng.int(data.rows.length)
    markChannelReadDirty(data.rows[index]!)
    return 'mark-row-only'
  }
  return 'version-only'
}
function stepT2c(state: T2cFuzzState, seed: number, step: number): void {
  stats.T2c.steps += 1
  const op = mutateT2c(state)
  pushOp(state.ops, op)
  state.version += 1
  const actual = state.view(state.data, state.version)
  const reference = createChannelReadView(() => undefined)(state.data, state.version)
  const diff = deepDiff(actual, reference, 'snapshot')
  if (diff !== null) failDiff('T2c', seed, step, op, diff, state.ops)
}

// ── 主驱动与报告 ────────────────────────────────────────────────────────
function main(): void {
  const startedAt = Date.now()
  const mode = quick ? 'quick' : 'full'
  console.log('T2 缓存差分 fuzz：mode=' + mode + ' steps=' + String(totalSteps) + ' seeds=' + String(seeds.length) +
    ' node=' + process.version + ' lang=' + String(process.env.DSH_TUI_LANG))
  console.log('seeds=' + seeds.map(seed => '0x' + seed.toString(16)).join(','))

  preflightT2a()
  preflightT2b()
  preflightT2c()
  const preflightFailures = stats.T2a.preflightFailures + stats.T2b.preflightFailures + stats.T2c.preflightFailures
  const preflightChecks = stats.T2a.preflightChecks + stats.T2b.preflightChecks + stats.T2c.preflightChecks
  console.log('前置手写用例：' + String(preflightChecks - preflightFailures) + '/' + String(preflightChecks) + ' 通过')
  if (preflightFailures > 0) {
    console.error('前置用例失败：参考路径不可信，终止 fuzz。')
    process.exit(1)
  }

  const basePerSeed = Math.floor(totalSteps / seeds.length)
  const remainder = totalSteps % seeds.length
  for (let seedIndex = 0; seedIndex < seeds.length; seedIndex += 1) {
    const seed = seeds[seedIndex]!
    const seedSteps = basePerSeed + (seedIndex < remainder ? 1 : 0)
    const stateA = initT2aFuzz(createRng(seed))
    const stateB = initT2bFuzz(createRng((seed ^ 0x5f3759df) >>> 0))
    const stateC = initT2cFuzz(createRng((seed ^ 0x85ebca6b) >>> 0))
    for (let index = 0; index < seedSteps; index += 1) {
      if (index % 3 === 0) stepT2a(stateA, seed, index)
      else if (index % 3 === 1) stepT2b(stateB, seed, index)
      else stepT2c(stateC, seed, index)
    }
    stateB.lease.dispose()
  }

  const totalFailures = stats.T2a.diffs + stats.T2b.diffs + stats.T2c.diffs +
    stats.T2a.assertionFailures + stats.T2b.assertionFailures + stats.T2c.assertionFailures
  const elapsedMs = Date.now() - startedAt
  console.log('')
  console.log('T2 缓存差分结果（' + mode + '，' + String(totalSteps) + ' 步，' + String(elapsedMs) + ' ms）')
  for (const sub of ['T2a', 'T2b', 'T2c'] as const) {
    const item = stats[sub]
    const extra = Object.entries(item.extra).map(([key, value]) => key + '=' + String(value)).join(' ')
    console.log(sub + ' 步数=' + String(item.steps) + ' 差异=' + String(item.diffs) + ' 断言失败=' + String(item.assertionFailures) +
      ' 差分对象=' + JSON.stringify(item.firstDiff) + ' ' + extra)
    if (item.firstFailureCase !== null) console.log(sub + ' 首个失败用例：' + item.firstFailureCase)
    if (item.failedCases.length > 0) console.log(sub + ' 失败用例列表：' + item.failedCases.join(','))
  }
  const pass = totalFailures === 0
  console.log('')
  console.log('T2 缓存差分 fuzz：' + (pass ? 'PASS（零差异）' : 'FAIL（差异/断言失败 ' + String(totalFailures) + '）'))
  if (failureDir !== undefined && !pass) {
    try {
      mkdirSync(failureDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const failurePath = join(failureDir, 't2-equiv-fuzz-failure-' + mode + '-' + stamp + '.json')
      writeFileSync(failurePath, JSON.stringify({
        mode,
        steps: totalSteps,
        seeds: seeds.map(seed => '0x' + seed.toString(16)),
        elapsedMs,
        node: process.version,
        stats,
        failures: failures.map(record => ({ ...record, actual: snapshotText(record.actual), expected: snapshotText(record.expected) })),
      }, null, 2))
      console.log('失败快照已写入：' + failurePath)
    } catch (error) {
      console.error('写失败快照出错：' + String(error))
    }
  }
  console.log('EQUIV_FUZZ_SUMMARY ' + JSON.stringify({
    mode,
    steps: totalSteps,
    seeds: seeds.length,
    elapsedMs,
    pass,
    sub: {
      T2a: { steps: stats.T2a.steps, diffs: stats.T2a.diffs, assertionFailures: stats.T2a.assertionFailures },
      T2b: { steps: stats.T2b.steps, diffs: stats.T2b.diffs, assertionFailures: stats.T2b.assertionFailures },
      T2c: { steps: stats.T2c.steps, diffs: stats.T2c.diffs, assertionFailures: stats.T2c.assertionFailures },
    },
  }))
  process.exit(pass ? 0 : 1)
}
main()
