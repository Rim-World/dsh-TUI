/**
 * T3 屏幕黄金录制（只在基线构建 worktree 执行；计划 §4 T3 第 4 条）。
 *
 * 把 `scripts/lib/screen-golden.ts` 与本源脚本复制进基线 worktree 后运行：
 *   cd TMP/08_基线构建/dsh-tui-baseline
 *   mkdir -p scripts/lib
 *   cp <分支仓>/scripts/lib/screen-golden.ts scripts/lib/
 *   cp <分支仓>/scripts/capture-screen-golden.ts scripts/
 *   node --import tsx/esm scripts/capture-screen-golden.ts \
 *     --out <分支仓>/9.SRC/dsh-TUI/scripts/fixtures/screen \
 *     --expect-commit 0359e6f5
 *
 * 判据（计划 §4 T3）：
 *   - 本脚本读 `git rev-parse HEAD` 写进每个黄金的 `source.commit`；
 *     `--expect-commit` 不匹配时拒绝录制（防止把分支构建录成基线）。
 *   - 录制只写纯文本帧（40 行 × 120 列），单夹具一个文件。
 *   - 归一化只走附录 C 白名单；本脚本会打印每条规则的命中计数。
 *   - 只有确认来源（commit 可解析）的黄金才会落盘。
 *
 * 运行输出（stdout）：每个变体的检查点数/跳过项/归一化命中/文件路径/字节数/
 * sha256；可直接重定向到 TMP/07_验证日志/04_屏幕黄金差分/ 留档。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

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

const outDir = arg('out', undefined)
const expectCommit = arg('expect-commit', undefined)
if (outDir === undefined) {
  console.error('FAIL: --out <dir> is required (the branch repo scripts/fixtures/screen directory)')
  process.exit(2)
}
const resolvedOut = resolve(outDir)

/** Resolve a git revision to a full commit sha in the current worktree. */
function revParse(revision: string): string {
  return execFileSync('git', ['rev-parse', revision], { cwd: process.cwd(), encoding: 'utf8' }).trim()
}

let headCommit: string
try {
  headCommit = revParse('HEAD')
} catch (error) {
  console.error(`FAIL: cannot resolve git HEAD (golden provenance is mandatory): ${String(error)}`)
  process.exit(2)
}

if (expectCommit !== undefined) {
  let expected: string
  try {
    expected = revParse(expectCommit)
  } catch (error) {
    console.error(`FAIL: cannot resolve --expect-commit ${expectCommit}: ${String(error)}`)
    process.exit(2)
  }
  if (!headCommit.startsWith(expected)) {
    console.error(`FAIL: current worktree HEAD=${headCommit} is not the expected baseline ${expected}.`)
    console.error('      Screen goldens may only be recorded from the baseline build worktree.')
    process.exit(2)
  }
}

const { captureAllScreens, collectAllCheckpoints, buildScreenGolden, writeScreenGolden, goldenFilesIn, assertNormalizationWellFormed, SCREEN_COLS, SCREEN_ROWS } = await import('./lib/screen-golden.js')

/** sha256 of a file on disk. */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

mkdirSync(resolvedOut, { recursive: true })
const existing = goldenFilesIn(resolvedOut)

console.log('==== T3 screen golden capture ====')
console.log(`worktree HEAD: ${headCommit}`)
console.log(`out dir:       ${resolvedOut}`)
console.log(`expect commit: ${expectCommit ?? '(not pinned)'}`)
console.log(`screen:        ${SCREEN_COLS}x${SCREEN_ROWS}, lang=zh, theme=dark, renderer=MessageList (alt-screen)`)
console.log(`existing goldens in out dir: ${existing.length}`)

// 投影确定性自检（纯计算，不渲染）：同一进程连跑两次必须逐字节一致。
assertNormalizationWellFormed()
const projectionA = JSON.stringify(collectAllCheckpoints())
const projectionB = JSON.stringify(collectAllCheckpoints())
if (projectionA !== projectionB) {
  console.error('FAIL: projection checkpoints are not deterministic across two collection runs (clock/state leak)')
  process.exit(1)
}
console.log('projection determinism: PASS (two collection runs byte-identical)')

const captured = await captureAllScreens()
let totalCheckpoints = 0
let totalSkipped = 0
const written: { file: string; sha256: string; bytes: number }[] = []
const hits = { C1: 0, C2: 0, C3: 0, C4: 0 }

for (const entry of captured) {
  const document = buildScreenGolden(entry, headCommit)
  const path = writeScreenGolden(resolvedOut, document)
  const bytes = statSync(path).size
  const sha256 = fileSha256(path)
  written.push({ file: path, sha256, bytes })
  totalCheckpoints += entry.checkpoints.length
  totalSkipped += entry.skipped.length
  hits.C1 += entry.hits.C1
  hits.C2 += entry.hits.C2
  hits.C3 += entry.hits.C3
  hits.C4 += entry.hits.C4
  console.log('--------------------------------------------------------------')
  console.log(`variant ${entry.variant.fixture}/${entry.variant.variant}: checkpoints=${entry.checkpoints.length} skipped=${entry.skipped.length} hitC1=${entry.hits.C1} hitC2=${entry.hits.C2} hitC3=${entry.hits.C3} hitC4=${entry.hits.C4}`)
  for (const checkpoint of entry.checkpoints) {
    console.log(`  ${checkpoint.kind.padEnd(17)} ${checkpoint.id.padEnd(28)} lines=${checkpoint.lines.length} hash=${createHash('sha256').update(checkpoint.lines.join('\\n')).digest('hex').slice(0, 12)}`)
  }
  for (const skipped of entry.skipped) console.log(`  SKIP ${skipped.id}: ${skipped.reason}`)
  console.log(`  file ${path} bytes=${bytes} sha256=${sha256}`)
}

if (written.length !== 5) {
  console.error(`FAIL: expected 5 screen golden files (4 fixtures + 1 thinking-full variant), wrote ${written.length}`)
  process.exit(1)
}
for (const entry of written) {
  const parsed = JSON.parse(readFileSync(entry.file, 'utf8')) as { source?: { commit?: string }; checkpoints?: unknown[] }
  if (parsed.source?.commit !== headCommit) {
    console.error(`FAIL: golden ${entry.file} lost its provenance (source.commit !== HEAD)`)
    process.exit(1)
  }
  if (!Array.isArray(parsed.checkpoints) || parsed.checkpoints.length === 0) {
    console.error(`FAIL: golden ${entry.file} has no checkpoints`)
    process.exit(1)
  }
}
console.log('--------------------------------------------------------------')
console.log(`TOTAL variants=${written.length} checkpoints=${totalCheckpoints} skipped=${totalSkipped} hitC1=${hits.C1} hitC2=${hits.C2} hitC3=${hits.C3} hitC4=${hits.C4}`)
console.log('PASS: captured 5 screen golden files from the pinned baseline commit')

// The headless render harness leaves event-loop handles behind (fake streams /
// Ink instances); the run is complete, so terminate deterministically.
process.exit(0)
