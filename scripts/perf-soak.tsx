/**
 * perf-soak — T5 长时浸泡（一次性测量，不进 CI 组）。
 *
 * 目的：在持续负载下观察窗口缓存、身份缓存与读投影复用是否缓慢泄漏或
 * 随时间劣化。假后端、不接真实会话；每轮（默认 1 分钟）执行：
 *
 *   追加约 200 行流式输出 → 滚动 20 次 → 切换侧边面板/视图 10 次
 *   → 读投影重建 1 次 → 就地变更 1 次 → 采样并写 CSV。
 *
 * 采样字段：rss / heapUsed / external / activeHandles / 窗口缓存条目数
 * （VisibleWindowProbe.windowLength；组件内部 heights Map 未导出，以其为
 * 代理）、窗口推导计数、读投影版本号与副本/访问/标记计数、本轮耗时。
 *
 * 判据（计划 §4 T5）：前 5 分钟为预热；第 5–30 分钟 heapUsed 回归斜率
 * < 0.5 MB/min、末轮相对第 5 分钟增长 ≤ 32 MB；rss 增长 ≤ 64 MB；
 * 末轮 activeHandles ≤ 第 5 分钟值；无未捕获异常；末轮渲染文本非空且
 * 行数符合预期。--minutes < 6 时只记录原始曲线，趋势判定标 SKIPPED。
 *
 * 运行（在 9.SRC/dsh-TUI 内；日志/CSV 目录在项目根 TMP 下）：
 *   node --import tsx/esm scripts/perf-soak.tsx --minutes 2 \
 *     --out ../../TMP/07_验证日志/05_长时浸泡/soak-smoke-<时间戳>.csv
 *   node --import tsx/esm scripts/perf-soak.tsx --minutes 30 \
 *     --out ../../TMP/07_验证日志/05_长时浸泡/soak-samples-<时间戳>.csv
 *
 * 参数：
 *   --minutes <n>   浸泡分钟数，默认 30（最小 1）
 *   --out <path>    采样 CSV 路径；文件已存在时拒绝运行（不覆盖历史）
 *   --seed-rows <n> 预置转录行数，默认 1200（可复现的起点规模）
 *
 * 退出码：0 = 运行完成（含趋势不达标的如实记录）；1 = 异常退出/参数错误。
 * 趋势结论以 stdout 的 `perf-soak: VERDICT` 行为准，不改变阈值。
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_PERF_COUNTERS = '1'

const { mkdirSync, appendFileSync, existsSync, writeFileSync } = await import('node:fs')
const { dirname, resolve } = await import('node:path')
const { fileURLToPath } = await import('node:url')

const [
  { execFileSync },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  ui,
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  { createChannelReadView, markChannelReadDirty },
  { perfReset, perfValue },
  { readVisibleWindowProbe, resetVisibleWindowProbe, RENDERED_ROW_CAP },
  { viewportLines },
  { applySidePanelOpen, getSidePanelOpen, applySidePanelSplitEnabled, applySidePanelPanels },
  fx,
] = await Promise.all([
  import('node:child_process'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/adapter/channel/read-view.js'),
  import('../src/utils/perfCounters.js'),
  import('../src/components/MessageList.js'),
  import('./lib/term-test.mjs'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/long-session-fixture.js'),
])

const { render, AlternateScreen } = ui

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}
const minutes = Number(argOf('--minutes') ?? 30)
const seedRows = Number(argOf('--seed-rows') ?? 1200)
const outArg = argOf('--out')
if (!Number.isFinite(minutes) || minutes < 1 || !Number.isInteger(minutes)) {
  console.error('perf-soak: --minutes 必须是 >= 1 的整数')
  process.exit(1)
}
if (!Number.isFinite(seedRows) || seedRows < 0 || !Number.isInteger(seedRows)) {
  console.error('perf-soak: --seed-rows 必须是 >= 0 的整数')
  process.exit(1)
}
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const outPath = resolve(outArg ?? resolve(repoRoot, '../../TMP/07_验证日志/05_长时浸泡/soak-samples.csv'))
if (!outArg && existsSync(outPath)) {
  console.error('perf-soak: 默认 CSV 已存在，请用 --out 指定新文件（不覆盖历史）：' + outPath)
  process.exit(1)
}
if (existsSync(outPath)) {
  console.error('perf-soak: --out 指向的文件已存在，拒绝覆盖：' + outPath)
  process.exit(1)
}
mkdirSync(dirname(outPath), { recursive: true })

// ── 固定尺寸与工具 ─────────────────────────────────────────────────────────
const COLS = 120
const ROWS = 40
const ROWS_PER_ROUND = 200
const STREAM_BATCHES = 20
const ROWS_PER_BATCH = ROWS_PER_ROUND / STREAM_BATCHES
const SCROLL_TIMES = 20
const PANEL_SWITCH_TIMES = 10
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const mib = (bytes) => bytes / 1048576
const round2 = (value) => Math.round(value * 100) / 100

const log = (...parts) => {
  console.log('perf-soak:', ...parts)
}

/** 载入 Git HEAD（记录测量基线，失败不影响运行）。 */
const gitHead = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
})()

// ── 假后端状态：mutable rows + 真实 read-view 投影 ────────────────────────
const mutableRows = fx.buildTranscriptRows(seedRows)
let nextRowId = seedRows + 1
const listeners = new Set()
let version = 0
const state = {
  rows: mutableRows,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  lastUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, at: 0 },
  goal: undefined,
  todos: [],
  pending: [],
  notifications: [],
  commandList: LOCAL_COMMANDS,
  tpsSamples: [],
}
const readView = createChannelReadView(() => undefined)
let snapshot = readView(state, version)
/** 记录一次读投影版本变更：重建（容器脏）与就地变更（行+容器脏）走同一条发布路径。 */
const publish = () => {
  version += 1
  snapshot = readView(state, version)
  channel.version = version
  for (const listener of [...listeners]) listener()
}
const touchRow = (row) => {
  markChannelReadDirty(row)
  markChannelReadDirty(state.rows)
}

const channel = {
  // 探针确定性：鲸鱼欢迎期闲置动画不进测量窗口。
  whaleIdle: false,
  version: 0,
  get rows() { return snapshot.rows },
  status: 'idle',
  sessionTitle: 'soak',
  sessionId: 'soak-headless-session',
  agentId: 'soak',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  lastUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, at: 0 },
  contextWindow: 128000,
  cwd: '/tmp/soak',
  displayCwd: '/tmp/soak',
  gitBranch: 'soak',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  pending: [],
  todos: [],
  backgroundJobs: [],
  goal: undefined,
  commandList: LOCAL_COMMANDS,
  notifications: [],
  mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8',
  agentPreset: undefined,
  subagents: [],
  lastUserText: 'spike',
  scrollGutter: 'timeline',
  subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  submit() {},
  cancel() {},
  clear() {},
  notify() {},
  listModels() { return Promise.resolve([]) },
  listSessions() { return Promise.resolve([]) },
  deleteSession() { return Promise.resolve(true) },
  renameSessionTo() { return Promise.resolve(true) },
  setResumeTarget() {},
  loadOlder() {},
  mcpStatus() { return [] },
  pushLocal() {},
  commandCompletions(input) { return completeCommands(input) },
}

// ── 渲染器与假终端 ─────────────────────────────────────────────────────────
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let outBytes = 0
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk, _encoding, callback) {
    const text = String(chunk)
    outBytes += text.length
    term.write(text, callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk, _encoding, callback) { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()

let frameCount = 0
const instance = await render(
  React.createElement(AlternateScreen, null,
    React.createElement(Chat, { channel, questionStore: new QuestionStore(), fullscreen: true }),
  ),
  {
    stdout: new FakeStdout(),
    stderr: new FakeStderr(),
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: () => { frameCount += 1 },
  },
)

/** 等到至少 n 个新帧（或超时）；等待与断言分开，超时由调用方决定是否致命。 */
const waitFrames = async (n = 1, timeoutMs = 1500) => {
  const target = frameCount + n
  const deadline = Date.now() + timeoutMs
  while (frameCount < target && Date.now() < deadline) await delay(5)
  return frameCount >= target
}
/** 等一次发布后的渲染落地；超时仅记录，不中断浸泡。 */
const flush = async (timeoutMs = 1500) => {
  if (!(await waitFrames(1, timeoutMs))) renderTimeouts += 1
}
let renderTimeouts = 0

// 先让首屏与工作负载热身：首屏稳定后再开始计分钟。
await waitFrames(3, 5000)
await delay(1000)

// ── 采样与 CSV ─────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  'round', 'elapsedMin', 'wallClock',
  'rssMB', 'heapUsedMB', 'externalMB', 'activeHandles',
  'windowEntries', 'windowFrames', 'windowRebuilds', 'windowFingerprintVisits', 'windowDerivationVisits',
  'viewVersion', 'readviewCopies', 'readviewVisits', 'markDirty', 'versionBumps',
  'rows', 'roundMs', 'inPlaceOk', 'panelOpen', 'viewportNonEmptyLines', 'renderTimeouts',
]
writeFileSync(outPath, CSV_COLUMNS.join(',') + '\n', 'utf8')
const writeCsv = (record) => {
  appendFileSync(outPath, CSV_COLUMNS.map((name) => String(record[name])).join(',') + '\n', 'utf8')
}

// ── 每轮工作负载 ───────────────────────────────────────────────────────────
/** 追加一行合成转录（流式输出的一行）。 */
const appendRow = (round, batch, index) => {
  const id = nextRowId++
  const marker = `浸泡R${round}B${batch}L${index}`
  mutableRows.push({
    id,
    kind: 'assistant',
    text: `${marker} 第 1 行文本，用于滚动与窗口缓存压力。\n${marker} 第 2 行文本。`,
  })
}

const runRound = async (round) => {
  resetVisibleWindowProbe()
  perfReset()
  const timeoutsAtStart = renderTimeouts
  const roundStart = performance.now()

  // 1) 追加约 200 行流式输出：20 批 × 10 行，每批发布并等一帧。
  for (let batch = 0; batch < STREAM_BATCHES; batch++) {
    for (let index = 0; index < ROWS_PER_BATCH; index++) appendRow(round, batch, index)
    markChannelReadDirty(state.rows)
    publish()
    await flush()
    await delay(8) // 固定窗:pacing 模拟流式增量到达节奏
  }

  // 2) 滚动 20 次：交替滚轮上/下，落在转录区域内。
  for (let index = 0; index < SCROLL_TIMES; index++) {
    stdin.write(index % 2 === 0 ? '\x1b[<64;60;20M' : '\x1b[<65;60;20M')
    await delay(8) // 固定窗:pacing 滚轮事件步间
    await flush()
  }

  // 3) 切换侧边面板/视图 10 次：偶数次 Ctrl+B（智能三态），奇数次右方向键切面板页。
  for (let index = 0; index < PANEL_SWITCH_TIMES; index++) {
    stdin.write(index % 2 === 0 ? '\x02' : '\x1b[C')
    await delay(10) // 固定窗:pacing 按键步间与布局重排
    await flush()
  }

  // 4) 读投影重建：容器脏 → 下一版本重建冻结容器（行对象按脏版本复用）。
  markChannelReadDirty(state.rows)
  publish()
  await flush()

  // 5) 就地变更：原地改一行文本，同时标记行与容器（真实 touchRow 语义）。
  const target = mutableRows[mutableRows.length - 1]
  target.text += ' ◇就地'
  touchRow(target)
  publish()
  await flush()
  const inPlaceOk = snapshot.rows[snapshot.rows.length - 1]?.text?.endsWith(' ◇就地') === true

  // 6) 采样。
  const memory = process.memoryUsage()
  const probe = readVisibleWindowProbe()
  const viewport = viewportLines(term, ROWS)
  const record = {
    round,
    elapsedMin: round2((Date.now() - roundStartEpoch) / 60000),
    wallClock: new Date().toISOString(),
    rssMB: round2(mib(memory.rss)),
    heapUsedMB: round2(mib(memory.heapUsed)),
    externalMB: round2(mib(memory.external)),
    activeHandles: process.getActiveResourcesInfo().length,
    windowEntries: probe.windowLength,
    windowFrames: probe.frames,
    windowRebuilds: probe.rebuilds,
    windowFingerprintVisits: probe.fingerprintVisits,
    windowDerivationVisits: probe.derivationVisits,
    viewVersion: version,
    readviewCopies: perfValue('readview.copies'),
    readviewVisits: perfValue('readview.visits'),
    markDirty: perfValue('channel.markDirty'),
    versionBumps: perfValue('channel.versionBumps'),
    rows: mutableRows.length,
    roundMs: round2(performance.now() - roundStart),
    inPlaceOk: inPlaceOk ? 1 : 0,
    panelOpen: getSidePanelOpen() ? 1 : 0,
    viewportNonEmptyLines: viewport.filter((line) => line.trim() !== '').length,
    renderTimeouts: renderTimeouts - timeoutsAtStart,
  }
  writeCsv(record)
  log(
    `round ${round}/${minutes} elapsed=${record.elapsedMin.toFixed(2)}min`
    + ` rss=${record.rssMB.toFixed(1)}MB heap=${record.heapUsedMB.toFixed(1)}MB`
    + ` ext=${record.externalMB.toFixed(1)}MB handles=${record.activeHandles}`
    + ` windowEntries=${record.windowEntries} rebuilds=${record.windowRebuilds}`
    + ` copies=${record.readviewCopies} rows=${record.rows}`
    + ` roundMs=${record.roundMs.toFixed(0)} inPlaceOk=${record.inPlaceOk}`
    + ` panelOpen=${record.panelOpen} viewportLines=${record.viewportNonEmptyLines}`,
  )
  return record
}

/** 最小二乘斜率。 */
const slopeOf = (points) => {
  const n = points.length
  if (n < 2) return 0
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y }
  const denom = n * sxx - sx * sx
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom
}

const roundStartEpoch = Date.now()
const records = []
let fatalError = null
process.on('uncaughtException', (error) => {
  fatalError = error
  log('FATAL uncaughtException', error?.stack ?? String(error))
})
process.on('unhandledRejection', (reason) => {
  fatalError = reason instanceof Error ? reason : new Error(String(reason))
  log('FATAL unhandledRejection', fatalError.stack)
})

// 面板初始为收起；分栏开关取默认值，确保 Ctrl+B 能真正打开右栏。
// 面板只启用 todo/jobs：其余内置面板读真实后端字段，假后端下会走错误边界。
applySidePanelOpen(false)
applySidePanelSplitEnabled(true)
applySidePanelPanels('todo,jobs')
log(
  `start minutes=${minutes} seedRows=${seedRows} out=${outPath}`
  + ` node=${process.version} pid=${process.pid} git=${gitHead}`
  + ` cols=${COLS} rows=${ROWS} renderedRowCap=${RENDERED_ROW_CAP}`,
)

// ── 主循环：每轮在整分钟边界开始 ──────────────────────────────────────────
try {
  for (let round = 1; round <= minutes; round++) {
    const targetTime = roundStartEpoch + round * 60000
    while (Date.now() < targetTime) await delay(Math.min(5000, targetTime - Date.now()))
    if (fatalError !== null) break
    records.push(await runRound(round))
  }
} finally {
  try { await instance.unmount() } catch { /* 收尾失败不掩盖主结论 */ }
}

// ── 趋势判定（如实记录，不改阈值）─────────────────────────────────────────
const WARMUP_ROUNDS = 5
const trendPoints = records.filter((record) => record.round >= WARMUP_ROUNDS)
const baseline = records.find((record) => record.round === WARMUP_ROUNDS) ?? null
const last = records.at(-1) ?? null
const slope = slopeOf(trendPoints.map((record) => [record.round, record.heapUsedMB]))
const heapGrowth = baseline !== null && last !== null ? last.heapUsedMB - baseline.heapUsedMB : null
const rssGrowth = baseline !== null && last !== null ? last.rssMB - baseline.rssMB : null
const finalViewportOk = last !== null && last.viewportNonEmptyLines > 0
const expectedRows = seedRows + ROWS_PER_ROUND * minutes
const rowsOk = last !== null && last.rows === expectedRows
const inPlaceAllOk = records.every((record) => record.inPlaceOk === 1)
const handlesOk = baseline !== null && last !== null ? last.activeHandles <= baseline.activeHandles : null
const runOk = fatalError === null && records.length === minutes
const canJudge = minutes >= WARMUP_ROUNDS + 1 && records.length >= WARMUP_ROUNDS + 1

const criteria = [
  { name: '无未捕获异常且跑满全部轮次', ok: runOk, detail: `errors=${fatalError === null ? 0 : 1} rounds=${records.length}/${minutes}` },
  { name: '末轮渲染文本非空', ok: finalViewportOk, detail: last === null ? 'no-sample' : `viewportNonEmptyLines=${last.viewportNonEmptyLines}` },
  { name: '末轮行数符合预期', ok: rowsOk, detail: last === null ? 'no-sample' : `rows=${last.rows} expected=${expectedRows}` },
  { name: '就地变更在快照中可见', ok: inPlaceAllOk, detail: `rounds_ok=${records.filter((record) => record.inPlaceOk === 1).length}/${records.length}` },
]
if (canJudge) {
  criteria.push(
    { name: 'heapUsed 回归斜率 < 0.5 MB/min', ok: slope < 0.5, detail: `slope=${slope.toFixed(3)} MB/min points=${trendPoints.length}` },
    { name: '末轮相对第 5 分钟 heapUsed 增长 ≤ 32 MB', ok: heapGrowth !== null && heapGrowth <= 32, detail: `growth=${heapGrowth?.toFixed(2)} MB` },
    { name: 'rss 增长 ≤ 64 MB', ok: rssGrowth !== null && rssGrowth <= 64, detail: `growth=${rssGrowth?.toFixed(2)} MB` },
    { name: '末轮 activeHandles ≤ 第 5 分钟值', ok: handlesOk === true, detail: `last=${last?.activeHandles} baseline=${baseline?.activeHandles}` },
  )
}
const verdict = !canJudge ? 'SKIPPED(预热未满 5 轮，--minutes 需 ≥ 6 才判定趋势)' : criteria.every((item) => item.ok) ? 'PASS' : 'FAIL'

const summary = {
  minutes, seedRows, outPath, git: gitHead, node: process.version,
  samples: records.length, renderTimeouts,
  rssMB: last === null ? null : { first: records[0]?.rssMB, fifth: baseline?.rssMB ?? null, last: last.rssMB, growth: rssGrowth },
  heapUsedMB: last === null ? null : { first: records[0]?.heapUsedMB, fifth: baseline?.heapUsedMB ?? null, last: last.heapUsedMB, growth: heapGrowth, slope },
  activeHandles: { first: records[0]?.activeHandles, fifth: baseline?.activeHandles ?? null, last: last?.activeHandles ?? null },
  maxActiveHandles: records.reduce((max, record) => Math.max(max, record.activeHandles), 0),
  finalRows: last?.rows ?? null,
  expectedRows,
  fatalError: fatalError === null ? null : String(fatalError?.stack ?? fatalError),
  criteria,
  verdict,
}
log('summary ' + JSON.stringify(summary))
log('VERDICT ' + verdict)
for (const item of criteria) {
  log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  [${item.detail}]`)
}
if (verdict === 'SKIPPED') log('提示：冒烟只验证驱动与采样链路，趋势判定要 --minutes >= 6 正式运行。')

process.exit(fatalError === null && runOk ? 0 : 1)