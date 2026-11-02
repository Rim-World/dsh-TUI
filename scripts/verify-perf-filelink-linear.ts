/**
 * #1839 性能回归：文件路径链接扫描线性化。
 *
 * 覆盖三类输入：
 * 1. 无分隔符长 token（base64 / minified JS）：快速返回，必须不产生链接。
 * 2. 单分隔符 + 超长无空白尾部（S4 类）：有界量词会逐 200 字符重扫，
 *    修订版补丁用「单 token 超 200 字符」快速返回保持线性。
 * 3. 长文本里的普通路径：语义不得改变，链接数量必须正确。
 *
 * 主断言用「不产生链接 + 绝对耗时上限 + 长度 2× 时耗时不超 4×」；
 * 绝对阈值故意放宽，避免慢机器抖动。语义用旧正则实现做差分对照。
 *
 * Run: node --import tsx/esm scripts/verify-perf-filelink-linear.ts
 */

const { linkifyFilePaths, looksLikeFilePath } = await import('../src/utils/fileTarget.js')

let checks = 0
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ': ' + detail}`)
}
const wrap = (path: string, display: string): string => `[[${display}]]`
const countLinks = (out: string): number => (out.match(/\[\[/g) ?? []).length

// 旧实现（#1839 补丁前）只用于差分：两个无界 *，无快速返回。
const OLD_PATH_SPAN_RE =
  /(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s<>"'\u0060|?#]*|(?:[^\s<>"'\u0060|?#]*[\\/][^\s<>"'\u0060|?#]*\.[A-Za-z0-9]{1,6})/gu
function oldLinkify(text: string, out: (path: string, display: string) => string): string {
  return text.replace(OLD_PATH_SPAN_RE, (match: string, offset: number, full: string) => {
    if (offset > 0 && !/[\s<>"'\u0060|([{=]/u.test(full[offset - 1]!)) return match
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) return match
    return out(display, display) + match.slice(display.length)
  })
}
function linkSet(fn: (text: string, out: (path: string, display: string) => string) => string, text: string): string[] {
  return [...fn(text, wrap).matchAll(/\[\[([^\]]+)\]\]/g)].map(match => match[1]!)
}

function timed(fn: () => string): { ms: number; out: string } {
  const start = performance.now()
  const out = fn()
  return { ms: performance.now() - start, out }
}

// --- 1. 快速返回类输入 ----------------------------------------------------
const fastCases = [
  { name: '100k 无分隔符串', text: 'a'.repeat(100_000), limitMs: 100 },
  { name: '20k 无分隔符串', text: 'b'.repeat(20_000), limitMs: 50 },
  { name: 'S4：/ + 100k 无空白尾部', text: '/' + 'c'.repeat(100_000), limitMs: 50 },
  { name: 'S4：./ + 100k 无空白尾部', text: './' + 'd'.repeat(100_000), limitMs: 50 },
  { name: 'S4：a/ + 100k 无空白尾部', text: 'a/' + 'e'.repeat(100_000), limitMs: 50 },
]
for (const testCase of fastCases) {
  const first = timed(() => linkifyFilePaths(testCase.text, wrap))
  const second = timed(() => linkifyFilePaths(testCase.text, wrap))
  check(`${testCase.name}：不产生链接`, countLinks(first.out) === 0, String(countLinks(first.out)))
  check(
    `${testCase.name}：耗时 ≤ ${testCase.limitMs} ms（两次：${first.ms.toFixed(2)} / ${second.ms.toFixed(2)}）`,
    Math.min(first.ms, second.ms) <= testCase.limitMs,
  )
}

// 长度 2× 时耗时不超 4×（近线性；只对快速返回路径断言）。
{
  const short = timed(() => linkifyFilePaths('/' + 'f'.repeat(50_000), wrap)).ms
  const long = timed(() => linkifyFilePaths('/' + 'f'.repeat(100_000), wrap)).ms
  check(
    `S4 类耗时近线性（50k=${short.toFixed(2)} ms，100k=${long.toFixed(2)} ms）`,
    long <= Math.max(short * 4, 5),
  )
}

// --- 2. 含大量分隔符的长串：允许慢，但必须可完成且不产生链接 ----------------
{
  const text = '/'.repeat(20_000)
  const result = timed(() => linkifyFilePaths(text, wrap))
  check(`20k 连续斜杠不产生链接（耗时 ${result.ms.toFixed(1)} ms）`, countLinks(result.out) === 0)
  check('20k 连续斜杠耗时 ≤ 2000 ms', result.ms <= 2000, result.ms.toFixed(1))
}

// --- 3. 语义差分：普通输入旧/新实现链接集合一致 --------------------------
const corpus = [
  'see src/utils/fileTarget.ts',
  'see ./scripts/verify-scroll.mjs and ../docs/contributing.md',
  'absolute /home/user/project/a.ts here',
  'windows C:\\Users\\test\\file.ts here',
  'tilde ~/project/file.ts here',
  'URL https://example.com/a.ts stays',
  'prose working/idle/needs-input stays',
  'dates 2024/01/15 stay',
  '中文 工作/空闲/等待输入 stays',
  'trailing src/a.ts. punctuation',
  'assignment path=src/a.ts',
  'paren (src/a.ts) wrapped',
  'multi src/a.ts, src/b.ts; done',
  'empty slash / alone',
  'bare x.com/a ambiguous',
]
for (const text of corpus) {
  const expected = linkSet(oldLinkify, text)
  const actual = linkSet(linkifyFilePaths, text)
  check(
    `语义差分：${text.slice(0, 38)}`,
    JSON.stringify(actual) === JSON.stringify(expected),
    `new=${JSON.stringify(actual)} old=${JSON.stringify(expected)}`,
  )
}
// >200 字符 token：旧实现会把 token 中间也扫成候选，新实现直接跳过。
{
  const longToken = 'a/'.repeat(150) + 'file.ts' // 300+ 字符，单 token
  check('>200 字符 token 不产生链接', countLinks(linkifyFilePaths(longToken, wrap)) === 0)
  check(`>200 字符 token 后的真实路径仍链接`, countLinks(linkifyFilePaths(longToken + ' src/a.ts', wrap)) === 1)
}

// --- 4. 多路径长文本：链接数量与耗时 --------------------------------------
{
  const text = ('see src/a.ts. ').repeat(500)
  const result = timed(() => linkifyFilePaths(text, wrap))
  check('500 个重复路径全部链接', countLinks(result.out) === 500, String(countLinks(result.out)))
  check(`500 个重复路径耗时 ≤ 1000 ms（${result.ms.toFixed(1)} ms）`, result.ms <= 1000)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
