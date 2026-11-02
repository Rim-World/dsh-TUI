/**
 * measure-idle-cpu — WP7「空闲唤醒审计」的空闲 CPU 采样脚本（新文件，可被 WP9 复用）。
 *
 * 无头挂载真实 Chat（与生产同一套 Ink 渲染器与组件树），在落定后的固定墙钟
 * 窗口内采样：
 *   1. process.cpuUsage() 的用户态+系统态增量 ÷ 墙钟 = 本进程 CPU 占用；
 *   2. onFrame 帧数 / 帧耗时、stdout 写入次数与内容不同的写入数（判断是否在重绘）；
 *   3. RSS/heap、事件循环里仍在的 handle 类型（process.getActiveResourcesInfo）。
 *
 * 场景（--scenario）：
 *   new         空会话（Chat 空转录，鲸鱼闲置动画默认开）——对应启动后没输入
 *   new-nowhale 同上但 whaleIdle=false，作鲸鱼闲置动画的对照
 *   long        长会话（默认 3200 行 = 800 轮 user+工具+assistant），滚到底部、
 *               头部滚出视口（whaleArtVisible=false，闲置规划器不跑）
 *   long-done   长会话 + 一条 phase=done 的 working-activity 摘要（状态栏空闲
 *               活动行常驻态；只有用户开了 statusBar.activity 才会出现）
 *
 * 运行（不需要 pnpm build，tsx 直接 import src/）：
 *   node --import tsx/esm scripts/measure-idle-cpu.tsx --scenario=new --seconds=60
 *   node --import tsx/esm scripts/measure-idle-cpu.tsx --scenario=long --rows=3200 --seconds=60
 *   node --import tsx/esm scripts/measure-idle-cpu.tsx --scenario=long --seconds=60 --out=bench/idle-cpu.jsonl
 *
 * 口径与限制（报告必须一并写出）：
 *   - stdout 用计数 Writable（不解析 ANSI），测的是 TUI 进程自身成本；真实终端
 *     的解析/绘制发生在终端模拟器进程，不在本数据里。
 *   - 无头 Chat 使用假 channel：不含 DSH 内核、网络、投影器与 host 侧定时器
 *     （branch 轮询、mount heartbeat 等）。本脚本只覆盖渲染树 + 组件定时器。
 *   - 窗口是墙钟固定窗：new 场景的鲸鱼闲置动画本来就会持续重绘，「空闲 CPU」
 *     应理解为「无输入静置」，不是「零重绘」。
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.NODE_ENV = 'production'

import { appendFileSync, mkdirSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
/** Read `--name=value` from argv. */
function arg(name: string, fallback: string): string {
  const hit = argv.find(entry => entry.startsWith('--' + name + '='))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const scenario = arg('scenario', 'new')
const seconds = Math.max(1, Number(arg('seconds', '60')))
const rowCount = Math.max(0, Number(arg('rows', '3200')))
const settleArg = arg('settle', '')
const settleMs = settleArg === ''
  ? (scenario === 'new' || scenario === 'new-nowhale' ? 7000 : 4000)
  : Math.max(0, Number(settleArg))
const outPath = arg('out', '')
const COLS = 120
const ROWS = 34

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const [
  { PassThrough, Writable },
  React,
  { render },
  { Chat },
  { QuestionStore },
  { ActivityStore },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/activity-store.js'),
])

/** Counting sink: the TUI process cost only, no terminal emulator parsing. */
class CountingStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  writes = 0
  bytes = 0
  distinctCount = 0
  private readonly distinct = new Set<string>()

  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    const text = String(chunk)
    this.writes += 1
    this.bytes += text.length
    if (this.distinct.size < 4096 && !this.distinct.has(text)) {
      this.distinct.add(text)
      this.distinctCount += 1
    }
    callback()
  }

  resetCounters(): void {
    this.writes = 0
    this.bytes = 0
    this.distinct.clear()
    this.distinctCount = 0
  }
}

class SinkStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/** Build `count` ChatRow-shaped rows: user → 2 tools → assistant, cycling. */
function buildRows(count: number): unknown[] {
  const rows: unknown[] = []
  let id = 0
  let turn = 1
  while (rows.length < count) {
    rows.push({ id: id++, kind: 'user', text: '问题 ' + turn, seq: rows.length, time: turn })
    for (let tool = 0; tool < 2 && rows.length < count; tool++) {
      rows.push({
        id: id++, kind: 'tool', text: '', seq: rows.length, time: turn,
        tool: {
          callId: 't' + turn + '-' + tool, name: tool === 0 ? 'Read' : 'Bash',
          argsText: '{"file_path": "/tmp/f' + tool + '.ts"}', argsFull: '{}',
          status: 'ok', startedAt: 0, durationMs: 30,
          resultText: '内容行 1\n内容行 2',
        },
      })
    }
    if (rows.length < count) {
      rows.push({ id: id++, kind: 'assistant', seq: rows.length, time: turn,
        text: Array.from({ length: 4 }, (_, i) => '回复 ' + turn + ' 第 ' + (i + 1) + ' 行').join('\n') })
    }
    turn += 1
  }
  return rows
}

/** Fake Channel with the fields Chat reads in a settled, non-streaming state. */
function makeChannel(rows: unknown[], whaleIdle: boolean): Record<string, unknown> {
  const listeners = new Set<() => void>()
  return {
    version: 0, rows, status: 'idle', sessionTitle: 'idle-cpu', sessionId: 'idle-cpu-probe', agentId: 'probe',
    model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
    tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
    working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
    pending: [], commandList: [], notifications: [], mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: '',
    whale: true, whaleIdle, statusBar: {}, activityEnabled: false,
    subscribe(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback) },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
    commandCompletions: () => [],
  }
}

/** Preload a settled phase=done activity summary (status bar idle summary). */
function makeDoneActivityStore(): InstanceType<typeof ActivityStore> {
  const store = new ActivityStore(() => {})
  const at = Date.now()
  store.update('idle-cpu-probe', {
    phase: 'done', line: '已完成 · 12.3s · 3 个工具', live: false, toolCount: 3,
    phaseStartedAt: at - 12_300, turnStartedAt: at - 12_300, updatedAt: at, lang: 'zh',
  })
  return store
}

// ---- scenario wiring -------------------------------------------------------
const useRows = scenario === 'long' || scenario === 'long-done'
const rows = useRows ? buildRows(rowCount) : []
const whaleIdle = scenario !== 'new-nowhale'
const channel = makeChannel(rows, whaleIdle)
if (scenario === 'long-done') channel['statusBar'] = { activity: true }
const activityStore = scenario === 'long-done' ? makeDoneActivityStore() : undefined

const stdout = new CountingStdout()
const stderr = new SinkStderr()
const stdin = new FakeStdin()
const frameDurations: number[] = []

const instance = await render(
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore() as never,
    ...(activityStore === undefined ? {} : { activityStore: activityStore as never }),
  }),
  {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stderr as never,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: (frame: { durationMs: number }) => frameDurations.push(frame.durationMs),
  } as never,
)

// Settle: fixed wall-clock window (the intro animation has no pollable end state).
await sleep(settleMs)

// Measurement window: CPU delta + frame/IO counters reset at window start.
const cpuStart = process.cpuUsage()
const wallStart = Date.now()
const resourcesStart = process.getActiveResourcesInfo()
stdout.resetCounters()
frameDurations.length = 0
await sleep(seconds * 1000)
const cpuDelta = process.cpuUsage(cpuStart)
const wallMs = Date.now() - wallStart
const memory = process.memoryUsage()
const userMs = cpuDelta.user / 1000
const systemMs = cpuDelta.system / 1000
const totalMs = userMs + systemMs
const sorted = [...frameDurations].sort((a, b) => a - b)
const pct = (p: number): number => sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0)
const summary = {
  kind: 'idle-cpu',
  scenario,
  seconds: wallMs / 1000,
  rows: rows.length,
  whaleIdle,
  settleMs,
  cpu: {
    userMs: Number(userMs.toFixed(1)),
    systemMs: Number(systemMs.toFixed(1)),
    totalMs: Number(totalMs.toFixed(1)),
    pctOneCore: Number((100 * totalMs / wallMs).toFixed(2)),
    pctAllCores: Number((100 * totalMs / wallMs / cpus().length).toFixed(2)),
  },
  frames: {
    count: frameDurations.length,
    perSecond: Number((frameDurations.length / (wallMs / 1000)).toFixed(2)),
    p50Ms: Number(pct(50).toFixed(2)),
    p95Ms: Number(pct(95).toFixed(2)),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
  },
  io: {
    writes: stdout.writes,
    distinctWrites: stdout.distinctCount,
    bytes: stdout.bytes,
    bytesPerSecond: Number((stdout.bytes / (wallMs / 1000)).toFixed(1)),
  },
  memory: {
    rssMb: Number((memory.rss / 1048576).toFixed(1)),
    heapUsedMb: Number((memory.heapUsed / 1048576).toFixed(1)),
    externalMb: Number((memory.external / 1048576).toFixed(1)),
  },
  eventLoop: {
    activeResources: process.getActiveResourcesInfo(),
    resourcesAtWindowStart: resourcesStart,
  },
  env: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    date: new Date().toISOString(),
    commitLog: process.env.DSH_TUI_COMMIT_LOG ?? null,
  },
}

console.log('==== measure-idle-cpu ====')
console.log('scenario=' + scenario + ' rows=' + rows.length + ' seconds=' + (wallMs / 1000).toFixed(0) + ' whaleIdle=' + whaleIdle)
console.log('cpu=' + summary.cpu.totalMs.toFixed(0) + 'ms/' + (wallMs / 1000).toFixed(0) + 's = ' + summary.cpu.pctOneCore.toFixed(2) + '% one core (' + summary.cpu.pctAllCores.toFixed(2) + '% all cores)')
console.log('frames=' + summary.frames.count + ' (' + summary.frames.perSecond.toFixed(2) + '/s) p50=' + summary.frames.p50Ms + 'ms p95=' + summary.frames.p95Ms + 'ms max=' + summary.frames.maxMs + 'ms')
console.log('writes=' + stdout.writes + ' distinct=' + stdout.distinctCount + ' bytes=' + stdout.bytes)
console.log('rss=' + summary.memory.rssMb + 'MB heap=' + summary.memory.heapUsedMb + 'MB')
console.log('resources=' + JSON.stringify(summary.eventLoop.activeResources))
console.log(JSON.stringify(summary, null, 2))
if (outPath !== '') {
  mkdirSync(dirname(outPath), { recursive: true })
  appendFileSync(outPath, JSON.stringify(summary) + '\n')
  console.log('appended: ' + outPath)
}

await instance.unmount()
process.exit(0)
