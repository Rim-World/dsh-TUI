/**
 * T3 屏幕黄金差分 — 共享管线（`scripts/capture-screen-golden.ts` 录制、
 * `scripts/verify-screen-golden.ts` 比对，计划 §4 T3 / 附录 C）。
 *
 * 职责：
 *   1. 固定环境（语言、主题、时钟、尺寸、调试变量、HOME）后再加载任何 src/ 模块；
 *   2. 复用 `scripts/lib/projection-golden.ts` 的确定性管线（同一套
 *      fixtures/dsh 夹具、translator、projector 与桩依赖），按事件序号采集
 *      检查点的投影状态；
 *   3. 把每个检查点的行快照用真实 `MessageList` 渲染进 `@xterm/headless`，
 *      等屏幕稳定窗口后取出纯文本整屏；
 *   4. 按附录 C 白名单（C1–C4）归一化并序列化（C5：不记录光标坐标）。
 *
 * 为什么渲染 `MessageList` 而不是整棵 `Chat`：
 *   - 计划 §4 T3 第 7 条明确允许降级到 `MessageList` 级渲染（其 props 未变）；
 *   - 基线 0359e6f5 与分支的 `MessageList` props 签名逐字相同（本库只用
 *     两侧都存在的 props），同一份库可以原样复制进基线 worktree 运行；
 *   - 整棵 `Chat` 引入 status line / prompt / goal 面板 / 标题时钟等与
 *     转录无关、依赖墙钟的动画，静止帧不可复现；`MessageList` 的动画
 *     全部走共享 Clock（本管线不挂 ClockProvider，时间冻结在 0），唯一
 *     例外是流式 reasoning 的 80ms braille 帧，由 C1 归一化覆盖。
 *
 * 确定性：
 *   - `Date.now` 被替换：投影阶段每次调用 +1ms（与 projection-golden 同口径，
 *     保证行内耗时/时间戳稳定）；全部投影完成后冻结为常量，渲染阶段只读
 *     同一个值，渲染内部调用次数不影响文本。
 *   - 终端固定 120 列 × 40 行，alt-screen（无 scrollback 歧义），主题 dark、
 *     语言 zh、production React、无调试变量。HOME/USERPROFILE 指到一次性
 *     临时目录，用户偏好与真实会话不参与渲染。
 *   - 每个检查点都是「全新挂载 → 等屏幕连续 3 次读取一致 → 取帧 → 卸载」，
 *     检查点之间没有共享挂载状态。
 *
 * 使用（两个脚本都动态 import 本库；任何静态 import 都会让固定环境失效）：
 *   node --import tsx/esm scripts/capture-screen-golden.ts --out <dir> --expect-commit <sha>
 *   node --import tsx/esm scripts/verify-screen-golden.ts [--golden-dir <dir>]
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- 固定环境：必须在加载任何 src/ 模块之前完成 -----------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screen-golden-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
process.env.FORCE_COLOR = '3'
process.env.NODE_ENV = 'production'
delete process.env.DSH_TUI_DEBUG
delete process.env.DSH_TUI_RENDER_LOG
delete process.env.DSH_TUI_GEOMETRY_TRACE
delete process.env.DSH_TUI_COMMIT_LOG
delete process.env.DSH_TUI_DEBUG_REPAINTS

/** 固定时钟基准：2026-01-05T00:00:00Z（与 projection-golden 同口径）。 */
export const CLOCK_BASE = Date.UTC(2026, 0, 5, 0, 0, 0)
let clock = CLOCK_BASE
let clockFrozen = false
let clockFrozenAt = 0
Date.now = (): number => {
  if (clockFrozen) return clockFrozenAt
  return clock++
}

/** 固定终端尺寸（计划 §3：T3 使用 120 列 × 40 行）。 */
export const SCREEN_COLS = 120
export const SCREEN_ROWS = 40
/** 归一化规则版本；改动归一化必须提升版本，旧黄金会被 verify 判为过期。 */
export const NORMALIZATION_VERSION = 1

/** 投影管线的桩依赖与 projection-golden.ts 完全一致（见该文件头注释）。 */
const LIVE_REPLAY_EVENT = 'fixture'
const MODEL = 'fixture-model-a'

export interface ScreenVariant {
  /** fixtures/dsh 下的夹具名。 */
  readonly fixture: string
  /** 变体名；`default` 是生产默认，`thinking-full` 是投影黄金的第 5 份变体。 */
  readonly variant: string
  readonly thinkingFold: 'preview' | 'full'
  /** 黄金文件名（scripts/fixtures/screen/ 下）。 */
  readonly goldenFile: string
}

/** 4 个夹具 + 5 份投影黄金变体（v3-turns 的 thinking-full 是第 5 份）。 */
export function screenVariants(): ScreenVariant[] {
  const variants: ScreenVariant[] = [
    { fixture: 'v3-turns', variant: 'default', thinkingFold: 'preview' },
    { fixture: 'tools-jobs', variant: 'default', thinkingFold: 'preview' },
    { fixture: 'compaction-legacy', variant: 'default', thinkingFold: 'preview' },
    { fixture: 'goal-todo-preset', variant: 'default', thinkingFold: 'preview' },
    { fixture: 'v3-turns', variant: 'thinking-full', thinkingFold: 'full' },
  ]
  return variants.map(variant => ({
    ...variant,
    goldenFile: variant.variant === 'default' ? `${variant.fixture}.screen.json` : `${variant.fixture}.${variant.variant}.screen.json`,
  }))
}

export type CheckpointKind =
  | 'replay-final'
  | 'live-event'
  | 'frames-final'
  | 'after-compaction'
  | 'after-clear'
  | 'live-final'

export interface ScreenCheckpoint {
  /** 稳定 id（录制与比对共用；与构建版本无关）。 */
  readonly id: string
  readonly kind: CheckpointKind
  /** 人读说明，写进黄金文件。 */
  readonly label: string
  /** 该检查点渲染用的 MessageList `model` prop。 */
  readonly model: string
  /** 该检查点的 ChatRow 快照（JSON 安全、深拷贝）。 */
  readonly rows: readonly unknown[]
  /** 事件序号/类型等可追溯信息。 */
  readonly meta: Readonly<Record<string, string | number>>
}

export interface SkippedCheckpoint {
  readonly id: string
  readonly reason: string
}

export interface VariantCheckpoints {
  readonly variant: ScreenVariant
  readonly checkpoints: ScreenCheckpoint[]
  readonly skipped: SkippedCheckpoint[]
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue
const cloneRows = (rows: unknown): unknown[] => JSON.parse(JSON.stringify(rows)) as unknown[]

const readJsonl = (path: string): unknown[] => {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}

// --- 动态 import：固定环境与固定时钟必须先生效 -----------------------------
const { createChannelProjection } = await import('../../src/channel/projection.js')
const { createDshTranslator, dshPricingWindow } = await import('../../src/dsh-adapter/backend/translate.js')
const { createInitialChannelView } = await import('../../src/dsh-adapter/channel/state.js')
const { FIXTURE_DIR } = await import('../fixtures/dsh/generate.js')

type Translator = ReturnType<typeof createDshTranslator>
type ProjectionArgs = Parameters<typeof createChannelProjection>

interface Recorder {
  readonly calls: {
    notify: JsonValue[]
    jobsOnStarted: JsonValue[]
    jobsOnOutputSeen: JsonValue[]
    rendererRender: string[]
    checkContextWarning: number
    resetContextWarning: number
    agent: number
  }
}

interface Runner {
  readonly projector: ReturnType<typeof createChannelProjection>
  readonly translator: Translator
  readonly state: ProjectionArgs[0]
}

/** 与 projection-golden.ts 的 project() 同一套桩依赖；只暴露行状态用于渲染。 */
function makeRunner(thinkingFold: 'preview' | 'full'): Runner {
  const recorder: Recorder = {
    calls: {
      notify: [],
      jobsOnStarted: [],
      jobsOnOutputSeen: [],
      rendererRender: [],
      checkContextWarning: 0,
      resetContextWarning: 0,
      agent: 0,
    },
  }
  const view = createInitialChannelView(
    { model: MODEL, provider: 'fixture', cwd: '/fixture', agentPreset: 'ptc', thinkingFold },
    { agentId: 'fixture-agent', sessionId: 'fixture-session', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
  const state: ProjectionArgs[0] = { ...view, emit: () => undefined }
  const translator = createDshTranslator({
    tools: () => undefined,
    scope: () => {
      recorder.calls.agent += 1
      return {}
    },
    attachments: () => undefined,
  })
  const deps: ProjectionArgs[1] = {
    rowIds: { value: 0 },
    resetContextWarning: () => { recorder.calls.resetContextWarning += 1 },
    jobs: {
      onStarted: (id, command) => { recorder.calls.jobsOnStarted.push(toJson({ id, command })) },
      onOutputSeen: (id, text, at) => { recorder.calls.jobsOnOutputSeen.push(toJson({ id, text, at })) },
    },
    inputConvergence: { cancelInFlight: true },
    checkContextWarning: () => { recorder.calls.checkContextWarning += 1 },
    notify: (text, options) => {
      recorder.calls.notify.push(toJson({ text, options }))
      return () => undefined
    },
    renderer: {
      render: (type, payload) => {
        recorder.calls.rendererRender.push(type)
        if (type !== 'fixture-plugin/note' || typeof payload !== 'object' || payload === null) return undefined
        const note = payload as { title?: unknown; lines?: unknown }
        return {
          title: typeof note.title === 'string' ? note.title : undefined,
          lines: Array.isArray(note.lines) ? note.lines.map(String) : [],
        }
      },
    },
    selectionAttached: () => undefined,
    pricingWindow: dshPricingWindow,
  } as unknown as ProjectionArgs[1]
  const projector = createChannelProjection(state, deps)
  return { projector, translator, state }
}

const eventsOf = (variant: ScreenVariant): unknown[] =>
  readJsonl(join(FIXTURE_DIR, `${variant.fixture}.jsonl`))

const framesOf = (variant: ScreenVariant): unknown[] =>
  readJsonl(join(FIXTURE_DIR, `${variant.fixture}.frames.jsonl`))

/** 事件是否为「清空」检查点：goal/change clear 或类型名带 clear 的事件。 */
function isClearEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false
  const record = event as { type?: unknown; data?: unknown }
  const type = typeof record.type === 'string' ? record.type : ''
  if (type.includes('clear')) return true
  if (type !== 'goal/change') return false
  const data = record.data
  return typeof data === 'object' && data !== null && (data as { operation?: unknown }).operation === 'clear'
}

const eventLabel = (event: unknown): { seq: number; type: string } => {
  const record = typeof event === 'object' && event !== null ? (event as { seq?: unknown; type?: unknown }) : {}
  return {
    seq: typeof record.seq === 'number' ? record.seq : -1,
    type: typeof record.type === 'string' ? record.type : 'unknown',
  }
}

const pushCheckpoint = (
  target: ScreenCheckpoint[],
  state: ProjectionArgs[0],
  kind: CheckpointKind,
  id: string,
  label: string,
  meta: Record<string, string | number>,
): void => {
  target.push({
    id,
    kind,
    label,
    model: typeof state.model === 'string' && state.model !== '' ? state.model : MODEL,
    rows: cloneRows(state.rows),
    meta,
  })
}

/**
 * 采集一个变体的全部检查点（纯函数：只做投影，不渲染、不写盘）。
 * 检查点定义（录制与比对共用）：
 *   replay-final   重放路径（translateReplay + 全部 frames + settleStreaming）后的整屏；
 *   live-event     活路径每 10 个持久事件一帧（第 10/20/… 个）；
 *   after-compaction  每个 compaction/* 事件应用后的帧；
 *   after-clear    每个清空事件（goal/change clear 等）应用后的帧；
 *   frames-final   流式 frames 全部应用后、settleStreaming 之前的帧；
 *   live-final     活路径全部事件 + frames + settleStreaming 后的整屏。
 */
export function collectVariantCheckpoints(variant: ScreenVariant): VariantCheckpoints {
  clockFrozen = false
  const events = eventsOf(variant)
  const frames = framesOf(variant)
  const checkpoints: ScreenCheckpoint[] = []
  const skipped: SkippedCheckpoint[] = []

  // replay 路径：/resume、rewind 与重连客户端看到的落定态。
  clock = CLOCK_BASE
  {
    const runner = makeRunner(variant.thinkingFold)
    runner.projector.apply(runner.translator.translateReplay(events as never), { replay: true })
    for (const frame of frames) runner.projector.apply(runner.translator.translateFrame(frame as never), { replay: false })
    runner.projector.settleStreaming()
    pushCheckpoint(checkpoints, runner.state, 'replay-final', 'replay-final', 'replay path settled (resume/rewind view)', {
      events: events.length,
      frames: frames.length,
    })
  }

  // 活路径：一个已连接客户端逐个累积事件。
  clock = CLOCK_BASE
  {
    const runner = makeRunner(variant.thinkingFold)
    let compactionEvents = 0
    let clearEvents = 0
    for (let index = 0; index < events.length; index++) {
      const event = events[index]
      runner.projector.apply(runner.translator.translateEvent(event as never), { replay: false })
      const { seq, type } = eventLabel(event)
      if ((index + 1) % 10 === 0) {
        pushCheckpoint(checkpoints, runner.state, 'live-event', `live-event-${String(seq).padStart(3, '0')}`, `live view after event #${seq} (${type})`, { eventSeq: seq, eventType: type })
      }
      if (type.startsWith('compaction/')) {
        compactionEvents += 1
        pushCheckpoint(checkpoints, runner.state, 'after-compaction', `compaction-${String(seq).padStart(3, '0')}-${type.replaceAll('/', '-')}`, `live view after ${type} (#${seq})`, { eventSeq: seq, eventType: type })
      }
      if (isClearEvent(event)) {
        clearEvents += 1
        pushCheckpoint(checkpoints, runner.state, 'after-clear', `clear-${String(seq).padStart(3, '0')}`, `live view after clear event ${type} (#${seq})`, { eventSeq: seq, eventType: type })
      }
    }
    for (const frame of frames) runner.projector.apply(runner.translator.translateFrame(frame as never), { replay: false })
    if (frames.length > 0) {
      pushCheckpoint(checkpoints, runner.state, 'frames-final', 'frames-final', 'live view with every streaming frame applied (before settle)', {
        events: events.length,
        frames: frames.length,
      })
    } else {
      skipped.push({ id: 'frames-final', reason: `fixture ${variant.fixture} has no .frames.jsonl` })
    }
    runner.projector.settleStreaming()
    pushCheckpoint(checkpoints, runner.state, 'live-final', 'live-final', 'live path settled (attached client view)', {
      events: events.length,
      frames: frames.length,
    })
    if (compactionEvents === 0) skipped.push({ id: 'after-compaction', reason: `fixture ${variant.fixture} has no compaction/* event` })
    if (clearEvents === 0) skipped.push({ id: 'after-clear', reason: `fixture ${variant.fixture} has no clear event` })
  }

  return { variant, checkpoints, skipped }
}

/** 采集全部变体（投影阶段结束后冻结时钟，渲染稳定）。 */
export function collectAllCheckpoints(): VariantCheckpoints[] {
  clockFrozen = false
  const all = screenVariants().map(collectVariantCheckpoints)
  clockFrozen = true
  clockFrozenAt = clock
  return all
}

// --- 渲染 ------------------------------------------------------------------

type ReactModule = typeof import('react')

interface Rig {
  readonly term: import('@xterm/headless').Terminal
  readonly stdout: unknown
  readonly stderr: unknown
  /** Everything React/Ink wrote to stderr during the mount. */
  readonly stderrText: () => string
  readonly stdin: unknown
}

const makeRig = (
  { PassThrough, Writable }: typeof import('node:stream'),
  XTerm: typeof import('@xterm/headless').Terminal,
): Rig => {
  const term = new XTerm({ cols: SCREEN_COLS, rows: SCREEN_ROWS, scrollback: 0, allowProposedApi: true })
  let stderrText = ''
  class FakeStdout extends Writable {
    columns = SCREEN_COLS
    rows = SCREEN_ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      stderrText += String(chunk)
      callback()
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  return { term, stdout: new FakeStdout(), stderr: new FakeStderr(), stderrText: () => stderrText, stdin: new FakeStdin() }
}

const viewport = (term: import('@xterm/headless').Terminal): string[] => {
  const buffer = term.buffer.active
  return Array.from({ length: SCREEN_ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 稳定窗口：连续 `stableReads` 次屏幕读取完全一致才取帧（计划 §4 T3 风险 2）。
 * 上限超时后返回最后一次读取，并由调用方在 stderr 记一条 warning。
 */
async function waitStableScreen(
  term: import('@xterm/headless').Terminal,
  options: { timeoutMs?: number; intervalMs?: number; stableReads?: number } = {},
): Promise<{ lines: string[]; stable: boolean; waitedMs: number }> {
  const timeoutMs = options.timeoutMs ?? 2500
  const intervalMs = options.intervalMs ?? 20
  const stableReads = options.stableReads ?? 3
  const deadline = performance.now() + timeoutMs
  let last = viewport(term)
  let same = 0
  let waited = 0
  while (performance.now() < deadline) {
    await pause(intervalMs)
    waited += intervalMs
    const current = viewport(term)
    if (current.join('\n') === last.join('\n')) {
      same += 1
      if (same >= stableReads) return { lines: current, stable: true, waitedMs: waited }
    } else {
      last = current
      same = 0
    }
  }
  return { lines: last, stable: false, waitedMs: waited }
}

/** 渲染一个检查点：全新挂载 MessageList → 稳定窗口取帧 → 卸载。 */
export async function renderCheckpointScreen(checkpoint: ScreenCheckpoint): Promise<string[]> {
  const [{ PassThrough, Writable }, React, XTermModule, { render, AlternateScreen }, { MessageList }] = await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../../src/ui.js'),
    import('../../src/components/MessageList.js'),
  ])
  const rig = makeRig({ PassThrough, Writable }, XTermModule.Terminal)
  const element = React.createElement(
    AlternateScreen,
    null,
    React.createElement(MessageList as never, {
      rows: checkpoint.rows,
      expanded: false,
      expandedRows: new Set<number>(),
      selectedId: null,
      onToggleRow: () => undefined,
      model: checkpoint.model,
      showAll: true,
      onToggleAll: () => undefined,
      historyPaintEnabled: false,
    }),
  )
  let instance: { unmount: () => Promise<void> } | undefined
  try {
    instance = (await render(element as never, {
      stdout: rig.stdout as never,
      stdin: rig.stdin as never,
      stderr: rig.stderr as never,
      exitOnCtrlC: false,
      patchConsole: false,
    } as never)) as unknown as { unmount: () => Promise<void> }
    const noisy = rig.stderrText()
    if (/Maximum update depth|Minified React error|Unhandled/iu.test(noisy)) {
      throw new Error(`checkpoint ${checkpoint.id}: renderer reported an error on stderr: ${noisy.slice(0, 400)}`)
    }
    const stable = await waitStableScreen(rig.term)
    if (!stable.stable) {
      throw new Error(`checkpoint ${checkpoint.id}: screen did not settle within the stable window`)
    }
    const lines = stable.lines
    if (lines.every(line => line.trim() === '')) {
      throw new Error(`checkpoint ${checkpoint.id}: rendered screen is blank`)
    }
    return lines
  } finally {
    if (instance !== undefined) await instance.unmount()
    rig.term.dispose()
  }
}

// --- 归一化（附录 C） ------------------------------------------------------

export interface NormalizationHits {
  /** C1 spinner 帧字符 → `*`。 */
  C1: number
  /** C2 耗时/TPS/token 等数字串 → `#`。 */
  C2: number
  /** C3 会话/代理/行 ID → `ID`。 */
  C3: number
  /** C4 绝对时间与日期 → `TIME`。 */
  C4: number
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const ISO_DATE_TIME_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g
const TIME_OF_DAY_RE = /\b\d{2}:\d{2}:\d{2}\b/g

/**
 * 按附录 C 白名单归一化整屏文本。只改白名单内形态；不改行数、行序、
 * 缩进与分栏边框字符（博拉叶与 UUID/时间戳不会出现在边框/缩进里）。
 * C5 光标位置不参与比对：本管线只取文本，从不记录光标坐标。
 */
export function normalizeScreen(rawLines: readonly string[]): { lines: string[]; hits: NormalizationHits } {
  const hits: NormalizationHits = { C1: 0, C2: 0, C3: 0, C4: 0 }
  const lines = rawLines.map(raw => {
    let line = raw
    // C4 先于 C2：否则数字串先变成 #，时间/日期形态就不成体了。
    line = line.replace(ISO_DATE_TIME_RE, () => { hits.C4 += 1; return 'TIME' })
    line = line.replace(ISO_DATE_RE, () => { hits.C4 += 1; return 'TIME' })
    line = line.replace(TIME_OF_DAY_RE, () => { hits.C4 += 1; return 'TIME' })
    line = line.replace(UUID_RE, () => { hits.C3 += 1; return 'ID' })
    // C1：braille 帧（THINKING_SPINNER_FRAMES 全部落在 U+2800–U+28FF）。
    line = line.replace(/[\u2800-\u28ff]/gu, () => { hits.C1 += 1; return '*' })
    // C2：数字串整体替换，单位与标签文本保留。
    line = line.replace(/\d+/gu, () => { hits.C2 += 1; return '#' })
    return line
  })
  if (lines.length !== rawLines.length) throw new Error('normalization changed the line count')
  return { lines, hits }
}

/** 归一化幂等自检：对已归一化文本再跑一次必须不变（捕获/比对启动时调用）。 */
export function assertNormalizationWellFormed(): void {
  const sample = [
    '  ⠋ Thinking… 12s · ↑ 1,234 tokens',
    'session 0b6c1f0a-1234-4abc-8def-0123456789ab at 2026-01-05T00:00:12Z',
  ]
  const once = normalizeScreen(sample)
  const twice = normalizeScreen(once.lines)
  if (once.lines.join('\n') !== twice.lines.join('\n')) throw new Error('normalization is not idempotent')
  if (once.lines.length !== sample.length) throw new Error('normalization changed line count in self-check')
  if (!once.lines[0]!.includes('*') || !once.lines[0]!.includes('#')) throw new Error('normalization self-check did not hit C1/C2')
  if (!once.lines[1]!.includes('ID') || !once.lines[1]!.includes('TIME')) throw new Error('normalization self-check did not hit C3/C4')
}

// --- 黄金文档 --------------------------------------------------------------

export interface GoldenCheckpoint {
  readonly id: string
  readonly kind: CheckpointKind
  readonly label: string
  readonly meta: Readonly<Record<string, string | number>>
  /** 归一化后的整屏文本（固定 40 行，右侧空白已裁）。 */
  readonly lines: readonly string[]
}

export interface ScreenGoldenDocument {
  readonly $comment: string
  readonly fixture: string
  readonly variant: string
  readonly options: {
    readonly cols: number
    readonly rows: number
    readonly lang: string
    readonly theme: string
    readonly renderer: string
    readonly fullscreen: boolean
    readonly clockBase: number
    readonly thinkingFold: 'preview' | 'full'
    readonly normalizationVersion: number
  }
  readonly source: { readonly commit: string }
  readonly normalization: { readonly version: number; readonly rules: readonly string[]; readonly hits: NormalizationHits }
  readonly checkpoints: readonly GoldenCheckpoint[]
  readonly skipped: readonly SkippedCheckpoint[]
}

const GOLDEN_COMMENT = 'Generated by scripts/capture-screen-golden.ts from the baseline build (see source.commit); do not edit by hand. Lines are normalized per plan appendix C (C1 spinner glyph -> *, C2 number runs -> #, C3 ids -> ID, C4 absolute time -> TIME; C5 cursor is never recorded).'

export const screenGoldenOptions = (variant: ScreenVariant): ScreenGoldenDocument['options'] => ({
  cols: SCREEN_COLS,
  rows: SCREEN_ROWS,
  lang: 'zh',
  theme: 'dark',
  renderer: 'MessageList',
  fullscreen: true,
  clockBase: CLOCK_BASE,
  thinkingFold: variant.thinkingFold,
  normalizationVersion: NORMALIZATION_VERSION,
})

/** 黄金文件路径：`<dir>/<fixture>[.<variant>].screen.json`。 */
export const screenGoldenPath = (dir: string, variant: ScreenVariant): string => join(dir, variant.goldenFile)

export function readScreenGolden(dir: string, variant: ScreenVariant): ScreenGoldenDocument | undefined {
  try {
    return JSON.parse(readFileSync(screenGoldenPath(dir, variant), 'utf8')) as ScreenGoldenDocument
  } catch {
    return undefined
  }
}

/** 黄金目录里所有 `.screen.json` 文件名（用于孤儿黄金检查）。 */
export function goldenFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => name.endsWith('.screen.json')).sort()
  } catch {
    return []
  }
}

export interface CapturedVariantScreen {
  readonly variant: ScreenVariant
  readonly checkpoints: readonly { id: string; kind: CheckpointKind; label: string; meta: Record<string, string | number>; lines: string[] }[]
  readonly skipped: readonly SkippedCheckpoint[]
  readonly hits: NormalizationHits
}

/** 渲染 + 归一化全部变体（不写盘）。 */
export async function captureAllScreens(): Promise<CapturedVariantScreen[]> {
  assertNormalizationWellFormed()
  const collected = collectAllCheckpoints()
  const screens: CapturedVariantScreen[] = []
  for (const entry of collected) {
    const hits: NormalizationHits = { C1: 0, C2: 0, C3: 0, C4: 0 }
    const checkpoints: CapturedVariantScreen['checkpoints'][number][] = []
    for (const checkpoint of entry.checkpoints) {
      const raw = await renderCheckpointScreen(checkpoint)
      const normalized = normalizeScreen(raw)
      hits.C1 += normalized.hits.C1
      hits.C2 += normalized.hits.C2
      hits.C3 += normalized.hits.C3
      hits.C4 += normalized.hits.C4
      checkpoints.push({ id: checkpoint.id, kind: checkpoint.kind, label: checkpoint.label, meta: { ...checkpoint.meta }, lines: normalized.lines })
    }
    screens.push({ variant: entry.variant, checkpoints, skipped: entry.skipped, hits })
  }
  return screens
}

/** 由已采集屏幕构造黄金文档（capture 脚本补 source.commit 后写盘）。 */
export function buildScreenGolden(captured: CapturedVariantScreen, commit: string): ScreenGoldenDocument {
  return {
    $comment: GOLDEN_COMMENT,
    fixture: captured.variant.fixture,
    variant: captured.variant.variant,
    options: screenGoldenOptions(captured.variant),
    source: { commit },
    normalization: {
      version: NORMALIZATION_VERSION,
      rules: [
        'C1: braille spinner frames (U+2800-U+28FF) -> *',
        'C2: digit runs -> # (units and labels preserved)',
        'C3: UUID-shaped identifiers -> ID',
        'C4: ISO date/time and HH:MM:SS -> TIME',
        'C5: cursor position not recorded (text only)',
      ],
      hits: captured.hits,
    },
    checkpoints: captured.checkpoints,
    skipped: captured.skipped,
  }
}

export function writeScreenGolden(dir: string, document: ScreenGoldenDocument): string {
  const path = join(dir, document.variant === 'default' ? `${document.fixture}.screen.json` : `${document.fixture}.${document.variant}.screen.json`)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
  return path
}

// --- 比对 ------------------------------------------------------------------

export interface ScreenDiff {
  readonly checkpoint: string
  readonly kind: 'missing' | 'extra' | 'line' | 'line-count' | 'order'
  readonly line?: number
  readonly expected?: string
  readonly actual?: string
}

/** 逐行比对两份屏幕（已归一化）；行数不同时先报 line-count 再逐行报差异。 */
export function diffScreenLines(checkpointId: string, expected: readonly string[], actual: readonly string[]): ScreenDiff[] {
  if (expected.length !== actual.length) {
    return [{ checkpoint: checkpointId, kind: 'line-count', expected: String(expected.length), actual: String(actual.length) }]
  }
  const diffs: ScreenDiff[] = []
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] !== actual[index]) {
      diffs.push({ checkpoint: checkpointId, kind: 'line', line: index + 1, expected: expected[index] ?? '', actual: actual[index] ?? '' })
    }
  }
  return diffs
}

/** 屏幕文本的稳定摘要（日志用；不含原始会话内容，只是合成夹具画面）。 */
export function hashLines(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}
