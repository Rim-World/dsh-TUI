/**
 * T3 屏幕黄金比对（在分支构建执行；计划 §4 T3 第 5–6 条）。
 *
 *   1. 读取 `scripts/fixtures/screen/*.screen.json`（必须来自基线构建，
 *      录制脚本写入 `source.commit`；`--baseline-commit` 可强校验）；
 *   2. 在分支构建上重放同一批事件检查点，用真实 MessageList 渲染、归一化；
 *   3. 逐变体、逐检查点、逐行比较，任何白名单外差异都判失败；
 *   4. 默认再跑一次 `DSH_TUI_LAZY_STARTUP=1` 变体（独立子进程，确保旗标在
 *      模块加载前生效），要求与默认渲染一致，并且同样等于黄金。
 *
 * 用法：
 *   node --import tsx/esm scripts/verify-screen-golden.ts
 *   node --import tsx/esm scripts/verify-screen-golden.ts --golden-dir <dir> --no-lazy
 *   node --import tsx/esm scripts/verify-screen-golden.ts --baseline-commit 0359e6f5
 *
 * 失败时退出码 1；黄金缺失/选项过期等配置问题退出码 2。输出可直接重定向到
 * TMP/07_验证日志/04_屏幕黄金差分/ 留档（只含合成夹具画面、计数与哈希）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
/** Read `--name=value` / `--name value` from argv. */
function arg(name: string, fallback: string | undefined): string | undefined {
  const inline = argv.find(entry => entry.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) {
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) return next
  }
  return fallback
}

const selfPath = fileURLToPath(import.meta.url)
const emitJson = argv.includes('--emit-json')
const noLazy = argv.includes('--no-lazy')
const baselineCommit = arg('baseline-commit', undefined)
const goldenDir = resolve(arg('golden-dir', fileURLToPath(new URL('./fixtures/screen', import.meta.url))) as string)

const {
  screenVariants,
  captureAllScreens,
  readScreenGolden,
  goldenFilesIn,
  screenGoldenOptions,
  diffScreenLines,
  hashLines,
  assertNormalizationWellFormed,
  NORMALIZATION_VERSION,
} = await import('./lib/screen-golden.js')

type Doc = NonNullable<ReturnType<typeof readScreenGolden>>
type Captured = Awaited<ReturnType<typeof captureAllScreens>>[number]

const variantKey = (figure: string, variant: string): string => `${figure}/${variant}`

/** One structured failure; printed with expected/actual excerpts. */
interface Failure {
  readonly where: string
  readonly message: string
  readonly expected?: string
  readonly actual?: string
}

const failures: Failure[] = []
const fail = (failure: Failure): void => { failures.push(failure) }

/** Compare the golden's recorded options with the pipeline's current options. */
function checkOptions(doc: Doc, key: string): void {
  const expected = JSON.stringify(screenGoldenOptions({ fixture: doc.fixture, variant: doc.variant, thinkingFold: doc.options.thinkingFold, goldenFile: '' }))
  const actual = JSON.stringify(doc.options)
  if (expected !== actual) {
    fail({ where: key, message: 'golden options do not match this pipeline (stale or foreign golden; re-record from the baseline build)', expected, actual })
  }
  if (doc.normalization?.version !== NORMALIZATION_VERSION) {
    fail({ where: key, message: 'normalization version mismatch (golden recorded with another rule set)', expected: String(NORMALIZATION_VERSION), actual: String(doc.normalization?.version) })
  }
  if (typeof doc.source?.commit !== 'string' || doc.source.commit.trim() === '') {
    fail({ where: key, message: 'golden has no source.commit (provenance unknown; plan §4 T3 item 4 forbids committing it)' })
  }
  if (baselineCommit !== undefined && doc.source?.commit !== undefined && !doc.source.commit.startsWith(baselineCommit)) {
    fail({ where: key, message: 'golden was not recorded from the expected baseline commit', expected: baselineCommit, actual: doc.source.commit })
  }
}

/** Compare one captured variant against its golden, line by line. */
function compareVariant(doc: Doc, captured: Captured): { passed: number; failed: number } {
  const key = variantKey(doc.fixture, doc.variant)
  const goldenCheckpoints = new Map(doc.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]))
  const actualCheckpoints = new Map(captured.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]))
  let passed = 0
  let failed = 0
  for (const golden of doc.checkpoints) {
    const actual = actualCheckpoints.get(golden.id)
    if (actual === undefined) {
      fail({ where: key, message: `checkpoint missing on this build: ${golden.id}` })
      failed += 1
      continue
    }
    if (golden.kind !== actual.kind) {
      fail({ where: key, message: `checkpoint kind changed: ${golden.id}`, expected: golden.kind, actual: actual.kind })
      failed += 1
      continue
    }
    const diffs = diffScreenLines(golden.id, golden.lines, actual.lines)
    if (diffs.length === 0) {
      passed += 1
      console.log(`PASS ${key} ${golden.id} hash=${hashLines(actual.lines)}`)
      continue
    }
    failed += 1
    console.log(`FAIL ${key} ${golden.id} diffs=${diffs.length} goldenHash=${hashLines(golden.lines)} actualHash=${hashLines(actual.lines)}`)
    for (const diff of diffs.slice(0, 5)) {
      if (diff.kind === 'line') {
        console.log(`   line ${diff.line} -${JSON.stringify((diff.expected ?? '').slice(0, 160))}`)
        console.log(`   line ${diff.line} +${JSON.stringify((diff.actual ?? '').slice(0, 160))}`)
      } else {
        console.log(`   ${diff.kind}: expected=${JSON.stringify(diff.expected)} actual=${JSON.stringify(diff.actual)}`)
      }
    }
    if (diffs.length > 5) console.log(`   ... ${diffs.length - 5} more line diffs`)
    fail({ where: key, message: `${golden.id}: ${diffs.length} line diff(s)` })
  }
  for (const actual of captured.checkpoints) {
    if (!goldenCheckpoints.has(actual.id)) {
      fail({ where: key, message: `checkpoint exists on this build but not in the golden: ${actual.id}` })
      failed += 1
    }
  }
  const goldenSkipped = new Set(doc.skipped.map(entry => entry.id))
  const actualSkipped = new Set(captured.skipped.map(entry => entry.id))
  for (const id of goldenSkipped) if (!actualSkipped.has(id)) fail({ where: key, message: `checkpoint no longer skipped: ${id} (recording and comparison disagree)` })
  for (const id of actualSkipped) if (!goldenSkipped.has(id)) fail({ where: key, message: `checkpoint newly skipped: ${id} (recording and comparison disagree)` })
  return { passed, failed }
}

/** Build a variant key -> screens view of a pipeline run (default or lazy). */
function screenView(screens: readonly Captured[]): Map<string, Captured> {
  const map = new Map<string, Captured>()
  for (const screen of screens) map.set(variantKey(screen.variant.fixture, screen.variant.variant), screen)
  return map
}

// --- child mode: render every checkpoint and print machine-readable JSON -----
if (emitJson) {
  try {
    assertNormalizationWellFormed()
    const screens = await captureAllScreens()
    const payload = {
      kind: 'screen-golden-screens',
      lazyStartup: process.env.DSH_TUI_LAZY_STARTUP === '1',
      variants: screens.map(screen => ({
        fixture: screen.variant.fixture,
        variant: screen.variant.variant,
        skipped: screen.skipped,
        checkpoints: screen.checkpoints.map(checkpoint => ({ id: checkpoint.id, kind: checkpoint.kind, lines: checkpoint.lines })),
      })),
    }
    // Delimited: Ink writes terminal-cleanup escapes straight to process.stdout,
    // so the payload must not be the last line's implicit content.
    process.stdout.write(`\n<<<SCREEN_JSON>>>\n${JSON.stringify(payload)}\n<<<END_SCREEN_JSON>>>\n`)
    process.exit(0)
  } catch (error) {
    console.error(`FAIL: emit-json capture failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  }
}

// --- verification mode ------------------------------------------------------
console.log('==== T3 screen golden verify ====')
console.log(`golden dir: ${goldenDir}`)
console.log(`baseline commit (pinned): ${baselineCommit ?? '(not pinned; using each golden\'s source.commit)'}`)
console.log(`normalization version: ${NORMALIZATION_VERSION}`)
assertNormalizationWellFormed()

const variants = screenVariants()
const expectedFiles = variants.map(variant => variant.goldenFile).sort()
const actualFiles = goldenFilesIn(goldenDir)
if (actualFiles.length === 0) {
  console.error(`FAIL: no *.screen.json goldens in ${goldenDir}`)
  process.exit(2)
}
for (const file of expectedFiles) {
  if (!actualFiles.includes(file)) {
    console.error(`FAIL: missing golden file ${join(goldenDir, file)}`)
    process.exit(2)
  }
}
for (const file of actualFiles) {
  if (!expectedFiles.includes(file)) {
    console.error(`FAIL: orphan golden file ${join(goldenDir, file)} (no variant produces it; it must not be committed)`)
    process.exit(2)
  }
}

const docs = new Map<string, Doc>()
for (const variant of variants) {
  const doc = readScreenGolden(goldenDir, variant)
  if (doc === undefined) {
    console.error(`FAIL: cannot parse golden ${join(goldenDir, variant.goldenFile)}`)
    process.exit(2)
  }
  if (doc.fixture !== variant.fixture || doc.variant !== variant.variant) {
    console.error(`FAIL: golden ${variant.goldenFile} declares ${doc.fixture}/${doc.variant}`)
    process.exit(2)
  }
  const key = variantKey(variant.fixture, variant.variant)
  docs.set(key, doc)
  checkOptions(doc, key)
  console.log(`golden ${key}: source.commit=${doc.source?.commit ?? 'MISSING'} checkpoints=${doc.checkpoints.length} skipped=${doc.skipped.length}`)
}

let totalPassed = 0
let totalFailed = 0
const defaultScreens = await captureAllScreens()
const defaultView = screenView(defaultScreens)
for (const variant of variants) {
  const key = variantKey(variant.fixture, variant.variant)
  const doc = docs.get(key)!
  const captured = defaultView.get(key)
  if (captured === undefined) {
    console.error(`FAIL: pipeline did not capture variant ${key}`)
    process.exit(1)
  }
  const result = compareVariant(doc, captured)
  totalPassed += result.passed
  totalFailed += result.failed
  console.log(`SUMMARY ${key}: checkpoints=${doc.checkpoints.length} passed=${result.passed} failed=${result.failed} skipped=${doc.skipped.length} goldenHash=${hashLines(doc.checkpoints.flatMap(checkpoint => checkpoint.lines))} actualHash=${hashLines(captured.checkpoints.flatMap(checkpoint => checkpoint.lines))}`)
}

// --- lazy startup variant: independent child process, flag set before import --
if (!noLazy) {
  console.log('---- lazy startup variant (DSH_TUI_LAZY_STARTUP=1) ----')
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', selfPath, '--emit-json', '--no-lazy', '--golden-dir', goldenDir], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_TUI_LAZY_STARTUP: '1' },
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (child.status !== 0) {
    console.error(`FAIL lazy: child process exited with status ${String(child.status)} signal ${String(child.signal)}`)
    if (child.stderr) console.error(child.stderr.slice(0, 4000))
    fail({ where: 'lazy', message: 'lazy child process failed' })
  } else {
    try {
      const delimited = /<<<SCREEN_JSON>>>\n([\s\S]*?)\n<<<END_SCREEN_JSON>>>/u.exec(child.stdout)
      const rawPayload = delimited?.[1] ?? child.stdout.trim().split('\n').at(-1) ?? ''
      const payload = JSON.parse(rawPayload) as {
        lazyStartup: boolean
        variants: { fixture: string; variant: string; checkpoints: { id: string; lines: string[] }[] }[]
      }
      if (payload.lazyStartup !== true) {
        fail({ where: 'lazy', message: 'lazy child did not report DSH_TUI_LAZY_STARTUP=1' })
      }
      const lazyView = new Map(payload.variants.map(entry => [variantKey(entry.fixture, entry.variant), entry]))
      let lazyDiffs = 0
      for (const variant of variants) {
        const key = variantKey(variant.fixture, variant.variant)
        const lazy = lazyView.get(key)
        const base = defaultView.get(key)
        const doc = docs.get(key)!
        if (lazy === undefined || base === undefined) {
          fail({ where: `lazy ${key}`, message: 'lazy variant missing' })
          lazyDiffs += 1
          continue
        }
        const lazyById = new Map(lazy.checkpoints.map(checkpoint => [checkpoint.id, checkpoint.lines]))
        for (const checkpoint of base.checkpoints) {
          const lazyLines = lazyById.get(checkpoint.id)
          if (lazyLines === undefined) {
            fail({ where: `lazy ${key}`, message: `checkpoint missing with flag on: ${checkpoint.id}` })
            lazyDiffs += 1
            continue
          }
          const onOff = diffScreenLines(checkpoint.id, checkpoint.lines, lazyLines)
          const golden = doc.checkpoints.find(item => item.id === checkpoint.id)
          const vsGolden = golden === undefined ? [{ kind: 'missing' as const, checkpoint: checkpoint.id }] : diffScreenLines(checkpoint.id, golden.lines, lazyLines)
          if (onOff.length > 0) {
            fail({ where: `lazy ${key}`, message: `${checkpoint.id}: flag on differs from flag off (${onOff.length} lines)` })
            lazyDiffs += 1
          } else if (vsGolden.length > 0) {
            fail({ where: `lazy ${key}`, message: `${checkpoint.id}: flag on differs from golden (${vsGolden.length} lines)` })
            lazyDiffs += 1
          }
        }
      }
      console.log(lazyDiffs === 0 ? 'LAZY PASS: DSH_TUI_LAZY_STARTUP=1 renders identically (all variants/checkpoints)' : `LAZY FAIL: ${lazyDiffs} checkpoint mismatch(es)`)
    } catch (error) {
      console.error(`FAIL lazy: cannot parse child JSON: ${String(error)}`)
      if (child.stdout) console.error(child.stdout.slice(-2000))
      fail({ where: 'lazy', message: 'lazy child output is not valid JSON' })
    }
  }
} else {
  console.log('---- lazy startup variant skipped (--no-lazy) ----')
}

console.log('==============================================')
console.log(`RESULT: checkpoints passed=${totalPassed} failed=${totalFailed} failures=${failures.length}`)
if (failures.length > 0) {
  console.log('FAIL: screen golden differences outside the appendix C whitelist')
  for (const failure of failures.slice(0, 20)) console.log(`  - [${failure.where}] ${failure.message}`)
  if (failures.length > 20) console.log(`  ... ${failures.length - 20} more failures`)
  process.exit(1)
}
console.log(`PASS: all screen goldens match the baseline build (normalization v${NORMALIZATION_VERSION}, lazy variant included)`)
process.exit(0)
