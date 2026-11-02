#!/usr/bin/env node
/**
 * analyze-boot-trace — 解析 DSH_TUI_BOOT_TRACE 的 boot trace（WP6）。
 *
 * 每行是 utils/bootTrace.ts 写下的 {"mark","ms","at","pid"}；ms 从该进程启动算。
 * 本脚本把一次启动拆成关键段，给出首帧与后端就绪时间，并跨多轮取中位数。
 * 只读，不启动 TUI、不写终端；`node scripts/analyze-boot-trace.mjs` 可直接在仓库根跑。
 *
 * 用法：
 *   DSH_TUI_BOOT_TRACE=bench/boot-1.jsonl dsh-tui        # 采集（5 轮各一个文件）
 *   node scripts/analyze-boot-trace.mjs bench/boot-*.jsonl
 *   node scripts/analyze-boot-trace.mjs --marks bench/boot-*.jsonl   # 附每轮标记明细
 *   node scripts/analyze-boot-trace.mjs --json TMP/xx.json *.jsonl   # 另存结构化结果
 *
 * 口径（与 2.PLANS/001-G 的 WP6、3.DOCS/002-R §4.7 对齐）：
 *   首帧 = render-start（开始渲染；render-done 另列，差值即渲染耗时）。
 *         ms 是本进程计时，不含 shell、启动器与 Node 进程启动开销；
 *         报告「用户可见首帧」时要另加启动器段（见输出的「进程外」说明）。
 *   后端就绪 = startup-adopted（后端会话接管完成）；旧 trace 没有该标记时显示「未记录」，
 *         不得用 entry-compose-end 冒充（后者只是组合结束，后端打开可能更晚）。
 *   首帧前模块段 = entry-start → entry-modules（分两段：entry-start→entry-hijacked 是宿主
 *         模块加载与根准备，entry-hijacked→entry-modules 是 TUI 模块图）。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const ORDER = [
  'entry-start',
  'entry-hijacked',
  'entry-host-unavailable',
  'entry-modules',
  'render-start',
  'render-done',
  'entry-compose-start',
  'entry-compose-end',
  'startup-adopted',
]
const LABEL = {
  'entry-start': '入口开始执行（含 Node 启动 + 入口静态 import）',
  'entry-hijacked': '宿主根就绪（宿主模块加载 + 准备完成）',
  'entry-host-unavailable': '宿主不可用（走了回退路径）',
  'entry-modules': '首帧前 TUI 模块加载完成',
  'render-start': '首帧开始渲染',
  'render-done': '首帧渲染完成',
  'entry-compose-start': '首帧后开始组合 DSH profile',
  'entry-compose-end': 'profile 组合结束',
  'startup-adopted': '后端会话接管完成（后端就绪）',
}

function load(file) {
  const text = readFileSync(file, 'utf8')
  const groups = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error(`${file}: 无法解析的 JSON 行：${line.slice(0, 120)}`)
    }
    const pid = record.pid ?? 0
    if (!groups.has(pid)) groups.set(pid, [])
    groups.get(pid).push(record)
  }
  return groups
}

const markMap = (records) => {
  const marks = new Map()
  for (const record of records) {
    // 同名标记只认第一次（重启链路里同一文件可能被追加）。
    if (!marks.has(record.mark)) marks.set(record.mark, record)
  }
  return marks
}
const at = (marks, name) => marks.get(name)?.ms
const delta = (marks, from, to) => {
  const a = at(marks, from)
  const b = at(marks, to)
  return a === undefined || b === undefined ? undefined : b - a
}

function summarize(file, pid, records) {
  const marks = markMap(records)
  const firstFrame = at(marks, 'render-start')
  const renderDone = at(marks, 'render-done')
  const backendReady = at(marks, 'startup-adopted')
  return {
    file: basename(file),
    filePath: file,
    pid,
    marks: ORDER.filter((name) => marks.has(name)).map((name) => ({ mark: name, ms: at(marks, name), at: marks.get(name).at })),
    entryStart: at(marks, 'entry-start'),
    hostReady: at(marks, 'entry-hijacked'),
    modulesReady: at(marks, 'entry-modules'),
    firstFrame,
    renderDone,
    renderMs: renderDone !== undefined && firstFrame !== undefined ? renderDone - firstFrame : undefined,
    composeStart: at(marks, 'entry-compose-start'),
    composeEnd: at(marks, 'entry-compose-end'),
    backendReady,
    segments: {
      '进程启动→入口': at(marks, 'entry-start'),
      '宿主段(entry-start→hijacked)': delta(marks, 'entry-start', 'entry-hijacked'),
      'TUI模块段(hijacked→modules)': delta(marks, 'entry-hijacked', 'entry-modules'),
      '入口模块段(entry-start→modules)': delta(marks, 'entry-start', 'entry-modules'),
      'apply段(modules→render-start)': delta(marks, 'entry-modules', 'render-start'),
      '渲染段(render-start→render-done)': delta(marks, 'render-start', 'render-done'),
      '组合段(compose-start→compose-end)': delta(marks, 'entry-compose-start', 'entry-compose-end'),
      '尾部(compose-end→startup-adopted)': delta(marks, 'entry-compose-end', 'startup-adopted'),
    },
  }
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const fixed = (value) => (value === undefined ? '未记录' : value.toFixed(0))

const args = process.argv.slice(2)
const showMarks = args.includes('--marks')
const jsonIndex = args.indexOf('--json')
const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined
const files = args.filter((arg, index) => !arg.startsWith('--') && (jsonIndex < 0 || index !== jsonIndex + 1))
if (files.length === 0) {
  console.error('用法：node scripts/analyze-boot-trace.mjs [--marks] [--json out.json] <boot-trace.jsonl>...')
  process.exit(2)
}

const runs = []
for (const file of files) {
  for (const [pid, records] of load(file)) {
    if (records.length === 0) continue
    runs.push(summarize(file, pid, records))
  }
}
runs.sort((a, b) => (a.entryStart ?? 0) - (b.entryStart ?? 0))

console.log('# boot trace 解析（WP6）')
console.log('')
console.log(`- 文件：${files.length} 个；进程组：${runs.length} 个`)
console.log('- 首帧口径：render-start（进程内计时；不含启动器与 Node 进程启动）')
console.log('- 后端就绪口径：startup-adopted（缺该标记显示未记录，不用 compose-end 代替）')
console.log('')

console.log('| # | 文件 | 首帧(render-start) | 首帧渲染(ms) | 入口模块段 | 宿主段 | TUI模块段 | 组合段 | 后端就绪 |')
console.log('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
runs.forEach((run, index) => {
  console.log(`| ${index + 1} | ${run.file} | ${fixed(run.firstFrame)} | ${fixed(run.renderMs)} | ${fixed(run.segments['入口模块段(entry-start→modules)'])} | ${fixed(run.segments['宿主段(entry-start→hijacked)'])} | ${fixed(run.segments['TUI模块段(hijacked→modules)'])} | ${fixed(run.segments['组合段(compose-start→compose-end)'])} | ${fixed(run.backendReady)} |`)
})
console.log('')

const summary = {}
for (const key of ['进程启动→入口', '入口模块段(entry-start→modules)', '宿主段(entry-start→hijacked)', 'TUI模块段(hijacked→modules)', 'apply段(modules→render-start)', '渲染段(render-start→render-done)', '组合段(compose-start→compose-end)', '尾部(compose-end→startup-adopted)']) {
  summary[key] = median(runs.map((run) => run.segments[key]))
}
summary['首帧(render-start)'] = median(runs.map((run) => run.firstFrame))
summary['首帧(render-done)'] = median(runs.map((run) => run.renderDone))
summary['后端就绪(startup-adopted)'] = median(runs.map((run) => run.backendReady))

console.log(`## 中位数（${runs.length} 轮）`)
console.log('')
console.log('| 指标 | 中位数(ms) |')
console.log('| --- | ---: |')
for (const [key, value] of Object.entries(summary)) console.log(`| ${key} | ${fixed(value)} |`)
console.log('')
console.log('> 首帧是进程内计时。用户可见首帧还要加启动器与 Node 进程启动：用 `bin/dsh-tui.js` 启动时，')
console.log('> 入口进程的 ms=0 晚于命令行发出约 0.3–0.5 s（见 TMP/01_证据日志 的历史 trace），不要在报告里把两者混为一个数。')
console.log('')

if (showMarks) {
  for (const run of runs) {
    console.log(`### ${run.file}（pid ${run.pid}）`)
    console.log('')
    console.log('| 标记 | ms | 含义 |')
    console.log('| --- | ---: | --- |')
    for (const mark of run.marks) console.log(`| ${mark.mark} | ${mark.ms} | ${LABEL[mark.mark] ?? ''} |`)
    console.log('')
  }
}

if (jsonPath !== undefined) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(jsonPath, JSON.stringify({ files, summary, runs }, null, 2))
  console.log(`已写出 JSON：${jsonPath}`)
}
