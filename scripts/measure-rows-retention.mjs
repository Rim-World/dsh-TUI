/**
 * measure-rows-retention — 转录行保留量的内存测量（WP5 → WP8 决策门）。
 *
 * 目的：给「MAX_ROWS=600 只折叠载荷、不删行」这一现状补数字：
 * 1. n 条 state.rows 实际保留多少堆内存（B/行）；
 * 2. 折叠（foldRows）之后省多少，行数为什么不变；
 * 3. 新会话逐轮追加时，保留量是否随轮数线性增长；
 * 4. /clear（state.rows.length = 0）能释放多少。
 *
 * 边界（必须按此读数）：
 * - 只测行数据结构本身（ChatRow 对象 + 文本 + ToolRow），不含 React/Ink
 *   组件树、输出缓冲、read-view 冻结快照与终端 scrollback。真实进程的
 *   基线内存显著高于这里的数字。
 * - fixture 是合成数据，文本密度固定；真实会话按模型输出长度变化。
 * - 本脚本不做任何架构改动，结论交给 WP8 决定是否实施「显示保留上限」。
 *
 * 运行（必须带 --expose-gc，否则读数含未回收垃圾）：
 *   node --expose-gc --import tsx/esm scripts/measure-rows-retention.mjs
 *   node --expose-gc --import tsx/esm scripts/measure-rows-retention.mjs --json
 *
 * 退出码：0 = 测量完成且自检通过；1 = 自检失败（例如折叠后行数变化）。
 */

const { MAX_ROWS, foldRows } = await import('../src/dsh-adapter/channel/transcript.js')
const fx = await import('./lib/long-session-fixture.js')

const JSON_MODE = process.argv.includes('--json')
const gcAvailable = typeof globalThis.gc === 'function'
const collect = () => {
  if (!gcAvailable) return
  globalThis.gc()
  globalThis.gc()
}
const heapBytes = () => process.memoryUsage().heapUsed
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
const kib = value => value / 1024
const mib = value => value / 1048576
const round = (value, digits = 1) => Number(value.toFixed(digits))

if (!gcAvailable) {
  console.warn('警告：未启用 --expose-gc，堆读数含未回收垃圾，结果只可横向比较。')
  console.warn('      正确命令：node --expose-gc --import tsx/esm scripts/measure-rows-retention.mjs')
}

/** 在全新作用域里构造 rows 并测堆增量；返回 {rows, retainedBytes, jsonBytes}。 */
const sampleRows = rowCount => {
  collect()
  const before = heapBytes()
  const rows = fx.buildTranscriptRows(rowCount)
  collect()
  const retained = heapBytes() - before
  const jsonBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8')
  return { rows, retainedBytes: retained, jsonBytes }
}

const sizes = [600, 1200, 3000, 6000, 12000, 24000]
const rowsTable = []
for (const rowCount of sizes) {
  const samples = []
  let jsonBytes = 0
  let holder = null
  for (let i = 0; i < 3; i++) {
    const sample = sampleRows(rowCount)
    samples.push(sample.retainedBytes)
    jsonBytes = sample.jsonBytes
    holder = sample.rows.length
    // holder 只为了在样本之间保留一次引用计数；下一轮重新分配前显式释放。
    if (holder !== rowCount) throw new Error(`fixture 行数不符：期望 ${rowCount}，实得 ${holder}`)
  }
  rowsTable.push({
    rows: rowCount,
    retainedBytes: round(median(samples), 0),
    bytesPerRow: round(median(samples) / rowCount, 0),
    jsonBytes,
  })
}

// 折叠效果：同样是 12000 行，测「短文本」与「长载荷」两种密度，各 3 次。
// 短文本行低于 200 字符预览上限，foldRows 几乎无收益；长载荷才代表真实的长
// 会话（助手长回复、工具完整参数/结果），foldRows 会丢弃这些完整字段。
const foldSamples = { short: [], long: [] }
const measureFold = (label, build) => {
  let rows = null
  for (let i = 0; i < 3; i++) {
    rows = null
    collect()
    const before = heapBytes()
    rows = build()
    collect()
    const unfurled = heapBytes() - before
    const folded = foldRows(rows, MAX_ROWS)
    collect()
    const furled = heapBytes() - before
    foldSamples[label].push({ unfurled, furled, folded, rowCount: rows.length })
  }
}
measureFold('short', () => fx.buildTranscriptRows(12000))
measureFold('long', () => fx.buildTranscriptRows(12000, { assistantLines: 10, textChars: 400, fullPayloadChars: 4000 }))
const foldRowsOf = label => ({
  rows: 12000,
  maxRows: MAX_ROWS,
  foldedRows: median(foldSamples[label].map(sample => sample.folded)),
  rowCountAfterFold: median(foldSamples[label].map(sample => sample.rowCount)),
  beforeBytes: round(median(foldSamples[label].map(sample => sample.unfurled)), 0),
  afterBytes: round(median(foldSamples[label].map(sample => sample.furled)), 0),
  savedRatio: round(1 - median(foldSamples[label].map(sample => sample.furled)) / median(foldSamples[label].map(sample => sample.unfurled)), 3),
})
const folds = { short: foldRowsOf('short'), long: foldRowsOf('long') }

// 逐轮增长曲线：每轮 4 行（user + 2 tool + 1 assistant），记录堆与行数。
const growth = []
{
  collect()
  const start = heapBytes()
  const rows = []
  const rowsPerTurn = 4
  let turns = 0
  for (const milestone of [250, 500, 1000, 1500, 2000]) {
    while (turns < milestone) {
      turns += 1
      rows.push({ id: turns * rowsPerTurn - 3, kind: 'user', text: `问题 ${turns}`, seq: turns * rowsPerTurn - 4 })
      for (let t = 0; t < 2; t++) {
        rows.push({
          id: turns * rowsPerTurn - 2 + t,
          kind: 'tool',
          text: '',
          seq: turns * rowsPerTurn - 3 + t,
          tool: {
            callId: `t${turns}-${t}`,
            name: 'Read',
            argsText: `{"file_path":"/tmp/f${t}.ts"}`,
            status: 'ok',
            resultText: `内容行 1\n内容行 2`,
          },
        })
      }
      rows.push({
        id: turns * rowsPerTurn + 1,
        kind: 'assistant',
        text: `回复 ${turns} 第 1 行\n回复 ${turns} 第 2 行`,
        seq: turns * rowsPerTurn,
      })
    }
    collect()
    growth.push({ turns, rows: rows.length, bytes: heapBytes() - start })
  }
  // 与 /clear 等价：只把行数组清空（channel.clear() 的 state.rows.length = 0）。
  collect()
  const beforeClear = heapBytes() - start
  rows.length = 0
  collect()
  const afterClear = heapBytes() - start
  growth.push({ turns, rows: 0, bytes: afterClear, beforeClear, afterClear })
}

// ── 自检与结论数字 ──────────────────────────────────────────────────────
const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
check('折叠不减少行数（只删载荷）', folds.short.rowCountAfterFold === folds.short.rows && folds.long.rowCountAfterFold === folds.long.rows, `短=${folds.short.rowCountAfterFold}/${folds.short.rows} 长=${folds.long.rowCountAfterFold}/${folds.long.rows}`)
check('长载荷折叠明显降低保留量', folds.long.afterBytes < folds.long.beforeBytes * 0.5, `before=${folds.long.beforeBytes} after=${folds.long.afterBytes}`)
check('/clear 后行数据可回收', growth[growth.length - 1].bytes < growth[growth.length - 2].bytes * 0.5, JSON.stringify(growth[growth.length - 1]))
check('MAX_ROWS 与源码一致', MAX_ROWS === 600, String(MAX_ROWS))

const lastGrowth = growth[growth.length - 2]
const perRow = rowsTable[rowsTable.length - 1].bytesPerRow
const output = {
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
    gcAvailable,
    maxRows: MAX_ROWS,
  },
  rows: rowsTable,
  folds,
  growth: growth.map(entry => ({ ...entry, bytes: round(entry.bytes, 0) })),
  checks,
  pass: checks.every(item => item.ok),
}

if (JSON_MODE) {
  console.log(JSON.stringify(output, null, 2))
} else {
  console.log('==== measure-rows-retention（WP5 → WP8 决策门）====')
  console.log(`环境: node=${process.version} ${process.platform}-${process.arch} gc=${gcAvailable} MAX_ROWS=${MAX_ROWS}`)
  console.log('边界: 只测行数据结构（ChatRow+文本+ToolRow），不含 React/Ink 树、输出缓冲、read-view 快照。')
  console.log('')
  console.log('行数规模（3 次构造取中位）')
  console.log('行数'.padEnd(8) + '保留 KiB'.padStart(12) + 'B/行'.padStart(10) + 'JSON 文本 KiB'.padStart(16))
  for (const row of rowsTable) {
    console.log(
      String(row.rows).padEnd(8)
      + kib(row.retainedBytes).toFixed(1).padStart(12)
      + row.bytesPerRow.toFixed(0).padStart(10)
      + kib(row.jsonBytes).toFixed(1).padStart(16),
    )
  }
  console.log('')
  console.log(`折叠效果（12000 行，MAX_ROWS=${MAX_ROWS}）`)
  for (const [label, fold] of Object.entries(folds)) {
    const title = label === 'short' ? '短文本' : '长载荷'
    console.log(`  ${title}: 折叠前 ${mib(fold.beforeBytes).toFixed(2)} MB → 折叠后 ${mib(fold.afterBytes).toFixed(2)} MB（省 ${(fold.savedRatio * 100).toFixed(0)}%）`)
    console.log(`    折叠行数 ${fold.foldedRows}，行数仍为 ${fold.rowCountAfterFold}：上限只删载荷，不删行。`)
  }
  console.log('')
  console.log('逐轮增长（每轮 4 行，保留引用并周期性 GC）')
  console.log('轮数'.padEnd(8) + '行数'.padStart(8) + '保留 KiB'.padStart(12))
  for (const entry of growth) {
    if (entry.rows === 0) {
      console.log(String(entry.turns).padEnd(8) + '0'.padStart(8) + kib(entry.bytes).toFixed(1).padStart(12) + `  ← /clear 后（清前 ${kib(entry.beforeClear).toFixed(1)} KiB）`)
      continue
    }
    console.log(String(entry.turns).padEnd(8) + String(entry.rows).padStart(8) + kib(entry.bytes).toFixed(1).padStart(12))
  }
  console.log('')
  console.log('自检:')
  for (const item of checks) console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail}`}`)
  console.log('')
  console.log(`结论数字: ${lastGrowth.rows} 行保留约 ${mib(lastGrowth.bytes).toFixed(2)} MB，折合 ${perRow} B/行；`)
  console.log(`          按此推算 6000 行约 ${mib(perRow * 6000).toFixed(2)} MB，12000 行约 ${mib(perRow * 12000).toFixed(2)} MB（仅行数据）。`)
  console.log(`结果: ${output.pass ? 'PASS（测量完成）' : 'FAIL（自检未过）'}`)
}

process.exitCode = output.pass ? 0 : 1