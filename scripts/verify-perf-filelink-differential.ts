/**
 * T1 链接正则差分：src/utils/fileTarget.ts（现实现）对 0359e6f5 基线参考实现。
 *
 * 判据（004-M T1 节、附录 B）：
 * 1. 对每条合成语料分别运行基线参考实现与现实现，提取链接区间集合
 *    （start、end、text、target），逐项比较。
 * 2. 差异必须命中附录 B：
 *    - B1：>200 字符且不含空白与分隔符的单个 token（基线回溯超时，现实现快速返回）；
 *    - B2：单分隔符加超长无空白尾部（S4 类）；
 *    - B3（反向例外）：现实现有、基线无；差异所在 token 长度 >=200 且 token 内无空白，
 *      或 token 内存在 >=100 个连续相同字符（回溯敏感形态）。每条例外必须可复算；
 *      不满足条件的反向差异仍失败。
 *    白名单外差异一律失败，退出码 1。
 * 3. 单条语料任一实现的耗时上限 5000 ms，防止参考实现回溯挂起。
 * 4. 真实语料只读模式：--corpus <dir> 扫描 .md/.ts，只输出计数与哈希，不落盘、
 *    不打印原文；该模式为信息性，不改变门禁退出码（附录 B 只定义合成语料判据）。
 * 5. B3 反向探测：--probe-extended 运行 004-E 7.1 节 A7 的残余反向差异样本，
 *    按 B3 条件逐条判定并计入门禁（允许现实现新增、基线无；条件不满足即失败）。
 *    加 --strict-probes 时禁用 B3，用于自检「普通反向差异仍会失败、退出码 1」。
 *
 * 运行：node --import tsx/esm scripts/verify-perf-filelink-differential.ts
 *       [--corpus <目录>] [--probe-extended] [--limit <文件数>]
 */
import { createHash } from 'node:crypto'

const { linkifyFilePaths: baselineLinkify, BASELINE_COMMIT, BASELINE_SOURCE } = await import('./lib/filelink-baseline.js')
const { linkifyFilePaths: currentLinkify } = await import('../src/utils/fileTarget.js')
const { SYNTHETIC_CORPUS, EXTENDED_PROBES, scanRealCorpus } = await import('./fixtures/filelink/corpus.js')

/** 计划 T1 节判据 3：单条语料耗时上限。 */
const BUDGET_MS = 5000
/** 链接区间记录的包装标记；语料本身不含 NUL。 */
const NUL = String.fromCharCode(0)
const MARKER_HEAD = NUL + 'F'

interface LinkSpan {
  start: number
  end: number
  text: string
  target: string
}

interface Capture {
  links: LinkSpan[]
  output: string
  ms: number
}

/**
 * 运行一次 linkifyFilePaths，并用包装标记还原每个链接在原输入里的区间。
 * wrap 收到的 path 与 display 都记录；标记里的序号把两者对回 replace 的插入点。
 */
function capture(
  fn: (text: string, wrap: (path: string, display: string) => string) => string,
  text: string,
): Capture {
  const recorded: { path: string; display: string }[] = []
  const started = performance.now()
  const output = fn(text, (path, display) => {
    recorded.push({ path, display })
    return MARKER_HEAD + (recorded.length - 1) + NUL
  })
  const ms = performance.now() - started
  const links: LinkSpan[] = []
  let outIndex = 0
  let originalIndex = 0
  while (outIndex < output.length) {
    if (output.charCodeAt(outIndex) === 0) {
      const close = output.indexOf(NUL, outIndex + 1)
      if (close === -1) throw new Error('链接标记未闭合：wrap 返回值被替换或输入含 NUL')
      const index = Number(output.slice(outIndex + MARKER_HEAD.length, close))
      const entry = recorded[index]
      if (entry === undefined) throw new Error('链接标记索引越界：' + index + ' / ' + recorded.length)
      links.push({
        start: originalIndex,
        end: originalIndex + entry.display.length,
        text: entry.display,
        target: entry.path,
      })
      originalIndex += entry.display.length
      outIndex = close + 1
    } else {
      outIndex += 1
      originalIndex += 1
    }
  }
  return { links, output, ms }
}

const spanKey = (span: LinkSpan): string =>
  JSON.stringify([span.start, span.end, span.text, span.target])

interface DiffResult {
  baselineOnly: LinkSpan[]
  currentOnly: LinkSpan[]
}

function diffLinks(baseline: LinkSpan[], current: LinkSpan[]): DiffResult {
  const baselineKeys = new Set(baseline.map(spanKey))
  const currentKeys = new Set(current.map(spanKey))
  return {
    baselineOnly: baseline.filter(span => !currentKeys.has(spanKey(span))),
    currentOnly: current.filter(span => !baselineKeys.has(spanKey(span))),
  }
}

const isWhitespace = (ch: string): boolean => ch.trim() === ''

interface TokenInfo {
  start: number
  end: number
  length: number
  longestRun: number
}

/** 取 index 所在的「空白分隔 token」，并计算最长连续相同字符长度。 */
function tokenInfoAt(text: string, index: number): TokenInfo {
  let start = index
  while (start > 0 && !isWhitespace(text[start - 1]!)) start -= 1
  let end = index
  while (end < text.length && !isWhitespace(text[end]!)) end += 1
  const token = text.slice(start, end)
  let longestRun = token.length === 0 ? 0 : 1
  let run = 1
  for (let cursor = 1; cursor < token.length; cursor += 1) {
    if (token[cursor] === token[cursor - 1]) {
      run += 1
      if (run > longestRun) longestRun = run
    } else {
      run = 1
    }
  }
  return { start, end, length: token.length, longestRun }
}

const B3_MIN_TOKEN_LENGTH = 200
const B3_MIN_IDENTICAL_RUN = 100

/** B3 条件：token 长度 >=200（token 内无空白）或最长连续相同字符 >=100。 */
function classifyB3(text: string, span: LinkSpan): TokenInfo | undefined {
  const token = tokenInfoAt(text, span.start)
  if (token.length >= B3_MIN_TOKEN_LENGTH) return token
  if (token.longestRun >= B3_MIN_IDENTICAL_RUN) return token
  return undefined
}

interface B3Sample {
  source: 'corpus' | 'probe'
  id: string
  shape: string
  text: string
  tokenLength: number
  longestRun: number
  baselineLinks: number
  currentLinks: number
  /** B3 例外的新增链接区间（可复算证据）。 */
  newSpans: LinkSpan[]
  reason: string
}

interface DiffDecision {
  allowed: boolean
  verdict: string
  b3?: { tokenLength: number; longestRun: number; reason: string }
}

/** 按附录 B 判定一条差异；B3 反向例外必须逐 span 满足条件。 */
function evaluateDiff(
  text: string,
  diff: DiffResult,
  declared: string | undefined,
  b3Allowed: boolean,
): DiffDecision {
  if (declared === 'B1' || declared === 'B2') {
    const allowed = diff.currentOnly.length === 0
    return {
      allowed,
      verdict: allowed
        ? '允许差异（' + declared + '，基线有/现实现无）'
        : '白名单外差异（' + declared + ' 只允许基线有/现实现无）',
    }
  }
  if (declared === 'B3') {
    if (!b3Allowed) return { allowed: false, verdict: '白名单外差异（B3 在严格模式禁用）' }
    if (diff.baselineOnly.length > 0) {
      return { allowed: false, verdict: '白名单外差异（B3 只允许现实现新增）' }
    }
    if (diff.currentOnly.length === 0) {
      return { allowed: false, verdict: '白名单外差异（B3 无反向新增）' }
    }
    let tokenLength = 0
    let longestRun = 0
    let reason = ''
    for (const span of diff.currentOnly) {
      const token = classifyB3(text, span)
      if (token === undefined) {
        return {
          allowed: false,
          verdict: '白名单外差异（B3 条件不满足：token<' + B3_MIN_TOKEN_LENGTH +
            ' 且最长连续相同字符<' + B3_MIN_IDENTICAL_RUN + '）',
        }
      }
      if (token.length > tokenLength) tokenLength = token.length
      if (token.longestRun > longestRun) longestRun = token.longestRun
      reason = token.length >= B3_MIN_TOKEN_LENGTH
        ? 'token 长度 ' + token.length + ' >= ' + B3_MIN_TOKEN_LENGTH + ' 且 token 内无空白'
        : '最长连续相同字符 ' + token.longestRun + ' >= ' + B3_MIN_IDENTICAL_RUN
    }
    return { allowed: true, verdict: '允许差异（B3，现实现有/基线无）', b3: { tokenLength, longestRun, reason } }
  }
  return { allowed: false, verdict: '白名单外差异' }
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

function preview(text: string, limit = 160): string {
  const escaped = JSON.stringify(text)
  return escaped.length <= limit ? escaped : escaped.slice(0, limit) + '...'
}

interface ShapeStat {
  cases: number
  diffs: number
  allowed: number
  failed: number
}

const shapeStats = new Map<string, ShapeStat>()
function shapeStat(shape: string): ShapeStat {
  let stat = shapeStats.get(shape)
  if (stat === undefined) {
    stat = { cases: 0, diffs: 0, allowed: 0, failed: 0 }
    shapeStats.set(shape, stat)
  }
  return stat
}

interface FirstDiff {
  id: string
  shape: string
  whitelist: string | undefined
  verdict: string
  text: string
  baseline: LinkSpan[]
  current: LinkSpan[]
  diff: DiffResult
}

let failures = 0
let diffCount = 0
let allowedCount = 0
let firstDiff: FirstDiff | undefined
let totalCaseMs = 0
let maxBaselineMs = 0
let maxCurrentMs = 0
let b3Count = 0
let allowB3 = true
const b3Samples: B3Sample[] = []

function fail(label: string, detail: string): void {
  failures += 1
  console.log('FAIL ' + label + (detail === '' ? '' : ': ' + detail))
}

function recordB3(sample: B3Sample): void {
  b3Count += 1
  b3Samples.push(sample)
}

/** 合成语料差分（门禁）。 */
function runSynthetic(): void {
  const cases = SYNTHETIC_CORPUS
  console.log('合成语料：' + cases.length + ' 条；单条耗时上限 ' + BUDGET_MS + ' ms')
  for (const testCase of cases) {
    const stat = shapeStat(testCase.shape)
    stat.cases += 1
    if (testCase.text.includes(NUL)) {
      stat.failed += 1
      fail(testCase.id, '输入包含 NUL，无法使用标记回填区间')
      continue
    }
    if (testCase.referenceSkip === 'slow') {
      const current = capture(currentLinkify, testCase.text)
      let ok = true
      if (current.links.length !== 0) {
        ok = false
        fail(testCase.id, '参考实现跳过用例的现实现产生了链接：' + current.links.length)
      }
      if (current.output !== testCase.text) {
        ok = false
        fail(testCase.id, '现实现输出与输入不一致（应原样返回）')
      }
      totalCaseMs += current.ms
      if (current.ms > maxCurrentMs) maxCurrentMs = current.ms
      if (current.ms > BUDGET_MS) {
        ok = false
        fail(testCase.id, '现实现耗时超过预算：' + current.ms.toFixed(1) + ' ms')
      }
      if (ok) {
        console.log('ok   [' + testCase.shape + '] ' + testCase.id + ' · 参考实现按 B1 已知平方级跳过（只跑现实现）')
      }
      continue
    }
    const baseline = capture(baselineLinkify, testCase.text)
    const current = capture(currentLinkify, testCase.text)
    totalCaseMs += baseline.ms + current.ms
    if (baseline.ms > maxBaselineMs) maxBaselineMs = baseline.ms
    if (current.ms > maxCurrentMs) maxCurrentMs = current.ms
    let ok = true
    if (baseline.ms > BUDGET_MS) {
      ok = false
      fail(testCase.id, '基线参考实现耗时超过预算：' + baseline.ms.toFixed(1) + ' ms')
    }
    if (current.ms > BUDGET_MS) {
      ok = false
      fail(testCase.id, '现实现耗时超过预算：' + current.ms.toFixed(1) + ' ms')
    }
    if (JSON.stringify(baseline.links) === JSON.stringify(current.links)) {
      console.log('ok   [' + testCase.shape + '] ' + testCase.id)
      continue
    }
    diffCount += 1
    stat.diffs += 1
    const diff = diffLinks(baseline.links, current.links)
    const declared: string | undefined = testCase.whitelist
    const decision = evaluateDiff(testCase.text, diff, declared, allowB3)
    const allowed = decision.allowed
    const verdict = decision.verdict
    if (firstDiff === undefined) {
      firstDiff = {
        id: testCase.id,
        shape: testCase.shape,
        whitelist: declared,
        verdict,
        text: testCase.text,
        baseline: baseline.links,
        current: current.links,
        diff,
      }
    }
    const detail = 'baseline=' + baseline.links.length + ' current=' + current.links.length +
      ' baselineOnly=' + diff.baselineOnly.length + ' currentOnly=' + diff.currentOnly.length
    if (allowed) {
      allowedCount += 1
      stat.allowed += 1
      if (decision.b3 !== undefined) {
        recordB3({
          source: 'corpus',
          id: testCase.id,
          shape: testCase.shape,
          text: testCase.text,
          tokenLength: decision.b3.tokenLength,
          longestRun: decision.b3.longestRun,
          baselineLinks: baseline.links.length,
          currentLinks: current.links.length,
          newSpans: diff.currentOnly,
          reason: decision.b3.reason,
        })
        console.log('ok   [' + testCase.shape + '] ' + testCase.id + ' · ' + verdict +
          ' · tokenLen=' + decision.b3.tokenLength + ' longestRun=' + decision.b3.longestRun +
          ' · baseline=' + baseline.links.length + ' current=' + current.links.length)
      } else {
        console.log('ok   [' + testCase.shape + '] ' + testCase.id + ' · ' + verdict + ' · ' + detail)
      }
      // 差异必须可复算：同输入再跑一遍，区间集合必须一致。
      const rerunBaseline = capture(baselineLinkify, testCase.text).links
      const rerunCurrent = capture(currentLinkify, testCase.text).links
      if (JSON.stringify(rerunBaseline) !== JSON.stringify(baseline.links)
        || JSON.stringify(rerunCurrent) !== JSON.stringify(current.links)) {
        ok = false
        fail(testCase.id, '允许差异不可复算：两次运行区间集合不一致')
      }
    } else {
      ok = false
      stat.failed += 1
      fail(testCase.id, verdict + ' · ' + detail)
    }
  }
}

/** B3 反向探测：默认按 B3 判定；--strict-probes 时 B3 禁用，差异必须失败。 */
function runExtendedProbes(strictLabel: boolean): void {
  console.log('')
  console.log('B3 反向探测（--probe-extended）：' + EXTENDED_PROBES.length + ' 条' +
    (strictLabel ? '；严格模式：B3 禁用' : ''))
  for (const probe of EXTENDED_PROBES) {
    const baseline = capture(baselineLinkify, probe.text)
    const current = capture(currentLinkify, probe.text)
    if (JSON.stringify(baseline.links) === JSON.stringify(current.links)) {
      console.log('info [' + probe.shape + '] ' + probe.id + ' · 无差异（B3 未命中）')
      continue
    }
    const diff = diffLinks(baseline.links, current.links)
    const decision = evaluateDiff(probe.text, diff, 'B3', allowB3)
    if (!decision.allowed) {
      fail(probe.id, decision.verdict + ' · baseline=' + baseline.links.length +
        ' current=' + current.links.length + ' · ' + probe.note)
      continue
    }
    const b3 = decision.b3!
    recordB3({
      source: 'probe',
      id: probe.id,
      shape: probe.shape,
      text: probe.text,
      tokenLength: b3.tokenLength,
      longestRun: b3.longestRun,
      baselineLinks: baseline.links.length,
      currentLinks: current.links.length,
      newSpans: diff.currentOnly,
      reason: b3.reason,
    })
    console.log('ok   [' + probe.shape + '] ' + probe.id + ' · ' + decision.verdict +
      ' · tokenLen=' + b3.tokenLength + ' longestRun=' + b3.longestRun +
      ' · baseline=' + baseline.links.length + ' current=' + current.links.length)
    // B3 例外必须可复算：同输入再跑一遍，区间集合必须一致。
    const rerunBaseline = capture(baselineLinkify, probe.text).links
    const rerunCurrent = capture(currentLinkify, probe.text).links
    if (JSON.stringify(rerunBaseline) !== JSON.stringify(baseline.links)
      || JSON.stringify(rerunCurrent) !== JSON.stringify(current.links)) {
      fail(probe.id, 'B3 例外不可复算：两次运行区间集合不一致')
    }
  }
}

interface RealCorpusSummary {
  files: number
  bytes: number
  skippedLarge: number
  skippedUnreadable: number
  truncated: boolean
  diffFiles: number
  baselineOnlyFiles: number
  currentOnlyFiles: number
  b3Files: number
  unexplainedFiles: number
  overBudgetFiles: number
}

/** 真实语料只读模式（信息性）。输出只含路径、计数与哈希，不打印原文。 */
async function runRealCorpus(dir: string, limit: number): Promise<RealCorpusSummary> {
  const scan = await scanRealCorpus(dir, limit > 0 ? { maxFiles: limit } : {})
  const summary: RealCorpusSummary = {
    files: scan.files.length,
    bytes: scan.totalBytes,
    skippedLarge: scan.skippedLarge,
    skippedUnreadable: scan.skippedUnreadable,
    truncated: scan.truncated,
    diffFiles: 0,
    baselineOnlyFiles: 0,
    currentOnlyFiles: 0,
    b3Files: 0,
    unexplainedFiles: 0,
    overBudgetFiles: 0,
  }
  console.log('')
  console.log('真实语料只读模式（信息性，不参与门禁）：root=' + dir)
  console.log('  文件=' + summary.files + ' 字节=' + summary.bytes +
    ' 跳过(超限)=' + summary.skippedLarge + ' 跳过(不可读)=' + summary.skippedUnreadable +
    ' 截断=' + summary.truncated)
  const samples: string[] = []
  for (const file of scan.files) {
    if (file.text.includes(NUL)) continue
    const baseline = capture(baselineLinkify, file.text)
    const current = capture(currentLinkify, file.text)
    if (baseline.ms > BUDGET_MS || current.ms > BUDGET_MS) summary.overBudgetFiles += 1
    if (JSON.stringify(baseline.links) === JSON.stringify(current.links)) continue
    summary.diffFiles += 1
    const diff = diffLinks(baseline.links, current.links)
    if (diff.baselineOnly.length > 0) summary.baselineOnlyFiles += 1
    if (diff.currentOnly.length > 0) summary.currentOnlyFiles += 1
    const decision = evaluateDiff(file.text, diff, 'B3', true)
    if (decision.allowed) summary.b3Files += 1
    else summary.unexplainedFiles += 1
    if (samples.length < 5) {
      samples.push(
        file.path + ' sha256=' + file.sha256.slice(0, 16) +
        ' baseline=' + baseline.links.length + ' current=' + current.links.length +
        ' baselineOnly=' + diff.baselineOnly.length + ' currentOnly=' + diff.currentOnly.length +
        ' b3=' + decision.allowed,
      )
    }
  }
  console.log('  差异文件=' + summary.diffFiles + '（基线多=' + summary.baselineOnlyFiles +
    '，现实现多=' + summary.currentOnlyFiles + '，其中 B3 可解释=' + summary.b3Files +
    '，非 B3=' + summary.unexplainedFiles + '） 超预算文件=' + summary.overBudgetFiles)
  if (samples.length > 0) {
    console.log('  样例（路径+哈希）：')
    for (const sample of samples) console.log('    ' + sample)
  }
  return summary
}

/** 解析 --corpus/--corpus-dir、--probe-extended、--limit。 */
function parseArgs(argv: string[]): { corpusDir: string | undefined; probeExtended: boolean; strictProbes: boolean; limit: number } {
  let corpusDir: string | undefined
  let probeExtended = false
  let strictProbes = false
  let limit = 0
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--corpus' || arg === '--corpus-dir') {
      corpusDir = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--probe-extended') {
      probeExtended = true
      continue
    }
    if (arg === '--strict-probes') {
      strictProbes = true
      continue
    }
    if (arg === '--limit') {
      limit = Number(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('用法: verify-perf-filelink-differential.ts [--corpus <目录>] [--probe-extended] [--strict-probes] [--limit <文件数>]')
      process.exit(0)
    }
    throw new Error('未知参数: ' + arg)
  }
  return { corpusDir, probeExtended, strictProbes, limit }
}

function printFirstDiff(): void {
  if (firstDiff === undefined) {
    console.log('')
    console.log('首个差异：无')
    return
  }
  const candidate = firstDiff
  console.log('')
  console.log('首个差异：')
  console.log('  case=' + candidate.id + ' shape=' + candidate.shape + ' 判定=' + candidate.verdict)
  console.log('  input: length=' + candidate.text.length + ' sha256=' + sha256(candidate.text))
  console.log('  input(截断)=' + preview(candidate.text))
  console.log('  baseline: links=' + candidate.baseline.length + ' ' +
    JSON.stringify(candidate.baseline.slice(0, 3)))
  console.log('  current:  links=' + candidate.current.length + ' ' +
    JSON.stringify(candidate.current.slice(0, 3)))
  console.log('  baselineOnly=' + candidate.diff.baselineOnly.length +
    ' currentOnly=' + candidate.diff.currentOnly.length)
}

function printB3Samples(): void {
  console.log('')
  console.log('B3 反向新增例外：' + b3Count + ' 例（全部可复算）')
  for (const sample of b3Samples) {
    console.log('  - ' + sample.source + ':' + sample.id + ' shape=' + sample.shape +
      ' tokenLen=' + sample.tokenLength + ' longestRun=' + sample.longestRun +
      ' baseline=' + sample.baselineLinks + ' current=' + sample.currentLinks +
      ' 判据=' + sample.reason)
    console.log('    input=' + preview(sample.text, 320) + ' sha256=' + sha256(sample.text))
    console.log('    新增链接=' + JSON.stringify(sample.newSpans.slice(0, 3)) +
      ' baseline链接数=' + sample.baselineLinks + ' current链接数=' + sample.currentLinks)
  }
}

function printShapeStats(): void {
  console.log('')
  console.log('按形态统计：')
  for (const [shape, stat] of [...shapeStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log('  ' + shape + ': 用例=' + stat.cases +
      ' 差异=' + stat.diffs + ' 允许=' + stat.allowed + ' 失败=' + stat.failed)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  allowB3 = !options.strictProbes
  console.log('T1 链接正则差分')
  console.log('  参考实现：scripts/lib/filelink-baseline.ts（来源 ' + BASELINE_COMMIT.slice(0, 12) + ':' + BASELINE_SOURCE + '）')
  console.log('  现实现：src/utils/fileTarget.ts')
  console.log('  白名单：B1/B2（基线有、现实现无）；B3（反向例外）' + (allowB3 ? ' 启用' : ' 禁用（--strict-probes）'))
  runSynthetic()
  if (options.probeExtended) runExtendedProbes(options.strictProbes)
  let realCorpusSummary: RealCorpusSummary | undefined
  if (options.corpusDir !== undefined) {
    realCorpusSummary = await runRealCorpus(options.corpusDir, options.limit)
  } else {
    console.log('')
    console.log('真实语料只读模式：未运行（未提供 --corpus <目录>）')
  }
  printShapeStats()
  printFirstDiff()
  printB3Samples()
  console.log('')
  console.log('用例数=' + SYNTHETIC_CORPUS.length +
    ' 差异数=' + diffCount + ' 允许差异=' + allowedCount + ' B3例外=' + b3Count + ' 失败=' + failures)
  console.log('耗时：合计=' + totalCaseMs.toFixed(1) + ' ms' +
    ' 单条最大（基线=' + maxBaselineMs.toFixed(1) + ' ms / 现实现=' + maxCurrentMs.toFixed(1) + ' ms）' +
    ' 预算=' + BUDGET_MS + ' ms')
  if (realCorpusSummary !== undefined) {
    console.log('真实语料：文件=' + realCorpusSummary.files +
      ' 差异文件=' + realCorpusSummary.diffFiles + '（信息性，不参与门禁）')
  }
  process.exit(failures > 0 ? 1 : 0)
}

await main()
