#!/usr/bin/env node
/**
 * fault-loader — T4 故障注入器（WP6 惰性启动回归）。
 *
 * 用 `node:module` 的 `register()` 装一组进程级 ESM 钩子，在解析（resolve）或
 * 加载（load）阶段让指定模块失败。只影响被注入的子进程：由 `node --import
 * ./scripts/lib/fault-loader.mjs <child>` 装入，父进程不经过它。
 *
 * 环境变量：
 * - `DSH_TUI_FAULT`：故障清单，两种写法等价：
 *     JSON：`[{"mode":"missing","specifier":"@deepseek-ai/dsh-user-questions"}]`
 *     紧凑：`missing:@deepseek-ai/dsh-user-questions,throw:./session-list-metadata.js`
 *   `missing` 在 resolve 阶段抛错（等效模块缺失，code=ERR_MODULE_NOT_FOUND）；
 *   `throw` 在 load 阶段抛错（解析成功、加载失败）。说明符匹配规则：
 *     1. 裸说明符与 target 完全相等；或
 *     2. 解析后的 file URL 以 target 的路径后缀结尾（target 以 `./` 开头时用
 *        该写法注入相对导入，例如 `./session-list-metadata.js`）。
 * - `DSH_TUI_FAULT_RECORD`：可选 JSONL 路径。钩子把每个已加载的 `file:` 模块
 *   首次出现写成 `{"url","at"}`（`at` 为 epoch ms，可与 boot trace 的 `at` 对齐），
 *   供回归断言「模块是否在首帧前加载」与统计加载数。
 *
 * 两个环境变量都未设置时本模块不做任何事。导出 `parseFaultList` /
 * `installFaultLoader` 供脚本在显式设置 env 后自行安装。
 */
import { register } from 'node:module'

/**
 * 解析故障清单。坏输入抛错而不是静默跳过：故障注入器失效会让回归变成假绿。
 * @param {string | undefined} raw
 * @returns {{ mode: 'missing' | 'throw', specifier: string }[]}
 */
export function parseFaultList(raw) {
  if (raw === undefined || raw.trim() === '') return []
  const text = raw.trim()
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('DSH_TUI_FAULT: JSON 必须是数组')
    return parsed.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') throw new Error(`DSH_TUI_FAULT[${index}]: 必须是对象`)
      const mode = entry.mode
      const specifier = entry.specifier
      if (mode !== 'missing' && mode !== 'throw') throw new Error(`DSH_TUI_FAULT[${index}]: mode 只能是 missing 或 throw`)
      if (typeof specifier !== 'string' || specifier === '') throw new Error(`DSH_TUI_FAULT[${index}]: specifier 必须是非空字符串`)
      return { mode, specifier }
    })
  }
  return text.split(',').map((part, index) => {
    const colon = part.indexOf(':')
    if (colon <= 0) throw new Error(`DSH_TUI_FAULT[${index}]: 期望 mode:specifier，得到 ${JSON.stringify(part)}`)
    const mode = part.slice(0, colon).trim()
    const specifier = part.slice(colon + 1).trim()
    if (mode !== 'missing' && mode !== 'throw') throw new Error(`DSH_TUI_FAULT[${index}]: mode 只能是 missing 或 throw`)
    if (specifier === '') throw new Error(`DSH_TUI_FAULT[${index}]: specifier 为空`)
    return { mode, specifier }
  })
}

/**
 * 生成钩子模块源码。钩子跑在 loader 线程，不能引用本文件的闭包，所以把配置
 * 序列化进源码；`data:` URL 由 register() 直接加载（Node >= 22.19 支持）。
 * @param {{ mode: string, specifier: string }[]} targets
 * @param {string | undefined} recordPath
 */
function hookSource(targets, recordPath) {
  return `
import { appendFileSync } from 'node:fs'
const TARGETS = ${JSON.stringify(targets)}
const RECORD = ${recordPath === undefined ? 'null' : JSON.stringify(recordPath)}
const seen = new Set()
const normalize = value => value.replaceAll('\\\\', '/')
const suffixOf = specifier => normalize(specifier.startsWith('./') ? specifier.slice(1) : specifier)
// 相对目标按解析后 URL 的后缀匹配；裸包目标按 /node_modules/<name>/ 段匹配
// （load 钩子只拿得到 URL，拿不到原始说明符）。
const matchesUrl = (target, url) => {
  const normalized = normalize(url)
  if (target.specifier.startsWith('.') || target.specifier.startsWith('/')) {
    return normalized.endsWith(suffixOf(target.specifier))
  }
  return normalized.includes('/node_modules/' + target.specifier + '/')
}
const matches = (specifier, url) => TARGETS.some(target =>
  specifier === target.specifier
  || (url !== undefined && matchesUrl(target, url)))
export async function resolve(specifier, context, nextResolve) {
  for (const target of TARGETS) {
    if (target.mode === 'missing' && specifier === target.specifier) {
      throw Object.assign(new Error('[FAULT_INJECTED] 模块缺失（resolve）: ' + specifier), { code: 'ERR_MODULE_NOT_FOUND' })
    }
  }
  const resolved = await nextResolve(specifier, context)
  for (const target of TARGETS) {
    if (target.mode === 'missing' && matches(specifier, resolved.url)) {
      throw Object.assign(new Error('[FAULT_INJECTED] 模块缺失（resolve）: ' + specifier + ' -> ' + resolved.url), { code: 'ERR_MODULE_NOT_FOUND' })
    }
  }
  return resolved
}
export async function load(url, context, nextLoad) {
  for (const target of TARGETS) {
    if (target.mode === 'throw' && matchesUrl(target, url)) {
      throw new Error('[FAULT_INJECTED] 模块加载失败（load）: ' + url)
    }
  }
  const result = await nextLoad(url, context)
  if (RECORD !== null && url.startsWith('file:') && !seen.has(url)) {
    seen.add(url)
    try { appendFileSync(RECORD, JSON.stringify({ url, at: Date.now() }) + '\\n') } catch { /* 记录失败不得让被测进程失败 */ }
  }
  return result
}
`
}

let installed = false

/**
 * 按显式参数安装钩子（脚本可在设置 env 后调用）；重复安装是幂等的。
 * @param {{ targets?: { mode: string, specifier: string }[], recordPath?: string }} [options]
 * @returns {boolean} 是否安装了钩子
 */
export function installFaultLoader(options = {}) {
  const targets = options.targets ?? parseFaultList(process.env.DSH_TUI_FAULT)
  const recordPath = options.recordPath ?? (process.env.DSH_TUI_FAULT_RECORD === '' ? undefined : process.env.DSH_TUI_FAULT_RECORD)
  if (targets.length === 0 && recordPath === undefined) return false
  if (!installed) {
    register('data:text/javascript,' + encodeURIComponent(hookSource(targets, recordPath)), import.meta.url)
    installed = true
  }
  return true
}

// `node --import ./scripts/lib/fault-loader.mjs <child>` 的入口：按 env 自动安装。
installFaultLoader()
