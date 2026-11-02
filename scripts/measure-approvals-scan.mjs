/**
 * measure-approvals-scan — approvals 扫描成本基线（WP5）。
 *
 * 目的：量化 `ApprovalStore.park()` 里两次会话日志倒扫（`commandOf`、
 * `isLiveToolApproval`）与活跃审批重检（`refreshActiveExternal`）的耗时，
 * 判断成本随「总事件数」增长还是只随「调用位置到日志末尾的距离」增长。
 *
 * 测量对象是真实 `src/dsh-adapter/approvals.ts`（import 源码，不是副本）；
 * fixture 来自 scripts/lib/long-session-fixture.ts。
 *
 * 场景：
 * - genuine-live-tail：真实审批路径，tool/call 刚追加在日志末尾；
 * - genuine-mid-call：合成对照（调用被埋在日志中点），演示扫描距离成本；
 * - settled-tail：同 callId 已有 tool/result，判定应为 external；
 * - unknown-call：callId 不在日志里（伪造/外来请求），全量倒扫的最坏情况；
 * - active-recheck：审批在面板上等待期间，日志继续追加 tool/result 时的增量重检。
 *
 * 运行：
 *   node --import tsx/esm scripts/measure-approvals-scan.mjs
 *   node --import tsx/esm scripts/measure-approvals-scan.mjs --json
 *
 * 输出：中位数 µs/次（每场景先预热 3 轮）。--json 输出机读结果，并附语义断言。
 * 退出码：0 = 断言全过；1 = 有断言失败。
 */

const { execFileSync } = await import('node:child_process')
const { ApprovalStore } = await import('../src/dsh-adapter/approvals.js')
const fx = await import('./lib/long-session-fixture.js')

const JSON_MODE = process.argv.includes('--json')
const SIZES = [1000, 10000, 100000]
const ROUNDS_FOR = size => (size >= 100000 ? 41 : size >= 10000 ? 101 : 201)
const WARMUP = 3

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const roundTo = (value, digits = 2) => Number(value.toFixed(digits))

/**
 * 预热后重复执行 fn，返回每轮耗时的中位数（µs）。
 * fn 内部必须自行清理（settleAll），否则计时会把上一轮残留算进来。
 */
const measure = (fn, rounds) => {
  for (let i = 0; i < WARMUP; i++) fn()
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    fn()
    samples.push((performance.now() - start) * 1000)
  }
  return median(samples)
}

/** 单次 park：用全新 store，避免 consumedCallIds 把重复 callId 标成 external。 */
const parkOnce = request => {
  const store = new ApprovalStore()
  store.park(request)
  store.settleAll('cancelled')
}

const gitCommit = () => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

const environment = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  commit: gitCommit(),
  date: new Date().toISOString(),
  fixture: 'scripts/lib/long-session-fixture.ts (toolEvery=12)',
}

const scenarios = [
  {
    id: 'genuine-live-tail',
    note: '真实路径：tool/call 在末尾（未结算）',
    make: size => fx.buildApprovalScenario({ totalEvents: size }),
  },
  {
    id: 'genuine-mid-call',
    note: '合成对照：tool/call 在中点（扫描距离 = N/2）',
    make: size => fx.buildApprovalScenario({ totalEvents: size, callAt: 'middle' }),
  },
  {
    id: 'settled-tail',
    note: '同 callId 已有 tool/result（应判 external）',
    make: size => fx.buildApprovalScenario({ totalEvents: size, settled: true }),
  },
  {
    id: 'unknown-call',
    note: 'callId 不在日志（伪造/外来请求，全量倒扫）',
    make: size => fx.buildUnknownCallScenario(size),
  },
]

const results = []
for (const scenario of scenarios) {
  const row = { id: scenario.id, note: scenario.note, bySize: {} }
  for (const size of SIZES) {
    const built = scenario.make(size)
    const rounds = ROUNDS_FOR(size)
    row.bySize[size] = roundTo(measure(() => parkOnce(built.request), rounds))
    row.events = built.events.length
  }
  results.push(row)
}

// 冷快照对照：真实 Session.snapshotEvents() 在 append 后缓存失效，下一次读取
// 复制整个日志（O(N)）。这里让每次 park 前都失效一次，测「审批恰好是 append 后
// 第一个快照读者」的最坏情况；热缓存真实路径为 0 复制。
const coldTail = []
for (const size of SIZES) {
  const built = fx.buildApprovalScenario({ totalEvents: size })
  let cache = null
  const coldSession = {
    snapshotEvents() {
      cache ??= Object.freeze([...built.events])
      return cache
    },
    invalidate() { cache = null },
  }
  const request = {
    agent: { id: 'fixture-agent', session: coldSession },
    toolName: 'Bash',
    callId: built.callId,
    reason: 'cold snapshot scenario',
  }
  coldTail.push({ size, micros: roundTo(measure(() => { coldSession.invalidate(); parkOnce(request) }, ROUNDS_FOR(size))) })
}
// 活跃审批等待期间的增量重检：每次追加 1 条 tool/result 后通知一次。
// 距离 = 日志末尾到活跃 tool/call 之间的事件数；每个距离取多次独立样本
// （每次样本用全新 store park 一次，再追加 1 条事件并计时 noteSessionEvent）。
const recheckDistances = [0, 1, 10, 100, 1000]
const recheck = []
for (const size of [1000, 100000]) {
  const byDistance = {}
  for (const distance of recheckDistances) {
    const callAt = Math.max(0, size - 1 - distance)
    const scenario = fx.buildApprovalScenario({ totalEvents: size, callAt })
    const trials = distance >= 1000 ? 15 : 25
    const samples = []
    for (let t = 0; t < trials; t++) {
      const store = new ApprovalStore()
      store.park(scenario.request)
      const event = fx.appendToolResult(scenario.events, `recheck-other-${distance}-${t}`)
      const start = performance.now()
      store.noteSessionEvent('fixture-agent', event)
      samples.push((performance.now() - start) * 1000)
      store.settleAll('cancelled')
    }
    byDistance[distance] = roundTo(median(samples))
  }
  recheck.push({ size, byDistance, trialsPerPoint: recheckDistances.map(d => (d >= 1000 ? 15 : 25)) })
}

// 守卫成本：活跃审批、日志未变化时的 getSnapshot()（渲染热路径）。
const snapshotScenario = fx.buildApprovalScenario({ totalEvents: 100000 })
const snapshotStore = new ApprovalStore()
snapshotStore.park(snapshotScenario.request)
const snapshotNoChange = roundTo(measure(() => { snapshotStore.getSnapshot() }, 2000), 3)
snapshotStore.settleAll('cancelled')

// 上游快照物化成本：真实 Session.snapshotEvents() 在日志 append 后首次调用会复制
// 整个日志（@deepseek-ai/dsh-session 0.2.1-rc.5 lib/index.js:1452-1458；缓存命中时
// 为 O(1)）。本脚本的 mock 直接返回数组，等价于缓存命中；这里单独测复制成本，
// 说明「审批测量没有把上游快照成本算进 park()」。
const snapshotCopy = []
for (const size of [1000, 10000, 100000]) {
  const scenario = fx.buildApprovalScenario({ totalEvents: size })
  const rounds = size >= 100000 ? 41 : 101
  snapshotCopy.push({ size, micros: roundTo(measure(() => { const copy = [...scenario.events]; if (copy.length === 0) throw new Error('empty') }, rounds)) })
}

// ── 语义断言：规模变化不得改变判定 ──────────────────────────────────────
const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })

{
  const live = fx.buildApprovalScenario({ totalEvents: 100000 })
  const store = new ApprovalStore()
  store.park(live.request)
  const snap = store.getSnapshot()
  check('100k genuine-live-tail: 无 external 徽标', snap !== null && snap.external !== true, JSON.stringify(snap?.external))
  check('100k genuine-live-tail: command 从 tool/call 恢复', snap?.command === 'echo fixture-approval', String(snap?.command))
  check('100k genuine-live-tail: 无 pending external 误标', snap !== null && snap.agentId === 'fixture-agent', String(snap?.agentId))
  store.settleAll('cancelled')

  const settled = fx.buildApprovalScenario({ totalEvents: 100000, settled: true })
  const settledStore = new ApprovalStore()
  settledStore.park(settled.request)
  check('100k settled-tail: external 徽标为真', settledStore.getSnapshot()?.external === true, String(settledStore.getSnapshot()?.external))
  settledStore.settleAll('cancelled')

  const unknown = fx.buildUnknownCallScenario(100000)
  const unknownStore = new ApprovalStore()
  unknownStore.park(unknown.request)
  check('100k unknown-call: external 徽标为真', unknownStore.getSnapshot()?.external === true, String(unknownStore.getSnapshot()?.external))
  check('100k unknown-call: command 缺省', unknownStore.getSnapshot()?.command === undefined, String(unknownStore.getSnapshot()?.command))
  unknownStore.settleAll('cancelled')

  const mid = fx.buildApprovalScenario({ totalEvents: 100000, callAt: 'middle' })
  const midStore = new ApprovalStore()
  midStore.park(mid.request)
  check('100k genuine-mid-call: 仍判为 live', midStore.getSnapshot()?.external !== true, String(midStore.getSnapshot()?.external))
  midStore.settleAll('cancelled')
}

// 重检语义：无关 tool/result 不翻徽标；真实配对 tool/result 落地后翻 external。
{
  const scenario = fx.buildApprovalScenario({ totalEvents: 100000 })
  const store = new ApprovalStore()
  store.park(scenario.request)
  for (let i = 0; i < 100; i++) {
    store.noteSessionEvent('fixture-agent', fx.appendToolResult(scenario.events, `unrelated-${i}`))
  }
  check('100k recheck: 无关 tool/result 不翻 external', store.getSnapshot()?.external !== true, String(store.getSnapshot()?.external))
  const realResult = fx.appendToolResult(scenario.events, scenario.callId)
  store.noteSessionEvent('fixture-agent', realResult)
  check('100k recheck: 配对 tool/result 落地后 external 变真', store.getSnapshot()?.external === true, String(store.getSnapshot()?.external))
  store.settleAll('cancelled')
}

// ── 输出 ────────────────────────────────────────────────────────────────
const failures = checks.filter(item => !item.ok)
const output = {
  environment,
  columns: SIZES,
  values: results,
  coldSnapshotTail: coldTail,
  recheck: { distances: recheckDistances, rows: recheck },
  snapshotNoChangeMicros: snapshotNoChange,
  snapshotCopyMicros: snapshotCopy,
  checks,
  pass: failures.length === 0,
}

if (JSON_MODE) {
  console.log(JSON.stringify(output, null, 2))
} else {
  console.log('==== measure-approvals-scan（WP5，单位 µs/次，中位数）====')
  console.log(`环境: node=${environment.node} ${environment.platform} commit=${environment.commit}`)
  console.log(`fixture: ${environment.fixture}；park() 只含同步阶段（不含用户等待）`)

  const header = ['场景'.padEnd(24), ...SIZES.map(size => `N=${size.toLocaleString('en-US')}`.padStart(13))].join('')
  console.log('')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of results) {
    const cells = SIZES.map(size => String(row.bySize[size].toFixed(2)).padStart(13))
    console.log(`${row.id.padEnd(24)}${cells.join('')}`)
  }
  for (const row of results) console.log(`  ${row.id}: ${row.note}`)
  console.log(`  genuine-live-tail-cold: 同上但每次 park 前快照缓存失效（附加一次 O(N) 复制）: ${coldTail.map(item => `N=${item.size}:${item.micros}µs`).join('  ')}`)

  console.log('')
  console.log('活跃审批期间增量重检（日志末尾到活跃 tool/call 的距离 → 单次 noteSessionEvent，单位 µs）')
  for (const row of recheck) {
    const cells = recheckDistances.map(d => `d=${d}:${String(row.byDistance[d].toFixed(2))}`).join('  ')
    console.log(`  N=${String(row.size).padStart(6)}  ${cells} µs`)
  }
  console.log(`  日志未变化时 getSnapshot(): ${snapshotNoChange} µs/次（长度守卫命中）`)
  console.log(`  上游 snapshotEvents() 缓存未命中时的复制成本（O(N) 内存拷贝，非 approvals 代码）: ${snapshotCopy.map(item => `N=${item.size}:${item.micros}µs`).join('  ')}`)

  console.log('')
  console.log('语义断言:')
  for (const item of checks) console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail}`}`)
  console.log(`结果: ${failures.length === 0 ? 'PASS（全部断言通过）' : `FAIL（${failures.length} 项）`}`)

  // 派生扫描速率：unknown-call 约等于 2 次全量扫描，genuine-tail 约等于 3 次
  // 近零距离扫描；两者之差用于估算单事件访问成本，供报告引用。
  const tail100k = results.find(row => row.id === 'genuine-live-tail').bySize[100000]
  const unknown100k = results.find(row => row.id === 'unknown-call').bySize[100000]
  console.log('')
  console.log(`参考: 100k 事件最坏情况（callId 不在日志）park ≈ ${unknown100k.toFixed(2)} µs；`)
  console.log(`      同样会话的真实路径 park ≈ ${tail100k.toFixed(2)} µs（扫描距离≈0）。`)
  // unknown ≈ 2 次全量扫描，tail ≈ 3 次零距离扫描；差值用于估算单事件访问成本。
  const scanNsPerEvent = ((unknown100k - tail100k) * 1000) / 200000
  console.log(`      推导: (${unknown100k.toFixed(2)} - ${tail100k.toFixed(2)}) µs × 1000 / (2 × 100k) ≈ ${scanNsPerEvent.toFixed(1)} ns/事件`)
}

process.exitCode = failures.length === 0 ? 0 : 1