#!/usr/bin/env node
/**
 * verify-perf-lazy-faults — WP6 惰性启动的故障注入回归（计划 §4 T4）。
 *
 * 四个场景各起一个独立子进程，用 scripts/lib/fault-loader.mjs（node:module
 * register 钩子）让指定模块在 resolve/load 阶段失败，或按 flag 走 eager 路径：
 *
 *   A 惰性模块缺失：DSH_TUI_LAZY_STARTUP=1，@deepseek-ai/dsh-tool-ask-user 缺失
 *     （该包只被惰性接缝引用；`dsh-user-questions` 经 questions.ts 静态加载，不是惰性点）。
 *     走非入口内核路径（无 entrySlot）→ 接缝动态 import 失败被捕获降级；
 *     断言 apply 继续、首帧照常渲染（不白屏）、stderr 有可读降级原因、无未捕获异常。
 *   B 非 DSH 内核路由：DSH_TUI_LAZY_STARTUP=1、无 entrySlot（claude/codex 与
 *     `dsh --profile` 直启走的路径）。断言路由纯函数与既有 verify-host-entry.ts
 *     通过；四模块在该路径下仍在首帧前加载（惰性延后只对入口 DSH 路径生效）。
 *   C 旗标关闭：DSH_TUI_LAZY_STARTUP=0。断言 eager 加载四个模块、首帧照常渲染；
 *     并记录与 B 的「首帧前加载数」对比（C 是 eager 基线集合）。
 *   D 回退路径：DSH_TUI_LAZY_STARTUP=1 + entrySlot.dsh（默认入口路径），
 *     session-list-metadata 缺失。断言首帧照常渲染、延迟注册失败被记录、
 *     进程不崩溃（回退不白屏）。
 *
 * 首帧证据：DSH_TUI_BOOT_TRACE 的 render-start/render-done 标记；屏幕文本由子进程
 * stdout 用 @xterm/headless 重建后断言非空。模块加载顺序由 fault-loader 的
 * DSH_TUI_FAULT_RECORD 记录（file: 模块首次加载的 epoch ms，与 trace 的 at 对齐）。
 *
 * 判据说明（与计划 §4 T4 的偏差，如实记录）：计划假设降级会在屏幕上给出可读错误
 * 文案；当前实现的选择是「记录 stderr 诊断 + 跳过可选接缝/注册」，屏幕不出现专用的
 * 错误行。因此本回归把「不白屏/有回退渲染」断言为：首帧照常出现、屏幕可见字符足够、
 * 含产品标识；可读错误信息在 stderr 断言。
 *
 * Run: node --import tsx/esm scripts/verify-perf-lazy-faults.ts
 *
 * 可选：
 * - `--preflight-only`：只做构建/内存/并发进程前置检查，不启动任何子进程（调度前确认用）。
 * - `--skip-resource-guard`：跳过可用内存/并发进程检查（仅本地调试；默认要求可用内存
 *   ≥3 GB 且没有其他 TUI/构建进程）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import xterm from '@xterm/headless'
import { viewportLines, writeParsed } from './lib/term-test.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const LIB = join(ROOT, 'lib', 'types')
const FAULT_LOADER = pathToFileURL(join(ROOT, 'scripts', 'lib', 'fault-loader.mjs')).href
const LOG_DIR = resolve(ROOT, '..', '..', 'TMP', '07_验证日志', '06_WP6故障注入')
const GHZ = 1024 * 1024 * 1024
const MIN_AVAILABLE_BYTES = 3 * GHZ
// 计划 §4 T4 判据 3 的基线口径：实验前这些静态 import 恒在首帧前加载。
const WATCH = {
  'user-questions': '/node_modules/@deepseek-ai/dsh-user-questions/',
  'tool-ask-user': '/node_modules/@deepseek-ai/dsh-tool-ask-user/',
  'prompt-debug': '/lib/types/dsh-adapter/promptDebug.js',
  'session-list-metadata': '/lib/types/dsh-adapter/session-list-metadata.js',
} as const

const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

// ───────────────────────────────────────────────────────────────────────────
// 子进程夹具：加载产品入口（已编译 lib/types），用假终端/假 agents 渲染首帧。
// ───────────────────────────────────────────────────────────────────────────
async function runChild(scenario: string): Promise<void> {
  // 夹具进程的 argv 归零：product 的启动参数解析会把剩余 argv 当提示词提交。
  process.argv = [process.execPath, SELF]
  const resultPath = process.env.DSH_TUI_T4_RESULT
  const result: Record<string, unknown> = {
    scenario,
    startedAt: new Date().toISOString(),
    applyOutcome: 'not-started',
    applyError: undefined,
    uncaught: [] as string[],
    unhandled: [] as string[],
    marks: [] as { mark: string; ms: number; at: number }[],
    stdoutBytes: 0,
  }
  const flush = (): void => {
    if (resultPath === undefined) return
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
  }
  process.on('uncaughtException', (error) => {
    ;(result.uncaught as string[]).push(String(error?.stack ?? error))
    flush()
    process.exit(4)
  })
  process.on('unhandledRejection', (error) => {
    ;(result.unhandled as string[]).push(String((error as Error)?.stack ?? error))
    flush()
    process.exit(5)
  })

  // HOME 必须在任何产品模块 import 前改到临时目录（DATA_DIR 在 import 时定死）。
  await import('./lib/fake-home.mjs')
  // 假 TTY：渲染走真实 Ink 路径，但流不落到无人读取的真实终端。
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  process.stdout.columns = 120
  process.stdout.rows = 40
  const stdin = process.stdin as unknown as Record<string, unknown>
  Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true })
  for (const key of ['setRawMode', 'resume', 'pause', 'ref', 'unref', 'setEncoding']) {
    stdin[key] = () => stdin
  }

  const tracePath = process.env.DSH_TUI_BOOT_TRACE
  const [{ Context }, { apply }, { Config }, slotModule] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('../lib/types/dsh-adapter/plugin.js'),
    import('../lib/types/dsh-adapter/index.js'),
    import('../lib/types/dsh-adapter/entry-slot.js'),
  ])
  const ctx = new Context()
  const cwd = process.cwd()
  const session = {
    id: 't4-probe-session',
    ref: { backendId: 'dsh', sessionId: 't4-probe-session' },
    cwd,
    header: { cwd, id: 't4-probe-session', at: 1 },
    status: 'idle',
    capabilities: { native: {} },
    history: async () => [],
    subscribe: () => () => undefined,
    submit: async () => ({ accepted: true }),
    removePending: () => false,
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }),
    dispose: async () => undefined,
    seq: 0,
    events: [],
    requestHeader: () => undefined,
  }
  const agent = { session, ctx, options: { provider: 'probe', model: 'probe-model' } }
  const handle = { agent, session, dispose: async () => undefined }
  ctx.provide('agents', { create: async () => handle, resume: async () => handle, get: () => undefined })
  const runtimeOptions = scenario === 'fallback-path'
    ? { entrySlot: slotModule.createEntrySlot(true, '0.0.0-t4-probe') }
    : {}
  try {
    await apply(ctx, Config({}), ctx, runtimeOptions as never)
    result.applyOutcome = 'resolved'
  } catch (error) {
    result.applyOutcome = 'rejected'
    result.applyError = String((error as Error)?.message ?? error)
  }
  // 等首帧标记落盘（apply 已 await render；这里只容忍异步写盘延迟）。
  for (let round = 0; round < 40; round += 1) {
    if (tracePath !== undefined) {
      try {
        const marks = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        result.marks = marks
        if (marks.some((mark) => mark.mark === 'render-done')) break
      } catch {
        // trace 尚未创建
      }
    }
    await sleep(100) // 固定窗:pacing 轮询 trace 文件的间隔
  }
  flush()
  // 让 stderr（降级日志）与延迟注册的 rejection 先落到父进程管道。
  await sleep(500) // 固定窗:pacing 等 stderr 管道落盘
  process.exit(0)
}

// ───────────────────────────────────────────────────────────────────────────
// 资源守卫：可用内存 ≥3 GB，且没有其他 TUI/构建进程在跑（T0 构建等）。
// ───────────────────────────────────────────────────────────────────────────
type Competing = { pid: number; commandLine: string }

function competingProcesses(): { checked: boolean; found: Competing[]; detail: string } {
  if (process.platform !== 'win32') return { checked: false, found: [], detail: '非 Windows：进程守卫未实现' }
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 })
  if (result.error !== undefined || result.status !== 0) {
    return { checked: false, found: [], detail: (result.stderr ?? '').trim().slice(0, 300) || String(result.error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim() === '' ? '[]' : result.stdout)
  } catch {
    return { checked: false, found: [], detail: 'PowerShell 输出不是 JSON' }
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const selfPids = new Set([process.pid, process.ppid])
  const patterns = [
    /host-entry\.js/i,
    /bin[\\/]dsh-tui\.js/i,
    /dsh-tui[\\/]lib[\\/]types/i,
    /run-verify-build/i,
    /build-vendor/i,
    /run-ci-group/i,
    /scripts[\\/]run\.ts/i,
    /typescript[\\/]bin[\\/]tsc/i,
    /pnpm-cli\.c?js/i,
  ]
  const found: Competing[] = []
  for (const row of rows as { ProcessId?: number; CommandLine?: string }[]) {
    const pid = row.ProcessId
    const commandLine = row.CommandLine ?? ''
    if (typeof pid !== 'number' || selfPids.has(pid)) continue
    if (commandLine.includes('verify-perf-lazy-faults')) continue
    if (patterns.some((pattern) => pattern.test(commandLine))) found.push({ pid, commandLine })
  }
  return { checked: true, found, detail: '' }
}

// ───────────────────────────────────────────────────────────────────────────
// 父进程：场景定义、子进程调度、日志与断言。
// ───────────────────────────────────────────────────────────────────────────
type Scenario = {
  name: string
  title: string
  env: Record<string, string>
  expect: {
    applyOutcome: 'resolved' | 'rejected'
    render: boolean
    stderrIncludes?: readonly string[]
    watchBeforeRender?: readonly (keyof typeof WATCH)[]
    watchAbsentBeforeRender?: readonly (keyof typeof WATCH)[]
  }
}

function scenarios(): Scenario[] {
  return [
    {
      name: 'lazy-module-missing',
      title: 'A 惰性模块缺失（DSH_TUI_LAZY_STARTUP=1，dsh-tool-ask-user 缺失）',
      env: {
        DSH_TUI_LAZY_STARTUP: '1',
        DSH_TUI_FAULT: JSON.stringify([{ mode: 'missing', specifier: '@deepseek-ai/dsh-tool-ask-user' }]),
      },
      expect: {
        applyOutcome: 'resolved',
        render: true,
        stderrIncludes: ['DSH question seams unavailable', 'FAULT_INJECTED', '@deepseek-ai/dsh-tool-ask-user'],
      },
    },
    {
      name: 'non-dsh-kernel',
      title: 'B 非 DSH 内核路由（flag=1，无 entrySlot；惰性逻辑不生效）',
      env: { DSH_TUI_LAZY_STARTUP: '1' },
      expect: {
        applyOutcome: 'resolved',
        render: true,
        watchBeforeRender: ['tool-ask-user', 'prompt-debug', 'session-list-metadata'],
      },
    },
    {
      name: 'flag-off',
      title: 'C 旗标关闭（DSH_TUI_LAZY_STARTUP=0；eager 加载四模块）',
      env: { DSH_TUI_LAZY_STARTUP: '0' },
      expect: {
        applyOutcome: 'resolved',
        render: true,
        watchBeforeRender: ['user-questions', 'tool-ask-user', 'prompt-debug', 'session-list-metadata'],
      },
    },
    {
      name: 'fallback-path',
      title: 'D 回退路径（flag=1 + entrySlot.dsh；session-list-metadata 缺失）',
      env: {
        DSH_TUI_LAZY_STARTUP: '1',
        DSH_TUI_FAULT: JSON.stringify([{ mode: 'missing', specifier: './session-list-metadata.js' }]),
      },
      expect: {
        applyOutcome: 'resolved',
        render: true,
        stderrIncludes: ['sessionListMetadata registration failed', 'FAULT_INJECTED', 'session-list-metadata.js'],
        watchAbsentBeforeRender: ['session-list-metadata'],
      },
    },
  ]
}

type LoadEntry = { url: string; at: number }

function readMarks(file: string): { mark: string; ms: number; at: number }[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function readLoads(file: string): LoadEntry[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * 从子进程 stdout 的 ANSI 字节流重建 120×40 屏幕。
 *
 * 子进程退出时退出漏斗会恢复终端（写两次 `ESC[?1049l` 退出备用屏），那会把屏幕
 * 切回空白主屏；所以按「最后一次进入备用屏 → 紧随其后的退出」截取，xterm 解析时
 * 仍停在备用屏上，拿到的是最后一帧。
 */
async function screenTextOf(stdoutText: string): Promise<string> {
  const enterAltScreen = stdoutText.lastIndexOf('\u001b[?1049h')
  const exitAltScreen = enterAltScreen >= 0 ? stdoutText.indexOf('\u001b[?1049l', enterAltScreen) : -1
  const body = enterAltScreen >= 0 && exitAltScreen > enterAltScreen ? stdoutText.slice(0, exitAltScreen) : stdoutText
  const { Terminal } = xterm as unknown as { Terminal: new (options: Record<string, unknown>) => import('@xterm/headless').Terminal }
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 0, allowProposedApi: true })
  await writeParsed(term, body)
  await sleep(50) // 固定窗:pacing 等 xterm 渲染收尾
  return viewportLines(term).join('\n')
}

const visibleChars = (text: string): number => text.replace(/\s/gu, '').length

async function runParent(): Promise<number> {
  const args = process.argv.slice(2)
  const skipGuard = args.includes('--skip-resource-guard')
  const preflightOnly = args.includes('--preflight-only')
  const log: string[] = []
  const echo = (line: string): void => { log.push(line); console.log(line) }
  const startedAt = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  // 日志文件名用本机本地时间（UTC+8），避免与报告中的时间口径混淆。
  const stamp = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`

  // 前置：必须存在编译产物，且它包含 WP6 惰性改动。
  const compiledPlugin = join(LIB, 'dsh-adapter', 'plugin.js')
  if (!existsSync(compiledPlugin)) {
    echo(`FAIL 找不到编译产物 ${compiledPlugin}；先 pnpm build`)
    return 1
  }
  const compiled = readFileSync(compiledPlugin, 'utf8')
  if (!compiled.includes('DSH_TUI_LAZY_STARTUP')) {
    echo('FAIL 编译产物不含 DSH_TUI_LAZY_STARTUP（build 早于 WP6 实验提交 f2873ecd）；先 pnpm build')
    return 1
  }
  const sourcePlugin = join(ROOT, 'src', 'dsh-adapter', 'plugin.ts')
  if (statSync(sourcePlugin).mtimeMs > statSync(compiledPlugin).mtimeMs) {
    echo('WARN src/dsh-adapter/plugin.ts 比 lib/types/dsh-adapter/plugin.js 新，建议先 pnpm build（继续执行）')
  }

  // 资源守卫（默认开启）：可用内存 ≥3 GB，且没有其他 TUI/构建进程。
  const available = typeof (process as unknown as { availableMemory?: () => number }).availableMemory === 'function'
    ? (process as unknown as { availableMemory(): number }).availableMemory()
    : freemem()
  echo(`资源：可用内存 ${(available / GHZ).toFixed(2)} GB（要求 ≥ 3.00 GB）`)
  if (!skipGuard && available < MIN_AVAILABLE_BYTES) {
    echo(`SKIP 可用内存不足（${(available / GHZ).toFixed(2)} GB < 3.00 GB）；等内存释放后重跑，或 ${'--skip-resource-guard'} 调试`)
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(join(LOG_DIR, `t4-lazy-faults-${stamp}.log`), log.join('\n') + '\n')
    return 3
  }
  const competing = competingProcesses()
  if (!skipGuard && !competing.checked) {
    echo(`WARN 进程守卫未执行：${competing.detail}（继续；若另有 TUI/构建在跑请先停止）`)
  } else if (!skipGuard && competing.found.length > 0) {
    echo('SKIP 检测到其他 TUI/构建进程；等它们结束后重跑：')
    for (const item of competing.found.slice(0, 10)) echo(`  pid ${item.pid}: ${item.commandLine.slice(0, 200)}`)
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(join(LOG_DIR, `t4-lazy-faults-${stamp}.log`), log.join('\n') + '\n')
    return 3
  } else {
    echo('资源守卫：通过（无其他 TUI/构建进程）')
  }

  mkdirSync(LOG_DIR, { recursive: true })
  echo(`日志目录：${LOG_DIR}`)
  echo(`时间：${startedAt.toISOString()}；Node ${process.version}；HEAD 由调用方保证`)
  echo('')
  if (preflightOnly) {
    echo('PREFLIGHT-ONLY 通过：构建产物包含 WP6 惰性改动、资源满足；未启动子进程。')
    writeFileSync(join(LOG_DIR, `t4-lazy-faults-${stamp}.log`), log.join('\n') + '\n')
    return 0
  }

  let failed = 0
  const loadCounts: Record<string, number> = {}
  try {
  for (const scenario of scenarios()) {
    const prefix = join(LOG_DIR, `t4-${scenario.name}-${stamp}`)
    const tracePath = prefix + '.boot.jsonl'
    const recordPath = prefix + '.loads.jsonl'
    const resultPath = prefix + '.result.json'
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...scenario.env,
      DSH_TUI_LANG: 'zh',
      DSH_TUI_DEBUG: '1',
      DSH_TUI_BOOT_TRACE: tracePath,
      DSH_TUI_FAULT_RECORD: recordPath,
      DSH_TUI_T4_RESULT: resultPath,
      // 场景名走 env 不走 argv：plugin 会把应用 argv 当启动提示词解析并提交，
      // 夹具里没有可提交的 agent，会多出一条「发送失败」屏幕行。
      DSH_TUI_T4_SCENARIO: scenario.name,
    }
    delete env.DSH_TUI_FAULT
    if (scenario.env.DSH_TUI_FAULT !== undefined) env.DSH_TUI_FAULT = scenario.env.DSH_TUI_FAULT
    const argv = ['--import', 'tsx/esm', '--import', FAULT_LOADER, SELF]
    echo(`━━━ ${scenario.title}`)
    echo(`命令：node ${argv.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')}`)
    echo(`FAULT=${env.DSH_TUI_FAULT ?? '(none)'} LAZY=${env.DSH_TUI_LAZY_STARTUP ?? '(unset)'}`)
    const startedChild = Date.now()
    const child = spawnSync(process.execPath, argv, { cwd: ROOT, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })
    const durationMs = Date.now() - startedChild
    const stdoutText = child.stdout ?? ''
    const stderrText = child.stderr ?? ''
    writeFileSync(prefix + '.stdout.txt', stdoutText)
    writeFileSync(prefix + '.stderr.txt', stderrText)
    echo(`退出码：${String(child.status)}（耗时 ${durationMs} ms，stdout ${stdoutText.length} 字节，stderr ${stderrText.length} 字节）`)

    const checks: { name: string; ok: boolean; detail: string }[] = []
    const check = (name: string, ok: boolean, detail = ''): void => { checks.push({ name, ok, detail }) }
    const resultText = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : ''
    let result: Record<string, unknown> | undefined
    try { result = JSON.parse(resultText) } catch { result = undefined }
    check('子进程正常结束（exit 0）', child.status === 0, `status=${String(child.status)} signal=${String(child.signal)} error=${child.error?.message ?? ''}`)
    check('夹具写出结果 JSON', result !== undefined, resultText.slice(0, 300))
    if (result !== undefined) {
      check(`apply 结果 = ${scenario.expect.applyOutcome}`, result.applyOutcome === scenario.expect.applyOutcome, String(result.applyOutcome) + (result.applyError === undefined ? '' : ` error=${String(result.applyError)}`))
      check('无未捕获异常', Array.isArray(result.uncaught) && result.uncaught.length === 0, JSON.stringify(result.uncaught).slice(0, 500))
      check('无未处理 rejection', Array.isArray(result.unhandled) && result.unhandled.length === 0, JSON.stringify(result.unhandled).slice(0, 500))
    }
    const marks = readMarks(tracePath)
    const renderStart = marks.find((mark) => mark.mark === 'render-start')
    const renderDone = marks.find((mark) => mark.mark === 'render-done')
    if (scenario.expect.render) {
      check('首帧出现（render-start + render-done）', renderStart !== undefined && renderDone !== undefined, marks.map((mark) => mark.mark).join(','))
    } else {
      check('首帧未出现（预期在首帧前失败）', renderStart === undefined, marks.map((mark) => mark.mark).join(','))
    }
    const screenText = await screenTextOf(stdoutText)
    const visible = visibleChars(screenText)
    const summaryLines = screenText.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, 6)
    echo(`首帧文本摘要：${summaryLines.join(' | ').slice(0, 600) || '(空)'}`)
    if (scenario.expect.render) {
      check('不白屏：屏幕可见字符 ≥ 40', visible >= 40, `visible=${visible}`)
      check('屏幕含产品标识（dsh-tui，忽略大小写）', screenText.toLowerCase().includes('dsh-tui'), screenText.split('\n').filter((line) => line.trim() !== '').slice(-6).join(' | ').slice(0, 500))
    }
    for (const needle of scenario.expect.stderrIncludes ?? []) {
      check(`stderr 含可读诊断：${needle}`, stderrText.includes(needle), stderrText.slice(0, 800))
    }
    // 计划判据 2：降级信息可读，且不泄露凭据。这里只查「值形态」——
    // 变量名/文档字符串可以出现，真实密钥形态不允许。
    const combined = stdoutText + '\n' + stderrText
    check('诊断不含疑似密钥值（sk-…/Bearer …）', !/sk-[A-Za-z0-9_-]{16,}/u.test(combined) && !/Bearer [A-Za-z0-9._-]{16,}/u.test(combined), 'matched credential-shaped token')
    const loads = readLoads(recordPath)
    loadCounts[scenario.name] = loads.length
    const preFrame = renderStart === undefined ? loads : loads.filter((entry) => entry.at <= renderStart.at)
    const preFrameHas = (key: keyof typeof WATCH): boolean => preFrame.some((entry) => entry.url.includes(WATCH[key]))
    for (const key of scenario.expect.watchBeforeRender ?? []) {
      check(`首帧前已加载：${key}`, preFrameHas(key), `preFrameLoads=${preFrame.length}`)
    }
    for (const key of scenario.expect.watchAbsentBeforeRender ?? []) {
      check(`首帧前未加载（延迟生效）：${key}`, !preFrameHas(key), `preFrameLoads=${preFrame.length}`)
    }
    echo(`记录：marks=${marks.map((mark) => mark.mark).join(',') || '(none)'}；首帧前模块数=${preFrame.length}；总加载=${loads.length}；屏幕可见字符=${visible}`)
    const scenarioFailed = checks.filter((item) => !item.ok).length
    for (const item of checks) echo(`  ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok || item.detail === '' ? '' : ` — ${item.detail}`}`)
    if (scenarioFailed > 0) failed += scenarioFailed
    echo('')
  }
  } catch (error) {
    failed += 1
    echo(`FAIL 父进程在场景执行中异常：${String((error as Error)?.stack ?? error)}`)
  }

  // 汇总（不替代逐场景断言；跨场景对比只作记录）。
  echo('━━━ 汇总')
  echo(`首帧前加载模块数：${Object.entries(loadCounts).map(([name, count]) => `${name}=${count}`).join('，')}`)
  echo(`断言失败数：${failed}（详见上方 FAIL 行）`)
  if (failed > 0) echo('结果：FAIL')
  else echo('结果：PASS（四场景全部通过）')
  mkdirSync(LOG_DIR, { recursive: true })
  const logPath = join(LOG_DIR, `t4-lazy-faults-${stamp}.log`)
  writeFileSync(logPath, log.join('\n') + '\n')
  console.log(`完整日志：${logPath}`)
  return failed > 0 ? 1 : 0
}

const childScenario = process.env.DSH_TUI_T4_SCENARIO
if (childScenario !== undefined && childScenario !== '') {
  await runChild(childScenario)
} else {
  process.exitCode = await runParent()
}
