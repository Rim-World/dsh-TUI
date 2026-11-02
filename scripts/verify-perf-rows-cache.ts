/**
 * WP3 回归/基准：channel.rows 可见窗口派生缓存（src 直连，不经 lib/）。
 *
 * 覆盖 MessageList 的可见窗口派生 `deriveVisibleRows`：
 *
 * 1. 窗口外行更新：缓存命中（复用同一派生对象），窗口结果不含窗口外旧内容，
 *    指纹访问数恒为窗口长度（RENDERED_ROW_CAP=120），与总行数无关。
 * 2. 窗口内行更新：重新派生且内容刷新（无旧文本）；streaming 落定跨过
 *    empty-assistant 过滤边界时行消失；thinking/turn-usage 过滤即时生效。
 * 3. append 使窗口起点后移：边界正确，离开窗口的旧首行不再出现。
 * 4. 连续 job 卡折叠与展开：job 指纹覆盖状态/展开输入。
 * 5. 1000/3000/6000/12000 行：每帧指纹访问数恒为 120，重建派生访问数
 *    ≤ 5×120；耗时取 5 次中位数，只做宽松上限（确定性指标为主，避免抖动）。
 * 6. 真实组件渲染路径：用假 TTY 渲染 MessageList，按渲染探针断言同 rows
 *    重渲染命中缓存、窗口外更新不重建、窗口内更新重建（组件接线正确）。
 *    假 TTY 的 inline 渲染器不会重绘同高度文本，所以这一节只断言派生
 *    决策，文本正确性由第 1/2 节的纯函数断言覆盖。
 *
 * 背景：read view 在每个 dirty revision 重建冻结行数组（一个流式 delta 就是
 * 一个新数组），旧实现因此每帧对 rows.length 做两遍全量扫描（streaming 位
 * 指纹与 job 指纹）。现在指纹只扫描实际参与派生的窗口（后 120 行）。
 *
 * 运行：node --import tsx/esm scripts/verify-perf-rows-cache.ts
 */
import {
  MessageList,
  RENDERED_ROW_CAP,
  deriveVisibleRows,
  readVisibleWindowProbe,
  resetVisibleWindowProbe,
  type VisibleRowsCacheEntry,
  type VisibleRowsOptions,
} from '../src/components/MessageList.js'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { ThemeProvider, render } from '../src/ui.js'

let checks = 0
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ': ' + detail}`)
}

function makeRow(id: number, overrides: Partial<ChatRow> = {}): ChatRow {
  return { id, kind: 'assistant', text: `text-${id}`, ...overrides } as ChatRow
}

function makeJobRow(id: number, status: 'running' | 'completed'): ChatRow {
  return makeRow(id, {
    kind: 'job',
    text: '',
    job: { id: `job-${id}`, kind: 'bash', label: `cmd-${id}`, status, startedAt: 1, finishedAt: status === 'running' ? undefined : 2, outputLines: [] },
  })
}

function makeOptions(overrides: Partial<VisibleRowsOptions> = {}): VisibleRowsOptions {
  return {
    showAll: false,
    thinkingVisible: true,
    turnUsageRow: false,
    expanded: false,
    expandedRows: new Set<number>(),
    jobGroupFold: 'auto',
    ...overrides,
  }
}

// ── 1. 窗口外行更新：缓存命中、窗口结果正确 ──────────────────────────────
{
  const count = 600
  const base = Array.from({ length: count }, (_, index) => makeRow(index + 1))
  base[count - 10] = makeRow(count - 9, { text: 'KEEP-WINDOW-TEXT' })
  let rows = base
  let entry: VisibleRowsCacheEntry = deriveVisibleRows(rows, makeOptions(), null)
  check('600 行：窗口起点 = 480', entry.windowStart === 480 && entry.rowCount === 600)
  check('600 行：out 只含窗口行 481..600', entry.out.length === RENDERED_ROW_CAP && entry.out[0]!.id === 481 && entry.out[entry.out.length - 1]!.id === 600)

  // 窗口外更新：替换第 3 行（含窗口外旧内容标记），另放一个会被过滤的空
  // assistant 行在窗口外。
  rows = rows.slice()
  rows[2] = makeRow(3, { text: 'OLD-OUTSIDE-CONTENT' })
  rows[3] = makeRow(4, { streaming: false, text: '   ' })
  resetVisibleWindowProbe()
  const afterOutside = deriveVisibleRows(rows, makeOptions(), entry)
  const outsideProbe = readVisibleWindowProbe()
  check('窗口外更新：缓存命中（复用同一派生对象）', afterOutside === entry)
  check('窗口外更新：不重建', outsideProbe.rebuilds === 0)
  check(
    `窗口外更新：指纹访问数 = 窗口长度 ${RENDERED_ROW_CAP}`,
    outsideProbe.fingerprintVisits === RENDERED_ROW_CAP,
    String(outsideProbe.fingerprintVisits),
  )
  check('窗口外更新：派生不访问窗口外行', outsideProbe.derivationVisits === 0, String(outsideProbe.derivationVisits))
  check('窗口外更新：结果不含窗口外旧内容', !afterOutside.out.some(row => row.text === 'OLD-OUTSIDE-CONTENT'))
  check('窗口外更新：结果不含被过滤的空 assistant 行', !afterOutside.out.some(row => row.id === 4))
  check('窗口外更新：窗口内内容保持不变', afterOutside.out.some(row => row.id === count - 9 && row.text === 'KEEP-WINDOW-TEXT'))
  check('窗口外更新：out 仍全部位于窗口内', afterOutside.out.every(row => row.id > 480 && row.id <= 600))
}

// ── 2. 窗口内行更新：内容刷新与过滤边界 ──────────────────────────────────
{
  const count = 600
  const base = Array.from({ length: count }, (_, index) => makeRow(index + 1))
  base[count - 1] = makeRow(count, { streaming: true, text: 'chunk-1' })
  const first = deriveVisibleRows(base, makeOptions(), null)
  const lastOf = (entry: VisibleRowsCacheEntry): ChatRow | undefined => entry.out[entry.out.length - 1]
  check('窗口内流式行出现在 out 末尾', lastOf(first)?.id === count && lastOf(first)?.text === 'chunk-1')

  let rows = base.slice()
  rows[count - 1] = makeRow(count, { streaming: true, text: 'chunk-1 chunk-2' })
  resetVisibleWindowProbe()
  const refreshed = deriveVisibleRows(rows, makeOptions(), first)
  const refreshedProbe = readVisibleWindowProbe()
  check('窗口内更新：重新派生', refreshed !== first && refreshedProbe.rebuilds === 1)
  check('窗口内更新：流式内容刷新（无旧文本）', lastOf(refreshed)?.text === 'chunk-1 chunk-2')
  check('窗口内更新：旧派生对象未被改写', lastOf(first)?.text === 'chunk-1')
  check(
    `窗口内更新：重建派生访问数 ≤ 5×窗口（实际 ${refreshedProbe.derivationVisits}）`,
    refreshedProbe.derivationVisits <= 5 * RENDERED_ROW_CAP,
    String(refreshedProbe.derivationVisits),
  )

  // streaming 落定且文本为空：跨过 empty-assistant 过滤边界，行消失。
  rows = rows.slice()
  rows[count - 1] = makeRow(count, { streaming: false, text: '' })
  const settled = deriveVisibleRows(rows, makeOptions(), refreshed)
  check('空文本 assistant 落定后被过滤', settled.out.length === RENDERED_ROW_CAP - 1 && !settled.out.some(row => row.id === count))
  check('落定派生结果仍保留此前窗口行', settled.out[settled.out.length - 1]!.id === count - 1)

  // thinking 过滤：窗口内 reasoning 行随开关出现/消失。
  const withReasoning = base.slice()
  withReasoning[count - 2] = makeRow(count - 1, { kind: 'reasoning', text: 'thinking...' })
  const hiddenThinking = deriveVisibleRows(withReasoning, makeOptions({ thinkingVisible: false }), null)
  const shownThinking = deriveVisibleRows(withReasoning, makeOptions({ thinkingVisible: true }), hiddenThinking)
  check('thinking 过滤：关闭时 reasoning 行不在 out', !hiddenThinking.out.some(row => row.id === count - 1))
  check('thinking 过滤：打开时重建并包含 reasoning 行', shownThinking !== hiddenThinking && shownThinking.out.some(row => row.id === count - 1))

  // turn-usage 过滤：默认关闭时 turn-summary 行不在 out。
  const withTurnRow = base.slice()
  withTurnRow[count - 2] = makeRow(count - 1, { kind: 'turn-summary', text: 'turn' })
  const hiddenTurn = deriveVisibleRows(withTurnRow, makeOptions({ turnUsageRow: false }), null)
  const shownTurn = deriveVisibleRows(withTurnRow, makeOptions({ turnUsageRow: true }), hiddenTurn)
  check('turn-usage 过滤：关闭时 turn-summary 行不在 out', !hiddenTurn.out.some(row => row.id === count - 1))
  check('turn-usage 过滤：打开时包含 turn-summary 行', shownTurn.out.some(row => row.id === count - 1))
}

// ── 3. append 移动窗口起点 ──────────────────────────────────────────────
{
  const count = 600
  const base = Array.from({ length: count }, (_, index) => makeRow(index + 1))
  const entry = deriveVisibleRows(base, makeOptions(), null)
  const appended = base.concat([makeRow(count + 1)])
  const afterAppend = deriveVisibleRows(appended, makeOptions(), entry)
  check('append 后窗口起点 = 481', afterAppend.windowStart === 481)
  check('append 后 out 首行 = 482', afterAppend.out[0]!.id === 482)
  check('append 后 out 尾行 = 601', afterAppend.out[afterAppend.out.length - 1]!.id === 601)
  check('append 后离开窗口的 481 不再出现', !afterAppend.out.some(row => row.id === 481))
}

// ── 4. 连续 job 卡折叠与展开 ────────────────────────────────────────────
{
  const count = 300
  const base = Array.from({ length: count }, (_, index) => makeRow(index + 1))
  base[count - 3] = makeJobRow(count - 2, 'completed')
  base[count - 2] = makeJobRow(count - 1, 'completed')
  base[count - 1] = makeJobRow(count, 'completed')
  const folded = deriveVisibleRows(base, makeOptions(), null)
  const jobRowsOf = (entry: VisibleRowsCacheEntry): ChatRow[] => entry.out.filter(row => row.id >= count - 2)
  check('3 个已结算 job 卡折叠为头部一行', jobRowsOf(folded).length === 1 && jobRowsOf(folded)[0]!.jobGroup?.folded === true)

  const running = base.slice()
  running[count - 1] = makeJobRow(count, 'running')
  const unfolded = deriveVisibleRows(running, makeOptions(), folded)
  check('成员转 running：重新派生并展开 3 行', unfolded !== folded && jobRowsOf(unfolded).length === 3)
  check('展开后头部汇总 running=1', jobRowsOf(unfolded)[0]!.jobGroup?.running === 1)

  const headExpanded = deriveVisibleRows(base, makeOptions({ expandedRows: new Set([count - 2]) }), folded)
  check('展开头部（expandedRows）：重新展开 3 行', headExpanded !== folded && jobRowsOf(headExpanded).length === 3)
}

// ── 5. 规模解耦：1000/3000/6000/12000 行逐帧派生的元素访问数 ─────────────
{
  const sizes = [1000, 3000, 6000, 12000]
  const frames = 100
  const rounds = 5
  const statistics: { size: number; fingerprintPerFrame: number; derivationPerFrame: number; rebuildsPerFrame: number; medianFrameMs: number }[] = []
  for (const size of sizes) {
    const stableRows = Array.from({ length: size - 1 }, (_, index) => makeRow(index + 1))
    const frameRows: ChatRow[][] = []
    for (let frame = 0; frame < frames; frame += 1) {
      const next = stableRows.slice()
      next.push(makeRow(size, { streaming: true, text: `chunk-${frame}` }))
      frameRows.push(next)
    }
    // 每个流式 delta 都换新行对象：真实场景每帧一次重建，验证重建成本也是
    // 窗口级而非总行数级。
    const perFrameMs: number[] = []
    let entry: VisibleRowsCacheEntry | null = null
    for (let round = 0; round < rounds; round += 1) {
      resetVisibleWindowProbe()
      const startedAt = performance.now()
      for (let frame = 0; frame < frames; frame += 1) entry = deriveVisibleRows(frameRows[frame]!, makeOptions(), entry)
      perFrameMs.push((performance.now() - startedAt) / frames)
    }
    const probe = readVisibleWindowProbe()
    perFrameMs.sort((a, b) => a - b)
    const medianFrameMs = perFrameMs[Math.floor(rounds / 2)]!
    const fingerprintPerFrame = probe.fingerprintVisits / frames
    const derivationPerFrame = probe.derivationVisits / frames
    const rebuildsPerFrame = probe.rebuilds / frames
    statistics.push({ size, fingerprintPerFrame, derivationPerFrame, rebuildsPerFrame, medianFrameMs })

    check(
      `${size} 行：每帧指纹访问数 = 窗口长度 ${RENDERED_ROW_CAP}`,
      fingerprintPerFrame === RENDERED_ROW_CAP,
      String(fingerprintPerFrame),
    )
    check(
      `${size} 行：每帧重建派生访问数 ≤ 5×窗口（实际 ${derivationPerFrame}）`,
      derivationPerFrame > 0 && derivationPerFrame <= 5 * RENDERED_ROW_CAP,
      String(derivationPerFrame),
    )
    check(`${size} 行：每帧重建 1 次`, rebuildsPerFrame === 1, String(rebuildsPerFrame))

    // 窗口外更新：任意规模下都只扫窗口并命中缓存。
    resetVisibleWindowProbe()
    const hitEntry = deriveVisibleRows(frameRows[0]!, makeOptions(), null)
    resetVisibleWindowProbe()
    const outside = frameRows[0]!.slice()
    outside[1] = makeRow(2, { text: 'UPDATED-OUTSIDE' })
    const hit = deriveVisibleRows(outside, makeOptions(), hitEntry)
    const hitProbe = readVisibleWindowProbe()
    check(
      `${size} 行：窗口外更新命中缓存且只扫窗口（指纹 ${hitProbe.fingerprintVisits}）`,
      hit === hitEntry && hitProbe.fingerprintVisits === RENDERED_ROW_CAP && hitProbe.rebuilds === 0,
      `visits=${hitProbe.fingerprintVisits} rebuilds=${hitProbe.rebuilds}`,
    )
    check(`${size} 行：窗口外更新后 out 长度不变`, hit.out.length === RENDERED_ROW_CAP)
  }

  const smallest = statistics[0]!
  const largest = statistics[statistics.length - 1]!
  check(
    '规模解耦：四档规模的每帧指纹访问数完全一致',
    statistics.every(item => item.fingerprintPerFrame === smallest.fingerprintPerFrame),
    statistics.map(item => `${item.size}:${item.fingerprintPerFrame}`).join(' '),
  )
  check(
    '规模解耦：四档规模的每帧重建派生访问数完全一致',
    statistics.every(item => item.derivationPerFrame === smallest.derivationPerFrame),
    statistics.map(item => `${item.size}:${item.derivationPerFrame}`).join(' '),
  )
  check(
    `耗时宽松上限：12000 行每帧中位数 ${largest.medianFrameMs.toFixed(3)} ms ≤ 2 ms`,
    largest.medianFrameMs <= 2,
    String(largest.medianFrameMs),
  )
  check(
    `耗时宽松比例：12000/1000 中位数比 ${(largest.medianFrameMs / smallest.medianFrameMs).toFixed(2)} ≤ 4`,
    largest.medianFrameMs <= Math.max(smallest.medianFrameMs * 4, 1),
    `${largest.medianFrameMs.toFixed(3)} / ${smallest.medianFrameMs.toFixed(3)} ms`,
  )

  console.log('')
  console.log('规模        每帧指纹访问   每帧重建派生访问   每帧重建   每帧中位耗时 ms   旧实现每帧扫描（两遍全量）')
  for (const item of statistics) {
    console.log(
      `${String(item.size).padStart(6)}    ${String(item.fingerprintPerFrame).padStart(12)}    ${String(item.derivationPerFrame).padStart(14)}    ${String(item.rebuildsPerFrame).padStart(8)}    ${item.medianFrameMs.toFixed(3).padStart(15)}    ${String(item.size * 2).padStart(10)}`,
    )
  }
}

// ── 7. showAll：全量渲染模式保持 O(rows)（用户显式要求，不是回归） ────────
{
  const count = 600
  const base = Array.from({ length: count }, (_, index) => makeRow(index + 1))
  resetVisibleWindowProbe()
  const all = deriveVisibleRows(base, makeOptions({ showAll: true }), null)
  const probe = readVisibleWindowProbe()
  check('showAll：窗口覆盖全部行', all.windowStart === 0 && all.out.length === count)
  check('showAll：指纹扫描整份列表（O(rows) 为设计允许）', probe.fingerprintVisits === count, String(probe.fingerprintVisits))
}

// ── 6. 真实组件渲染路径：缓存决策的接线（假 TTY + 探针计数） ─────────────
{
  interface FakeStreams {
    stdout: Writable & { columns: number; rows: number; isTTY: boolean; frames: string[] }
    stderr: Writable & { isTTY: boolean }
    stdin: PassThrough & { isTTY: boolean; setRawMode: () => unknown; setEncoding: () => unknown; ref: () => unknown; unref: () => unknown }
  }
  const makeStreams = (): FakeStreams => {
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdout.frames.push(String(chunk))
        callback()
      },
    }) as FakeStreams['stdout']
    stdout.columns = 100
    stdout.rows = 30
    stdout.isTTY = true
    stdout.frames = []
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as FakeStreams['stderr']
    stderr.isTTY = true
    const stdin = new PassThrough() as FakeStreams['stdin']
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.setEncoding = () => stdin
    stdin.ref = () => stdin
    stdin.unref = () => stdin
    return { stdout, stderr, stdin }
  }
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const fake = makeStreams()
  const messageProps = (rows: readonly ChatRow[]) => ({
    rows,
    expanded: false,
    expandedRows: new Set<number>(),
    selectedId: null,
    onToggleRow: () => {},
    model: 'verify-perf-rows-cache',
    showAll: false,
    onToggleAll: () => {},
    historyPaintEnabled: false,
    thinkingVisible: true,
  })
  const tree = (rows: readonly ChatRow[]) =>
    React.createElement(ThemeProvider, null, React.createElement(MessageList, messageProps(rows)))
  const count = 150
  const base = Array.from({ length: count }, (_, index) => makeRow(index + 1))
  const rendered = await render(tree(base), {
    stdout: fake.stdout,
    stderr: fake.stderr,
    stdin: fake.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(1200) // 固定窗:pacing 等 Ink 首帧提交落地
  check('组件渲染：首帧输出非空', fake.stdout.frames.length > 0, String(fake.stdout.frames.length))

  resetVisibleWindowProbe()
  rendered.rerender(tree(base))
  await sleep(500) // 固定窗:pacing 等 rerender 提交落地
  const sameRows = readVisibleWindowProbe()
  check(
    '组件渲染：相同 rows 重渲染命中缓存（零重建）',
    sameRows.frames >= 1 && sameRows.rebuilds === 0,
    JSON.stringify({ frames: sameRows.frames, rebuilds: sameRows.rebuilds }),
  )

  resetVisibleWindowProbe()
  const outside = base.slice()
  outside[4] = makeRow(5, { text: 'OUTSIDE-UPDATED' })
  rendered.rerender(tree(outside))
  await sleep(500) // 固定窗:pacing 等 rerender 提交落地
  const outsideRen = readVisibleWindowProbe()
  check(
    '组件渲染：窗口外更新不重建缓存（只扫窗口）',
    outsideRen.frames >= 1 && outsideRen.rebuilds === 0 && outsideRen.fingerprintVisits < 2 * RENDERED_ROW_CAP,
    JSON.stringify({ frames: outsideRen.frames, rebuilds: outsideRen.rebuilds, visits: outsideRen.fingerprintVisits }),
  )

  resetVisibleWindowProbe()
  const inside = outside.slice()
  inside[count - 1] = makeRow(count, { streaming: true, text: 'tail-updated' })
  rendered.rerender(tree(inside))
  await sleep(500) // 固定窗:pacing 等 rerender 提交落地
  const insideRen = readVisibleWindowProbe()
  check(
    '组件渲染：窗口内更新重建缓存且访问数为窗口级',
    insideRen.rebuilds >= 1 && insideRen.derivationVisits > 0 && insideRen.derivationVisits <= 5 * RENDERED_ROW_CAP,
    JSON.stringify({ rebuilds: insideRen.rebuilds, derivation: insideRen.derivationVisits }),
  )

  rendered.unmount()
  await sleep(100) // 固定窗:pacing 等卸载收尾
  check('组件渲染：卸载后仍无异常', true)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
// Ink 实例卸载后仍可能残留 measure/reveal 定时器；显式退出，避免脚本挂起。
process.exit(failures > 0 ? 1 : 0)
