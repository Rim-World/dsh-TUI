/**
 * T1 链接正则差分：合成语料 + 真实语料只读扫描器。
 *
 * 合成语料覆盖 004-M T1 节与 003-G WP1 要求的目标形态：相对路径（正/反斜杠）、
 * 盘符、UNC、file:// URL、行内代码/围栏代码块/已有链接/引号/括号/反引号包裹、
 * 中英混排、CJK 全角标点、emoji/组合字符/零宽字符、200/201 字符边界、无分隔符
 * 长串、单分隔符 + 超长无空白尾部（S4）、多分隔符、无空白长串、裸扩展名、
 * and/or 一类非路径文本、日期、URL 等。
 *
 * 白名单登记（附录 B）：
 * - whitelist B1：>200 字符且不含空白与分隔符的单个 token；基线在极端输入下
 *   会回溯超时，现实现有快速返回。允许差异方向只限「基线有、现实现无」。
 * - whitelist B2：单分隔符加超长无空白尾部（S4 类）；现实现的快速返回会把整段
 *   原样返回，基线可能在偏移 0 处链接一段候选。
 * - whitelist B3：反向例外（现实现有、基线无）。只允许差异所在 token 长度 >=200
 *   且 token 内无空白，或 token 内存在 >=100 个连续相同字符（回溯敏感形态）；
 *   每条例外必须可复算。不满足条件的反向差异仍失败。
 *
 * referenceSkip=slow 标记 B1 的 100k 无分隔符输入：基线正则实测为平方级
 * （20k 已约 0.6 s），执行会超过计划判据的 5 s/条预算；该条只跑现实现并断言
 * 「原样返回、不产生链接」，基线行为由 20k 缩放用例覆盖。
 *
 * 真实语料模式：scanRealCorpus(dir) 只读扫描 .md/.ts，返回内存中的文本与哈希；
 * 调用方（verify 脚本）只输出计数、路径与哈希，不落盘原文。
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

/** 反斜杠：避免生成文件里出现转义歧义。 */
const BS = String.fromCharCode(92)
/** 反引号：行内代码与围栏文本用。 */
const BT = String.fromCharCode(96)
/** 换行：围栏代码块文本用。 */
const LF = String.fromCharCode(10)

export type WhitelistRule = 'B1' | 'B2' | 'B3'

export interface FilelinkCase {
  /** 稳定 id，用于日志定位；不参与行为判断。 */
  readonly id: string
  /** 形态分组，用于按形态统计。 */
  readonly shape: string
  readonly text: string
  /** 附录 B 规则；登记后只允许「基线有、现实现无」的差异。 */
  readonly whitelist?: WhitelistRule
  /** 基线参考实现已知平方级、超过单条 5 s 预算，不执行基线侧。 */
  readonly referenceSkip?: 'slow'
  readonly note?: string
}

export interface ExtendedProbeCase {
  readonly id: string
  readonly shape: string
  readonly text: string
  readonly note: string
}

const REPEAT = (unit: string, times: number): string => unit.repeat(times)

/** 构造指定长度的合法路径 token（src/ + a 填充 + .ts）。 */
function pathToken(totalLength: number): string {
  const head = 'src/'
  const tail = '.ts'
  const fill = totalLength - head.length - tail.length
  if (fill < 4) throw new Error('pathToken 长度不足: ' + totalLength)
  return head + REPEAT('a', fill) + tail
}

const boundary200 = pathToken(200)
const boundary201 = pathToken(201)
const anchored200 = '/' + REPEAT('b', 196) + '.ts'
const anchored201 = '/' + REPEAT('b', 197) + '.ts'

/** S4：单分隔符 + 超长无空白尾部（无扩展名，基线与现实现都不应链接）。 */
const s4Anchored100k = '/' + REPEAT('c', 99_998) + '.ts'
const s4Tail1k = 'a/' + REPEAT('e', 1_000)
const s4TailEmbedded = 'see ' + 'a/' + REPEAT('f', 100_000)

/** B2 样本：单分隔符 + 超长尾部，基线在偏移 0 处把前缀链成候选。 */
const b2LeadingPath = 'src/file.ts' + REPEAT('g', 250)
const b2ParenLeading = '(' + 'src/a.ts' + REPEAT('h', 250)

/** A7/004-E 反例的修订版回归：208 字符单 token，快速返回后两侧都不链接。 */
const a7Standalone = '/' + REPEAT('i', 199) + '=' + '/x/y.ts'

/** B1：无分隔符长串。20k 参与差分；100k 只跑现实现。 */
const b1Token20k = REPEAT('j', 20_000)
const b1Token100k = REPEAT('k', 100_000)

export function buildSyntheticCorpus(): FilelinkCase[] {
  const cases: FilelinkCase[] = []
  const add = (id: string, shape: string, text: string, extra: Partial<FilelinkCase> = {}): void => {
    cases.push({ id, shape, text, ...extra })
  }

  // ── 相对路径、多分隔符、句尾标点 ──────────────────────────────────
  add('rel-basic', '相对路径', 'see src/utils/fileTarget.ts for details')
  add('rel-dot', '相对路径', 'run ./scripts/verify-scroll.mjs now')
  add('rel-dotdot', '相对路径', 'open ../docs/contributing.md first')
  add('rel-multi-sep', '多分隔符', 'diff a/b/c/d/e.ts and one/two/three/four/five/six.md')
  add('rel-trailing-punct', '句尾标点', 'look at src/a.ts. Then ./b.ts, done; (c/d.ts)!')
  add('rel-assignment', '边界字符', 'path=src/a.ts next')

  // ── Windows 反斜杠、盘符、UNC ─────────────────────────────────────
  add('win-drive-backslash', '盘符路径', 'C:' + BS + 'Users' + BS + 'test' + BS + 'file.ts opened')
  add('win-backslash-relative', 'Windows 反斜杠', 'src' + BS + 'utils' + BS + 'fileTarget.ts')
  add('win-unc-backslash', 'UNC 路径', BS + BS + 'server' + BS + 'share' + BS + 'dir' + BS + 'file.ts')
  add('win-unc-slash', 'UNC 路径', '//server/share/dir/file.ts')
  add('win-drive-slash', '盘符路径', 'C:/Users/a/b.ts')
  add('win-drive-d', '盘符路径', 'D:' + BS + 'work' + BS + 'x.ts done')

  // ── URL / file:// ─────────────────────────────────────────────────
  add('url-https', 'URL', 'https://example.com/a.ts')
  add('url-http-port', 'URL', 'http://localhost:3000/api/v1/x.json')
  add('url-www', 'URL', 'www.example.com/foo/bar.ts')
  add('url-email', 'URL', 'git@github.com:owner/repo.git')
  add('url-file', 'file URL', 'file:///C:/Users/a/b.ts')
  add('url-file-host', 'file URL', 'file://server/share/a.ts')

  // ── Markdown 包裹形态 ─────────────────────────────────────────────
  add('md-inline-code', '行内代码', 'run ' + BT + 'src/a.ts' + BT + ' now')
  add('md-inline-code-dot', '行内代码', 'then ' + BT + './scripts/x.mjs' + BT + ' after')
  add('md-fence-ts', '围栏代码块', BT + BT + BT + 'ts' + LF + "const p = 'src/a.ts'" + LF + BT + BT + BT)
  add('md-fence-win', '围栏代码块', BT + BT + BT + LF + 'C:/Users/a/b.ts' + LF + BT + BT + BT)
  add('md-existing-link', '已有链接', '[label](src/a.ts)')
  add('md-existing-image', '已有链接', '![img](assets/pic.png)')
  add('md-existing-url', '已有链接', '[x](https://example.com/a.ts)')
  add('md-quoted-double', '引号包裹', '"src/a.ts"')
  add('md-quoted-single', '引号包裹', "'./b.ts'")
  add('md-quoted-windows', '引号包裹', '"C:' + BS + 'Program Files' + BS + 'app' + BS + 'x.exe"')
  add('md-paren', '括号包裹', '(src/a.ts)')
  add('md-bracket', '括号包裹', '[src/a.ts]')
  add('md-brace', '括号包裹', '{src/a.ts}')
  add('md-backtick', '反引号包裹', BT + 'src/a.ts' + BT)

  // ── 中英混排、CJK、全角标点、emoji、组合字符、零宽字符 ──────────────
  add('cjk-mixed', '中英混排', '中文 路径：src/a.ts 结束')
  add('cjk-path', '中英混排', '见 C:/项目/文件.ts 与 ./脚本/运行.mjs')
  add('cjk-fullwidth', '全角标点', '全角括号（src/a.ts）与引号「./b.ts」')
  add('cjk-space-mix', 'CJK 与空格混合', '文件 C:/Users/用户/文档.md 打开')
  add('emoji', 'emoji', '🚀 src/a.ts ✅ done')
  add('combining', '组合字符', 'e' + String.fromCharCode(769) + '(src/a.ts) and ' + BT + './b.ts' + BT)
  add('zero-width', '零宽字符', 'src/' + String.fromCharCode(8203) + '/a.ts and 路径' + String.fromCharCode(8203) + '：src/a.ts')
  add('zero-width-external', '零宽字符', 'src/a.ts' + String.fromCharCode(8203) + 'next')

  // ── 200/201 字符边界 ─────────────────────────────────────────────
  add('boundary-200', '200/201 边界', boundary200)
  add('boundary-201', '200/201 边界', boundary201)
  add('boundary-anchored-200', '200/201 边界', anchored200)
  add('boundary-anchored-201', '200/201 边界', anchored201)
  add('boundary-inline-201', '200/201 边界', 'see ' + boundary201 + ' end')

  // ── 无分隔符长串（B1） ────────────────────────────────────────────
  add('b1-token-20k', '无分隔符长串', b1Token20k, { whitelist: 'B1', note: '差分缩放样本；基线约 0.6 s' })
  add('b1-token-100k', '无分隔符长串', b1Token100k, { whitelist: 'B1', referenceSkip: 'slow', note: '基线平方级，超过 5 s/条预算；只跑现实现并断言原样返回' })
  add('b1-token-201', '无分隔符长串', REPEAT('l', 201))
  add('b1-token-inline', '无分隔符长串', 'prefix ' + b1Token20k + ' suffix', { whitelist: 'B1' })

  // ── S4：单分隔符 + 超长无空白尾部（B2） ───────────────────────────
  add('s4-anchored-100k', 'S4 单分隔符长尾', s4Anchored100k)
  add('s4-tail-1k', 'S4 单分隔符长尾', s4Tail1k)
  add('s4-tail-embedded', 'S4 单分隔符长尾', s4TailEmbedded)
  add('b2-leading-path', 'S4 单分隔符长尾', b2LeadingPath, { whitelist: 'B2' })
  add('b2-paren-leading', 'S4 单分隔符长尾', b2ParenLeading, { whitelist: 'B2' })
  add('b3-embedded-boundary-path', 'B3 反向新增', 'see ' + '/' + REPEAT('a', 199) + '=' + '/x/y.ts', { whitelist: 'B3', note: '预期：基线 0 / 现实现 1；token 长 208、最长连续字符 199' })

  // ── 无空白长串（有分隔符，>200）与 A7 修订版回归 ──────────────────
  add('long-nosep-sep', '无空白长串', 'src/' + REPEAT('m', 250))
  add('long-nosep-sep-ext', '无空白长串', 'src/' + REPEAT('n', 250) + '.ts')
  add('a7-revised-standalone', 'A7 修订版回归', a7Standalone)

  // ── 裸扩展名、and/or、日期 ────────────────────────────────────────
  add('ext-bare', '裸扩展名词', 'README.md package.json config.yaml LICENSE')
  add('ext-bare-slash', '裸扩展名词', 'src/README.md')
  add('and-or', 'and/or 非路径', 'and/or yes/no working/idle/needs-input TCP/IP')
  add('date-slash', '日期', 'dates 2024/01/15 and 15/01/2024')
  add('date-dash', '日期', 'date 2024-01-15')

  // ── 混合文本 ─────────────────────────────────────────────────────
  add('mixed-multi', '混合文本', '多路径 src/a.ts, src/b.ts; C:' + BS + 'x' + BS + 'y.ts 与 https://e.com/z.ts')
  add('mixed-apply', '混合文本', 'git apply 后见 src/a.ts 或文末 ./b.ts。')
  return cases
}

export const SYNTHETIC_CORPUS: readonly FilelinkCase[] = buildSyntheticCorpus()

/**
 * B3 反向探测（--probe-extended）：004-E 7.1 节 A7 记录过「>200 字符 token 内新增
 * 链接」的反向差异；修订版补丁的整段快速返回只在「整段文本无空白/边界字符」时
 * 生效。以下样本把长 token 放进含空白的文本里，预期命中附录 B3，用于提供可复算
 * 证据；--strict-probes 时 B3 被禁用，这些差异必须失败。
 */
export const EXTENDED_PROBES: readonly ExtendedProbeCase[] = [
  {
    id: 'probe-embedded-boundary-path',
    shape: '扩展：长 token 内新增链接',
    text: 'see ' + '/' + REPEAT('o', 199) + '=' + '/x/y.ts',
    note: '文本含空格，快速返回不生效；现实现有界正则可能链接等号之后的短路径',
  },
  {
    id: 'probe-embedded-two-paths',
    shape: '扩展：长 token 内新增链接',
    text: 'x ' + '/' + REPEAT('p', 199) + '(' + '/p/q.ts',
    note: '同上的括号边界变体',
  },
  {
    id: 'probe-embedded-newline',
    shape: '扩展：长 token 内新增链接',
    text: '/' + REPEAT('q', 199) + '=' + '/x/y.ts' + LF + 'next src/a.ts',
    note: '长 token 后接真实路径；两侧链接数不同',
  },
]

// ── 真实语料只读模式 ─────────────────────────────────────────────

export interface RealCorpusOptions {
  /** 解析扩展名，默认 .md/.ts（2026-11-03 Lead 指定）。 */
  readonly extensions?: readonly string[]
  /** 最多读取的文件数，默认 300；超出记为 truncated。 */
  readonly maxFiles?: number
  /** 单文件字节上限，默认 512 KiB；超出计数并跳过。 */
  readonly maxFileBytes?: number
  /** 跳过的目录名，默认 node_modules/.git/lib/dist/coverage/.cache。 */
  readonly skipDirs?: readonly string[]
}

export interface RealCorpusFile {
  /** 相对 root 的路径（正斜杠）。 */
  readonly path: string
  readonly bytes: number
  /** 原始字节的 SHA-256（十六进制）。 */
  readonly sha256: string
  readonly text: string
}

export interface RealCorpusScan {
  readonly root: string
  readonly files: readonly RealCorpusFile[]
  readonly skippedLarge: number
  readonly skippedUnreadable: number
  readonly totalBytes: number
  readonly truncated: boolean
}

const DEFAULT_EXTENSIONS = ['.md', '.ts'] as const
const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'lib', 'dist', 'coverage', '.cache'] as const

const toPosix = (value: string): string => value.split(sep).join('/')

interface WalkState {
  files: RealCorpusFile[]
  skippedLarge: number
  skippedUnreadable: number
  totalBytes: number
  truncated: boolean
}

async function walk(
  root: string,
  dir: string,
  extensions: ReadonlySet<string>,
  options: { maxFiles: number; maxFileBytes: number; skipDirs: ReadonlySet<string> },
  state: WalkState,
): Promise<void> {
  if (state.truncated) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    state.skippedUnreadable += 1
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (state.truncated) return
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (options.skipDirs.has(entry.name)) continue
      await walk(root, absolute, extensions, options, state)
      continue
    }
    if (!entry.isFile()) continue
    if (!extensions.has(extname(entry.name).toLowerCase())) continue
    let buffer: Buffer
    try {
      buffer = await readFile(absolute)
    } catch {
      state.skippedUnreadable += 1
      continue
    }
    if (buffer.byteLength > options.maxFileBytes) {
      state.skippedLarge += 1
      continue
    }
    if (state.files.length >= options.maxFiles) {
      state.truncated = true
      return
    }
    state.files.push({
      path: toPosix(relative(root, absolute)),
      bytes: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      text: buffer.toString('utf8'),
    })
    state.totalBytes += buffer.byteLength
  }
}

/** 只读扫描 root 下的 .md/.ts；不写任何文件。 */
export async function scanRealCorpus(root: string, options: RealCorpusOptions = {}): Promise<RealCorpusScan> {
  const extensions = new Set((options.extensions ?? DEFAULT_EXTENSIONS).map(value => value.toLowerCase()))
  const state: WalkState = { files: [], skippedLarge: 0, skippedUnreadable: 0, totalBytes: 0, truncated: false }
  await walk(
    root,
    root,
    extensions,
    {
      maxFiles: options.maxFiles ?? 300,
      maxFileBytes: options.maxFileBytes ?? 512 * 1024,
      skipDirs: new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS),
    },
    state,
  )
  return { root, ...state }
}
