/**
 * T1 链接正则差分：基线参考实现（只读测试夹具，不进入生产代码）。
 *
 * 来源：`9.SRC/dsh-TUI` 的基线提交 `0359e6f56f68f56e6eed4747813fd6ac76e9d9a2`
 * （v0.18.0，上游原样）中的 `src/utils/fileTarget.ts`。
 * 取法：`git show 0359e6f5:src/utils/fileTarget.ts`。
 *
 * 本文件只搬运与链接识别相关的代码：`FILE_EXTENSION_RE`、`PATH_ANCHOR_RE`、
 * `NON_EXTENSION_TAILS`、`hasPlausibleExtension`、`looksLikeFilePath`、
 * `PATH_SPAN_RE`、`linkifyFilePaths`。代码与注释按基线原文逐字复制，
 * 不包含性能优化（基线正则的两个无界 `*` 原样保留）。
 *
 * 仅供 `scripts/verify-perf-filelink-differential.ts` 做差分对照。生产代码
 * 永远使用 `src/utils/fileTarget.ts`。若基线代码变更，必须重新 `git show`
 * 核对，不得凭记忆修改本文件。
 */

/** 基线提交与来源文件：用于日志与漂移核对。 */
export const BASELINE_COMMIT = '0359e6f56f68f56e6eed4747813fd6ac76e9d9a2'
export const BASELINE_SOURCE = 'src/utils/fileTarget.ts'

/** Known source/config/data file extensions — the conservative allowlist. */
const FILE_EXTENSION_RE = /\.([A-Za-z0-9]{1,6})$/u

/** A path is worth linking when it carries one of these anchors, or has a
 *  known-extension tail. */
const PATH_ANCHOR_RE = /^(\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/u

/** Stoplist for extension-like tails that are TLDs / prose words, not
 *  file extensions (`github.com/foo` must not link as a file). */
const NON_EXTENSION_TAILS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'edu', 'gov', 'mil', 'co', 'uk', 'cn',
])

/** A dot-suffix of up to 6 alphanumerics is a plausible extension when at
 *  least 4 chars precede it (`a/b.x`-style prose fragments and short
 *  `x/y.ts` guesses must not false-positive). */
function hasPlausibleExtension(stripped: string): boolean {
  const extMatch = FILE_EXTENSION_RE.exec(stripped)
  if (extMatch === null) return false
  const ext = extMatch[1]!.toLowerCase()
  if (NON_EXTENSION_TAILS.has(ext)) return false
  return stripped.slice(0, extMatch.index).length >= 4
}

/**
 * Conservative heuristic: does this text look like a file path worth
 * making clickable? Requires a slash separator, no whitespace, no URL/email
 * shape, and either a path anchor (`./`, `../`, `/`, `~/`, drive letter)
 * with a real path shape (another separator or an extension — a bare
 * anchored word like `/a` or `x.com/a` is too ambiguous), or a plausible
 * file extension. Length-capped so huge tokens (base64, logs) never get
 * linked.
 */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (t.length < 2 || t.length > 200) return false
  if (!t.includes('/') && !t.includes('\\')) return false
  if (/\s/u.test(t)) return false
  if (/[<>"'`|?*]/.test(t)) return false
  // URLs (any scheme://, incl. file://) and emails are handled by their
  // own linkifiers.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(t) || /^www\./iu.test(t)) return false
  if (t.includes('@')) return false
  if (/[#\u0000-\u001f]/u.test(t)) return false

  // Strip one layer of trailing punctuation so "foo/bar.ts." still links.
  const stripped = t.replace(/[.,;:!?]+$/u, '')
  if (stripped === '') return false
  const separators = (stripped.match(/[\\/]/gu) ?? []).length
  if (PATH_ANCHOR_RE.test(stripped)) {
    return separators >= 2 || hasPlausibleExtension(stripped)
  }
  return hasPlausibleExtension(stripped)
}

/**
 * Candidate-span scanner: anchored paths (`./`, `../`, `/`, `~/`, drive)
 * run to the end of the word; everything else must contain a slash AND a
 * dot-extension tail. This is only a pre-filter — every span is then
 * verified by `looksLikeFilePath` before it becomes clickable.
 */
const PATH_SPAN_RE =
  /(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s<>"'`|?#]*|(?:[^\s<>"'`|?#]*[\\/][^\s<>"'`|?#]*\.[A-Za-z0-9]{1,6})/gu

/**
 * Replace every path-looking span in `text` via `wrap(path, display)`.
 * Trailing sentence punctuation stays OUTSIDE the wrapped display (so
 * "src/foo.ts." links `src/foo.ts` and keeps the period). Spans that fail
 * `looksLikeFilePath` are returned unchanged.
 * @param text - plain text to scan (no ANSI).
 * @param wrap - builds the clickable rendering for one path.
 */
export function linkifyFilePaths(
  text: string,
  wrap: (path: string, display: string) => string,
): string {
  return text.replace(PATH_SPAN_RE, (match, offset, full) => {
    // A candidate must start at a text boundary, not inside another token:
    // `/idle/needs-input` in `working/idle/needs-input` otherwise looks like
    // an absolute path (#1181). Colons and slashes are not boundaries, so
    // URL interiors stay excluded too. Quotes/opening delimiters and `=`
    // still allow standalone anchored paths in prose and assignments.
    if (offset > 0 && !/[\s<>"'`|([{=]/u.test(full[offset - 1]!)) return match
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) return match
    return wrap(display, display) + match.slice(display.length)
  })
}
