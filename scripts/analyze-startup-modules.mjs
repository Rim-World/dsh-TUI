#!/usr/bin/env node
/**
 * analyze-startup-modules — 启动关键路径的静态模块图审计（WP6）。
 *
 * 从本包入口 src/dsh-adapter/host-entry.ts 出发，沿静态 import/export-from 边求
 * 「首帧前」会加载的模块集合；再叠加 host-entry 在首帧前 await 的 7 个动态入口
 * （index/plugin/backend-assembly/entry-slot/host-access/update-overflow-guard/update）
 * 的静态闭包——它们虽然写成 import()，但在 apply() 之前 await 完，仍属首帧前。
 *
 * 输出：外部 npm 包与仓内模块两张 Top 表（体积降序），并可用 --json 导出完整图。
 * 依赖为零（只用 node: 内置），pnpm install 未完成时也能跑；此时 node_modules 里的
 * 包体积记为 0/未安装，仓内体积不受影响。
 *
 * 用法：
 *   node scripts/analyze-startup-modules.mjs                 # 打印两张 Top 20
 *   node scripts/analyze-startup-modules.mjs --top 30
 *   node scripts/analyze-startup-modules.mjs --json out.json # 另存完整数据
 *   node scripts/analyze-startup-modules.mjs --imports-of src/dsh-adapter/plugin.ts
 *                                                            # 只列该模块的直接静态依赖及其闭包体积
 *
 * 判定约定（与 docs/standalone-host-design.md 一致）：
 *   - 「首帧前」= host-entry 的静态 import + 首帧前 await 的动态入口的静态闭包；
 *   - host-entry 里 disposeEntryRoot 的 import('./backend-registry.js') 与无宿主根
 *     回退的 import('@deepseek-ai/cordis') 不在首帧路径上，排除；
 *   - 其他位置的 import() 一律视为「可延后」，除非它所在的模块本身在首帧闭包里
 *     （此时它仍可能被首个渲染调用——静态审计给不出调用时机，报告中人工判定）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ENTRY = 'src/dsh-adapter/host-entry.ts'
/** host-entry.ts:143-149：首帧前 await 的动态入口（顺序与源码一致）。 */
export const PRE_FRAME_DYNAMIC_ROOTS = [
  'src/dsh-adapter/index.ts',
  'src/dsh-adapter/plugin.ts',
  'src/dsh-adapter/backend-assembly.ts',
  'src/dsh-adapter/entry-slot.ts',
  'src/dsh-adapter/host-access.ts',
  'src/ink/update-overflow-guard.ts',
  'src/update.ts',
]
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
const FILE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
const REGEX_PREFIX_KEYWORDS = new Set(['return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'])

// ── 词法：足够精确地跳过注释/字符串，取出 import/export 语句 ─────────────────────
export function tokenize(code) {
  const tokens = []
  let line = 1
  let i = 0
  const n = code.length
  const push = (t, v, startLine) => tokens.push({ t, v, line: startLine, pos: i })
  while (i < n) {
    const c = code[i]
    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    // 正则字面量：按前一个 token 判断是否处于表达式位置，避免把 /"/g 里的引号
    // 当成字符串开头（否则后续 import 语句会被整段吞掉）。
    if (c === '/') {
      const prev = tokens.at(-1)
      const regexAllowed = prev === undefined
        || (prev.t === 'punct' && /[({[,;:!&|?=<>+\-*%^~]/.test(prev.v))
        || (prev.t === 'id' && REGEX_PREFIX_KEYWORDS.has(prev.v))
      if (regexAllowed) {
        const startLine = line
        i++
        let inClass = false
        while (i < n) {
          const ch = code[i]
          if (ch === '\\') { i += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) { i++; break }
          else if (ch === '\n') { line++; break }
          i++
        }
        while (i < n && /[a-z]/i.test(code[i])) i++
        push('punct', '/', startLine)
        continue
      }
    }
    // 字符串与模板字符串（模板里的 ${} 不展开：import 说明符不会写在模板表达式里）
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      const start = i
      i++
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '\n') line++
        if (code[i] === quote) { i++; break }
        i++
      }
      push('str', code.slice(start + 1, i - 1), line)
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$]/.test(code[i])) i++
      push('id', code.slice(start, i), line)
      continue
    }
    const startLine = line
    push('punct', c, startLine)
    i++
  }
  return tokens
}

/** 从 tokens[k] 的 import/export 语句里抽说明符；返回 [[spec, isTypeOnly], ...]。 */
export function statementSpecifiers(tokens, k) {
  const out = []
  const first = tokens[k]
  if (first.v === 'import') {
    const t1 = tokens[k + 1]
    if (t1 === undefined) return out
    if (t1.t === 'punct' && t1.v === '(') {
      const s = tokens[k + 2]
      if (s?.t === 'str') out.push([s.v, false])
      return out
    }
    if (t1.t === 'punct' && t1.v === '.') return out // import.meta
    let j = k + 1
    let typeOnly = false
    if (tokens[j]?.t === 'id' && tokens[j].v === 'type') { typeOnly = true; j++ }
    if (tokens[j]?.t === 'str') { out.push([tokens[j].v, typeOnly]); return out }
    let depth = 0
    for (; j < tokens.length; j++) {
      const t = tokens[j]
      if (t.t === 'punct') {
        if (t.v === ';') return out
        if (t.v === '(') return out
        if (t.v === '{') { depth++; continue }
        if (t.v === '}') { depth--; continue }
        continue
      }
      if (t.t === 'id' && depth === 0 && t.v === 'from') {
        const s = tokens[j + 1]
        if (s?.t === 'str') out.push([s.v, typeOnly])
        return out
      }
    }
    return out
  }
  // export ...
  let j = k + 1
  let typeOnly = false
  if (tokens[j]?.t === 'id' && tokens[j].v === 'type') { typeOnly = true; j++ }
  let depth = 0
  let inList = false
  for (; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.t === 'punct') {
      if (t.v === ';') return out
      if (t.v === '{') { depth++; inList = true; continue }
      if (t.v === '}') { depth--; continue }
      if (t.v === '=' || t.v === '(') return out
      continue
    }
    if (t.t === 'id' && depth === 0) {
      if (t.v === 'from') {
        const s = tokens[j + 1]
        if (s?.t === 'str') out.push([s.v, typeOnly])
        return out
      }
      if (t.v === 'as') continue
      if (!inList) return out // export const/function/class/...：没有 from
    }
  }
  return out
}

export function scanFile(file) {
  const code = readFileSync(file, 'utf8')
  const tokens = tokenize(code)
  const statics = []
  const dynamics = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.t !== 'id') continue
    if (t.v !== 'import' && t.v !== 'export') continue
    const prev = tokens[k - 1]
    if (prev !== undefined && prev.t === 'punct' && prev.v === '.') continue
    const next = tokens[k + 1]
    const isDynamic = t.v === 'import' && next?.t === 'punct' && next.v === '('
    if (isDynamic) {
      // type 位置：typeof import('x') / x: import('x').T / as import('x').T——类型专用，运行时不加载。
      if (prev !== undefined && prev.t === 'id' && (prev.v === 'typeof' || prev.v === 'as')) continue
      if (prev !== undefined && prev.t === 'punct' && [':', '<', '|', '&'].includes(prev.v)) continue
      const s = tokens[k + 2]
      if (s?.t === 'str') dynamics.push({ spec: s.v, line: t.line })
      continue
    }
    for (const [spec, typeOnly] of statementSpecifiers(tokens, k)) {
      statics.push({ spec, typeOnly, line: t.line })
    }
  }
  return { statics, dynamics }
}

export function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const candidates = []
  if (extname(base) !== '') {
    candidates.push(base)
    if (base.endsWith('.js')) {
      candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx')
    }
  } else {
    for (const ext of FILE_EXT) candidates.push(base + ext)
  }
  for (const ext of FILE_EXT) candidates.push(join(base, 'index' + ext))
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c } catch { /* 不存在 */ }
  }
  return null
}

const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const IMPORT_MAP = pkgJson.imports ?? {}
/** 工作区内的包名 → 目录（pnpm install 未完成时的位置来源）。 */
const WORKSPACE_PACKAGES = new Map()
for (const dir of ['vendor/dsh-std/packages', 'vendor']) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) continue
  for (const name of readdirSync(abs)) {
    const candidate = join(abs, name)
    const pj = join(candidate, 'package.json')
    if (!existsSync(pj)) {
      const sub = join(abs, name, 'packages')
      if (existsSync(sub)) {
        for (const subName of readdirSync(sub)) {
          const subPj = join(sub, subName, 'package.json')
          if (existsSync(subPj)) {
            try {
              const meta = JSON.parse(readFileSync(subPj, 'utf8'))
              if (typeof meta.name === 'string') WORKSPACE_PACKAGES.set(meta.name, dirname(subPj))
            } catch { /* 忽略坏 manifest */ }
          }
        }
      }
      continue
    }
    try {
      const meta = JSON.parse(readFileSync(pj, 'utf8'))
      if (typeof meta.name === 'string') WORKSPACE_PACKAGES.set(meta.name, candidate)
    } catch { /* 忽略坏 manifest */ }
  }
}

export function resolvePackageDir(name) {
  const local = WORKSPACE_PACKAGES.get(name)
  if (local !== undefined) return local
  const parts = name.startsWith('@') ? name.split('/').slice(0, 2) : [name]
  const target = join(ROOT, 'node_modules', ...parts)
  try {
    if (statSync(target).isDirectory()) return target
  } catch { /* 未安装 */ }
  return null
}

const packageSizeCache = new Map()
export function dirSize(dir) {
  if (packageSizeCache.has(dir)) return packageSizeCache.get(dir)
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try { total += statSync(full).size } catch { /* 忽略 */ }
      }
    }
  }
  packageSizeCache.set(dir, total)
  return total
}

export function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith('node:')) return { kind: 'builtin', name: spec }
  if (BUILTINS.has(spec)) return { kind: 'builtin', name: spec }
  if (spec.startsWith('#')) {
    const mapped = IMPORT_MAP[spec]
    if (typeof mapped === 'string') {
      const file = resolveRelative(join(ROOT, 'package.json'), mapped)
      if (file !== null) return { kind: 'file', file }
    }
    return { kind: 'unresolved', name: spec }
  }
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const file = resolveRelative(fromFile, spec)
    return file === null ? { kind: 'unresolved', name: spec } : { kind: 'file', file }
  }
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  const dir = resolvePackageDir(name)
  return dir === null ? { kind: 'package', name, dir: null } : { kind: 'package', name, dir }
}

export const relId = (file) => relative(ROOT, file).split(sep).join('/')

// ── 图：静态边 BFS ───────────────────────────────────────────────────────────
export function buildGraph() {
  const modules = new Map()
  const loadModule = (file) => {
    const id = relId(file)
    let mod = modules.get(id)
    if (mod !== undefined) return mod
    mod = { id, file, bytes: statSync(file).size, statics: [], dynamics: [], stage: null }
    modules.set(id, mod)
    const scanned = scanFile(file)
    for (const ref of scanned.statics) {
      if (ref.typeOnly) continue
      mod.statics.push({ ...ref, target: resolveSpecifier(file, ref.spec) })
    }
    for (const ref of scanned.dynamics) {
      mod.dynamics.push({ ...ref, target: resolveSpecifier(file, ref.spec) })
    }
    return mod
  }
  const closure = (roots, stage) => {
    const seen = new Set()
    const queue = []
    for (const root of roots) {
      const fromFile = resolve(ROOT, root)
      const mod = loadModule(fromFile)
      if (mod.stage === null) mod.stage = stage
      queue.push(mod.id)
    }
    while (queue.length > 0) {
      const id = queue.pop()
      if (seen.has(id)) continue
      seen.add(id)
      const mod = modules.get(id)
      if (mod === undefined) continue
      for (const edge of mod.statics) {
        if (edge.target.kind !== 'file') continue
        const child = loadModule(edge.target.file)
        if (child.stage === null) child.stage = stage
        queue.push(child.id)
      }
    }
    return seen
  }
  const stageA = closure([ENTRY], 'entry-static')
  const stageB = closure(PRE_FRAME_DYNAMIC_ROOTS, 'pre-frame-dynamic')
  return { modules, loadModule, closure, stageA, stageB, preFrame: new Set([...stageA, ...stageB]) }
}

/** 从某个模块出发的静态闭包：仓内模块集合与外部包集合。 */
export function closureOf(graph, startId) {
  const seen = new Set()
  const pkgs = new Set()
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const mod = graph.modules.get(id)
    if (mod === undefined) continue
    for (const edge of mod.statics) {
      if (edge.target.kind === 'file') queue.push(relId(edge.target.file))
      else if (edge.target.kind === 'package') pkgs.add(edge.target.name)
    }
  }
  return { modules: seen, packages: pkgs }
}

const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

function main() {
  const argOf = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
  }
  const TOP = Number(argOf('--top', '20'))
  const graph = buildGraph()
  const { modules, stageA, stageB, preFrame } = graph

  // 首帧闭包里的外部包（以及它们被谁引入）
  const externals = new Map()
  for (const id of preFrame) {
    const mod = modules.get(id)
    if (mod === undefined) continue
    for (const edge of mod.statics) {
      const target = edge.target
      if (target.kind !== 'package') continue
      let entry = externals.get(target.name)
      if (entry === undefined) {
        entry = { name: target.name, dir: target.dir, size: 0, importers: new Set() }
        externals.set(target.name, entry)
      }
      entry.importers.add(mod.id)
    }
  }
  for (const entry of externals.values()) {
    if (entry.dir !== null) entry.size = dirSize(entry.dir)
  }

  // 首帧闭包外、但被首帧闭包内模块以 import() 引用的包（可延后候选）
  const deferredExternals = new Map()
  for (const id of preFrame) {
    const mod = modules.get(id)
    if (mod === undefined) continue
    for (const edge of mod.dynamics) {
      const target = edge.target
      if (target.kind !== 'package' || externals.has(target.name)) continue
      let entry = deferredExternals.get(target.name)
      if (entry === undefined) {
        entry = { name: target.name, dir: target.dir, size: 0, importers: new Set(), from: new Set() }
        deferredExternals.set(target.name, entry)
      }
      entry.importers.add(mod.id)
      entry.from.add(`${mod.id}:${edge.line}`)
    }
  }
  for (const entry of deferredExternals.values()) {
    if (entry.dir !== null) entry.size = dirSize(entry.dir)
  }

  const importsOf = argOf('--imports-of', null)
  if (importsOf !== null) {
    const file = resolve(ROOT, importsOf)
    const mod = graph.loadModule(file)
    const rows = []
    for (const edge of mod.statics) {
      const target = edge.target
      if (target.kind === 'file') {
        const sub = closureOf(graph, relId(target.file))
        let own = 0
        for (const id of sub.modules) own += modules.get(id)?.bytes ?? 0
        let pkgBytes = 0
        for (const name of sub.packages) {
          const dir = resolvePackageDir(name)
          if (dir !== null) pkgBytes += dirSize(dir)
        }
        rows.push({ spec: edge.spec, line: edge.line, target: relId(target.file), ownBytes: modules.get(relId(target.file))?.bytes ?? 0, closureModules: sub.modules.size, closurePackages: sub.packages.size, closureBytes: own + pkgBytes, packages: [...sub.packages].sort() })
      } else if (target.kind === 'package') {
        rows.push({ spec: edge.spec, line: edge.line, target: target.name, ownBytes: target.dir === null ? 0 : dirSize(target.dir), closureModules: 0, closurePackages: 1, closureBytes: target.dir === null ? 0 : dirSize(target.dir), packages: [target.name] })
      }
    }
    rows.sort((a, b) => b.closureBytes - a.closureBytes)
    console.log(`## ${importsOf} 的直接静态依赖（按闭包体积降序，Top ${TOP}）`)
    console.log(``)
    console.log('| # | import 行 | 说明符 | 目标 | 目标自身 | 闭包（仓内模块/外部包/估算字节） |')
    console.log('| ---: | ---: | --- | --- | ---: | --- |')
    rows.slice(0, TOP).forEach((row, index) => {
      console.log(`| ${index + 1} | ${row.line} | \`${row.spec}\` | \`${row.target}\` | ${bytes(row.ownBytes)} | ${row.closureModules}/${row.closurePackages}/${bytes(row.closureBytes)} |`)
    })
    return
  }

  console.log(`# 启动前模块图（WP6 静态审计）`)
  console.log(``)
  console.log(`- 入口：${ENTRY}`)
  console.log(`- entry 静态闭包：${stageA.size} 个仓内模块`)
  console.log(`- 首帧前 await 的动态入口静态闭包：${stageB.size} 个仓内模块（与上一行并集 ${preFrame.size}）`)
  console.log(`- 首帧闭包外部包：${externals.size} 个；仅经 import() 引用的候选：${deferredExternals.size} 个`)
  const totalRepoBytes = [...preFrame].reduce((sum, id) => sum + (modules.get(id)?.bytes ?? 0), 0)
  const packageTop = [...externals.values()].sort((a, b) => b.size - a.size)
  const deferredTop = [...deferredExternals.values()].sort((a, b) => b.size - a.size)
  const totalPkgBytes = packageTop.reduce((sum, entry) => sum + entry.size, 0)
  console.log(`- 仓内源码字节：${bytes(totalRepoBytes)}；外部包目录体积上界：${bytes(totalPkgBytes)}`)
  console.log(``)

  console.log(`## 表 1：首帧前外部 npm 包（按包目录体积降序，Top ${TOP}）`)
  console.log(``)
  console.log('| # | 包 | 包目录体积上界 | 引入者（前 2） |')
  console.log('| ---: | --- | ---: | --- |')
  packageTop.slice(0, TOP).forEach((entry, index) => {
    console.log(`| ${index + 1} | \`${entry.name}\` | ${bytes(entry.size)} | ${[...entry.importers].slice(0, 2).join('、')} |`)
  })
  console.log(``)

  const repoTop = [...preFrame]
    .map((id) => modules.get(id))
    .filter((mod) => mod !== undefined)
    .map((mod) => {
      const sub = closureOf(graph, mod.id)
      let own = 0
      for (const id of sub.modules) own += modules.get(id)?.bytes ?? 0
      return { ...mod, closureModules: sub.modules.size, closurePackages: sub.packages.size }
    })
    .sort((a, b) => b.bytes - a.bytes)
  console.log(`## 表 2：首帧前仓内模块（按自身源码字节降序，Top ${TOP}）`)
  console.log(``)
  console.log('| # | 模块 | 自身字节 | 静态闭包（仓内模块/外部包） | 阶段 |')
  console.log('| ---: | --- | ---: | ---: | --- |')
  repoTop.slice(0, TOP).forEach((mod, index) => {
    console.log(`| ${index + 1} | \`${mod.id}\` | ${bytes(mod.bytes)} | ${mod.closureModules}/${mod.closurePackages} | ${mod.stage} |`)
  })
  console.log(``)

  console.log(`## 表 3：仅经 import() 引用的外部包（不占首帧，Top ${TOP}）`)
  console.log(``)
  console.log('| # | 包 | 包目录体积上界 | 调用点 |')
  console.log('| ---: | --- | ---: | --- |')
  deferredTop.slice(0, TOP).forEach((entry, index) => {
    console.log(`| ${index + 1} | \`${entry.name}\` | ${bytes(entry.size)} | ${[...entry.from].slice(0, 2).join('、')} |`)
  })
  console.log(``)

  const jsonPath = argOf('--json', null)
  if (jsonPath !== null) {
    const payload = {
      entry: ENTRY,
      stageA: [...stageA].sort(),
      stageB: [...stageB].sort(),
      preFrame: [...preFrame].sort(),
      modules: Object.fromEntries([...modules.entries()].map(([id, mod]) => [id, {
        bytes: mod.bytes,
        stage: mod.stage,
        statics: mod.statics.map((edge) => ({ spec: edge.spec, line: edge.line, target: edge.target.kind === 'file' ? relId(edge.target.file) : edge.target.name })),
        dynamics: mod.dynamics.map((edge) => ({ spec: edge.spec, line: edge.line, target: edge.target.kind === 'file' ? relId(edge.target.file) : edge.target.name })),
      }])),
      externals: Object.fromEntries(packageTop.map((entry) => [entry.name, { size: entry.size, importers: [...entry.importers] }])),
      deferredExternals: Object.fromEntries(deferredTop.map((entry) => [entry.name, { size: entry.size, from: [...entry.from] }])),
    }
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2))
    console.log(`已写出 JSON：${jsonPath}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
