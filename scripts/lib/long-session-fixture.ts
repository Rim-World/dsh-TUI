/**
 * long-session-fixture — 长会话合成 fixture（WP0 / WP5 / WP9 共用）。
 *
 * 提供三类可导入数据，全部为纯函数、无副作用、不依赖构建产物：
 *
 * 1. `buildTranscriptRows(n)`：n 条 ChatRow 形状的转录行（user / tool /
 *    assistant 混合），用于读投影、滚动与内存测量。行数即 ChatRow 条数；
 *    每行文本的行数用 `estimatedDisplayLines()` 汇总。
 * 2. `buildSessionEvents(n)`：n 条 SessionEvent 形状的会话事件（含成对的
 *    tool/call 与 tool/result），用于审批扫描、投影回放与内存测量。
 * 3. `buildApprovalScenario(n, opts)`：在 n 条事件上放置一个未决的
 *    tool/call（默认在末尾），并给出可 park() 的审批请求与 mock session。
 *
 * 尺寸常量与计划口径一致：6000/12000 行，10k/100k 事件。
 *
 * 直接运行本文件打印各 fixture 的行数/事件数与粗估字节数（自检用）：
 *   node --import tsx/esm scripts/lib/long-session-fixture.ts
 *
 * 被其他脚本导入时用字符串后缀 .js（tsx 会解析到 .ts）：
 *   const { buildTranscriptRows } = await import('./lib/long-session-fixture.js')
 */

import { pathToFileURL } from 'node:url'

/** 计划 §3.1 / WP3 验收使用的转录行尺寸。 */
export const FIXTURE_ROW_SIZES = [6000, 12000] as const
/** 计划 WP5 使用的会话事件尺寸。 */
export const FIXTURE_EVENT_SIZES = [10000, 100000] as const

/** 与 ChatRow 结构兼容的最小转录行（不 import src，脚本可独立运行）。 */
export interface FixtureRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning'
  text: string
  seq?: number
  time?: number
  streaming?: boolean
  tool?: {
    callId: string
    name: string
    argsText: string
    argsFull?: string
    status: 'running' | 'ok' | 'error'
    resultText?: string
    resultFull?: string
    errorText?: string
  }
}

export interface TranscriptRowsOptions {
  /** 每轮 user 行后的工具行数。默认 2。 */
  toolsPerTurn?: number
  /** 每轮 assistant 行内换行数。默认 4 行。 */
  assistantLines?: number
  /** 每行文本的字符数（assistant 与工具结果）。默认 48。 */
  textChars?: number
  /** 工具行额外保留的完整参数字符数（模拟真实会话的大载荷，折叠会丢弃）。未设置时不生成。 */
  fullPayloadChars?: number
  /** 起始事件时间戳。默认 0。 */
  startTime?: number
}

const repeatTo = (unit: string, chars: number): string => {
  if (chars <= 0) return ''
  let out = ''
  while (out.length < chars) out += unit
  return out.slice(0, chars)
}

/**
 * 构造 n 条转录行：user → tools → assistant 循环，不足一轮的尾部用 notice 补足，
 * 保证返回数组恰好 n 条。
 * @param rowCount - 目标 ChatRow 条数。
 * @param options - 每轮工具行数与文本密度。
 * @returns 恰好 rowCount 条 FixtureRow。
 */
export function buildTranscriptRows(rowCount: number, options: TranscriptRowsOptions = {}): FixtureRow[] {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(`buildTranscriptRows: rowCount must be a non-negative safe integer, got ${String(rowCount)}`)
  }
  const toolsPerTurn = options.toolsPerTurn ?? 2
  const assistantLines = options.assistantLines ?? 4
  const textChars = options.textChars ?? 48
  const fullPayloadChars = options.fullPayloadChars
  const startTime = options.startTime ?? 0
  const rows: FixtureRow[] = []
  for (let turn = 1; rows.length < rowCount; turn++) {
    rows.push({
      id: rows.length + 1,
      kind: 'user',
      text: `问题 ${turn}`,
      seq: rows.length,
      time: startTime + turn,
    })
    for (let t = 0; t < toolsPerTurn && rows.length < rowCount; t++) {
      const callId = `tool-${turn}-${t}`
      rows.push({
        id: rows.length + 1,
        kind: 'tool',
        text: '',
        seq: rows.length,
        time: startTime + turn,
        tool: {
          callId,
          name: t % 2 === 0 ? 'Read' : 'Bash',
          argsText: JSON.stringify({ path: `/tmp/fixture-${turn}-${t}.ts` }),
          argsFull: fullPayloadChars === undefined
            ? JSON.stringify({ path: `/tmp/fixture-${turn}-${t}.ts` })
            : JSON.stringify({ path: `/tmp/fixture-${turn}-${t}.ts`, content: repeatTo('x', fullPayloadChars) }),
          status: 'ok',
          resultText: repeatTo(`结果 ${turn}-${t} `, textChars),
          ...(fullPayloadChars === undefined ? {} : { resultFull: repeatTo(`完整结果 ${turn}-${t} `, fullPayloadChars) }),
        },
      })
    }
    if (rows.length < rowCount) {
      const lines: string[] = []
      for (let line = 0; line < assistantLines; line++) {
        lines.push(repeatTo(`回复 ${turn} 第 ${line + 1} 行 `, textChars))
      }
      rows.push({
        id: rows.length + 1,
        kind: 'assistant',
        text: lines.join('\n'),
        seq: rows.length,
        time: startTime + turn,
      })
    }
  }
  return rows
}

/** 汇总 FixtureRow[] 的可见文本行数（按 \n 切分，空文本记 1 行）。 */
export function estimatedDisplayLines(rows: readonly FixtureRow[]): number {
  let lines = 0
  for (const row of rows) {
    lines += row.text === '' ? 1 : row.text.split('\n').length
    const result = row.tool?.resultText
    if (result !== undefined && result !== '') lines += result.split('\n').length
  }
  return lines
}

/** 与 SessionEvent 结构兼容的事件（不 import src，脚本可独立运行）。 */
export interface FixtureSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export interface SessionEventsOptions {
  /** 每隔多少个事件放一个 tool/call。默认 12。 */
  toolEvery?: number
  /** tool/call 之后隔多少个事件放配对的 tool/result。默认 5。 */
  resultGap?: number
  /** 起始时间戳。默认 0。 */
  startTime?: number
  /** callId 前缀，默认 fixture-call。 */
  callIdPrefix?: string
}

/** 非工具事件类型循环，贴近真实会话日志的骨架事件。 */
const SKELETON_TYPES = [
  'turn/start',
  'step/start',
  'message/user',
  'message/assistant',
  'message/assistant',
  'step/end',
  'turn/end',
  'session/title',
  'usage/update',
  'message/assistant',
] as const

/**
 * 构造 n 条会话事件，其中 tool/call 与 tool/result 成对出现（tool/result 的
 * `data.message.source.callId` 指向配对调用），其余为骨架事件。
 * @param eventCount - 目标事件条数（恰好）。
 * @param options - 工具事件密度与 callId 前缀。
 * @returns 恰好 eventCount 条事件，seq 连续（0..n-1）。
 */
export function buildSessionEvents(eventCount: number, options: SessionEventsOptions = {}): FixtureSessionEvent[] {
  if (!Number.isSafeInteger(eventCount) || eventCount < 0) {
    throw new Error(`buildSessionEvents: eventCount must be a non-negative safe integer, got ${String(eventCount)}`)
  }
  const toolEvery = Math.max(1, options.toolEvery ?? 12)
  const resultGap = Math.max(1, options.resultGap ?? 5)
  const startTime = options.startTime ?? 0
  const callIdPrefix = options.callIdPrefix ?? 'fixture-call'
  const events: FixtureSessionEvent[] = []
  const pending: { callId: string; index: number; name: string; arguments: string }[] = []
  let skeletonIndex = 0
  let callIndex = 0
  while (events.length < eventCount) {
    const seq = events.length
    const time = startTime + seq
    const next = pending[0]
    if (next !== undefined && seq - next.index >= resultGap) {
      pending.shift()
      events.push({
        type: 'tool/result',
        seq,
        time,
        data: {
          turn: 0,
          step: 0,
          message: { role: 'tool', source: { callId: next.callId }, content: [{ type: 'text', text: `tool result ${next.callId}` }] },
        },
      })
      continue
    }
    if (seq % toolEvery === 0) {
      const callId = `${callIdPrefix}-${callIndex++}`
      const name = callIndex % 2 === 0 ? 'Bash' : 'Read'
      const args = JSON.stringify({ command: `echo fixture-${callId}`, file_path: `/tmp/${callId}.ts` })
      pending.push({ callId, index: seq, name, arguments: args })
      events.push({
        type: 'tool/call',
        seq,
        time,
        data: { turn: 0, step: 0, callId, name, arguments: args },
      })
      continue
    }
    const type = SKELETON_TYPES[skeletonIndex++ % SKELETON_TYPES.length]!
    events.push({
      type,
      seq,
      time,
      data: type.startsWith('message/')
        ? { role: type === 'message/user' ? 'user' : 'assistant', content: [{ type: 'text', text: `fixture ${seq}` }] }
        : { turn: Math.floor(seq / 8), step: seq % 8 },
    })
  }
  return events
}

/** 追加一条 tool/call，返回新事件（seq 取当前长度）。 */
export function appendToolCall(
  events: FixtureSessionEvent[],
  callId: string,
  toolName = 'Bash',
  args: Record<string, unknown> = { command: 'echo fixture-approval' },
): FixtureSessionEvent {
  const seq = events.length
  const event: FixtureSessionEvent = {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 0, step: 0, callId, name: toolName, arguments: JSON.stringify(args) },
  }
  events.push(event)
  return event
}

/** 追加一条 tool/result，返回新事件（seq 取当前长度）。 */
export function appendToolResult(events: FixtureSessionEvent[], callId: string): FixtureSessionEvent {
  const seq = events.length
  const event: FixtureSessionEvent = {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 0,
      step: 0,
      message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: `tool result ${callId}` }] },
    },
  }
  events.push(event)
  return event
}

/** 可被 snapshotLiveSessionEvents 识别的 mock session（modern / legacy 两种形状）。 */
export type FixtureSessionShape = { snapshotEvents: () => readonly FixtureSessionEvent[] } | { events: FixtureSessionEvent[] }

/** 按形状包装事件数组为 mock Session。 */
export function sessionStub(events: FixtureSessionEvent[], shape: 'snapshot' | 'events' = 'snapshot'): FixtureSessionShape {
  if (shape === 'events') return { events }
  return { snapshotEvents: () => events }
}

export interface ApprovalScenarioOptions {
  /** live tool/call 的位置：'tail'（末尾，默认）、'middle'（中点），或显式下标。 */
  callAt?: 'tail' | 'middle' | number
  /** 是否给该调用补一条 tool/result（true = 已结算，审批应标 external）。 */
  settled?: boolean
  /** callId，默认 fixture-live-call。 */
  callId?: string
  /** 工具名，默认 Bash。 */
  toolName?: string
  /** 命令参数，默认 echo fixture-approval。 */
  command?: string
  /** 依据的事件尺寸；callAt 为 'tail'/'middle' 时使用。 */
  totalEvents: number
  /** mock Session 形状，默认 snapshot。 */
  shape?: 'snapshot' | 'events'
  /** 生成事件时的工具密度，透传 buildSessionEvents。 */
  toolEvery?: number
}

export interface ApprovalScenario {
  /** 会话事件（tool/call 与可选 tool/result 已放入）。 */
  events: FixtureSessionEvent[]
  /** 未决（或已结算）调用的 callId。 */
  callId: string
  /** tool/call 在 events 中的下标。 */
  callIndex: number
  /** mock Session（agent.session）。 */
  session: FixtureSessionShape
  /** 可直接交给 ApprovalStore.park() 的请求形状。 */
  request: {
    agent: { id: string; session: FixtureSessionShape }
    toolName: string
    callId?: string
    reason?: string
  }
}

/**
 * 构造审批测量场景：先铺 totalEvents 条骨架事件，再把 live tool/call
 * 插到指定位置（默认末尾）。settled=true 时随后补 tool/result。
 * @param options - 场景形状。
 * @returns 场景对象（events/session/request 共享同一数组引用）。
 */
export function buildApprovalScenario(options: ApprovalScenarioOptions): ApprovalScenario {
  const { totalEvents } = options
  const callId = options.callId ?? 'fixture-live-call'
  const toolName = options.toolName ?? 'Bash'
  const command = options.command ?? 'echo fixture-approval'
  const events = buildSessionEvents(Math.max(1, totalEvents - (options.settled === true ? 2 : 1)), {
    toolEvery: options.toolEvery,
  })
  const requested = options.callAt ?? 'tail'
  const callIndex = requested === 'tail'
    ? events.length
    : requested === 'middle'
      ? Math.floor(events.length / 2)
      : Math.max(0, Math.min(events.length, requested))
  const call: FixtureSessionEvent = {
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 0, step: 0, callId, name: toolName, arguments: JSON.stringify({ command }) },
  }
  events.splice(callIndex, 0, call)
  if (options.settled === true) {
    const result: FixtureSessionEvent = {
      type: 'tool/result',
      seq: 0,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: `tool result ${callId}` }] },
      },
    }
    events.splice(callIndex + 1, 0, result)
  }
  for (let i = 0; i < events.length; i++) {
    events[i]!.seq = i
    events[i]!.time = i
  }
  const session = sessionStub(events, options.shape ?? 'snapshot')
  return {
    events,
    callId,
    callIndex: events.findIndex(event => event.type === 'tool/call' && event.data['callId'] === callId),
    session,
    request: {
      agent: { id: 'fixture-agent', session },
      toolName,
      callId,
      reason: 'fixture approval scenario',
    },
  }
}

/**
 * 构造一条不属于该会话的审批请求（callId 在日志中不存在）：用于测量倒扫的
 * 最坏情况（全量扫描）与 external 徽标判定。日志只读，不修改传入事件。
 */
export function buildUnknownCallScenario(totalEvents: number, options: { shape?: 'snapshot' | 'events' } = {}): {
  events: FixtureSessionEvent[]
  callId: string
  session: FixtureSessionShape
  request: ApprovalScenario['request']
} {
  const events = buildSessionEvents(totalEvents)
  const callId = 'fixture-unknown-call-not-in-log'
  const session = sessionStub(events, options.shape ?? 'snapshot')
  return {
    events,
    callId,
    session,
    request: { agent: { id: 'fixture-agent', session }, toolName: 'Bash', callId, reason: 'fixture unknown call scenario' },
  }
}

const isDirectRun = (): boolean => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return pathToFileURL(entry).href.endsWith('long-session-fixture.ts')
}

if (isDirectRun()) {
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
  console.log('long-session-fixture 自检')
  for (const rows of FIXTURE_ROW_SIZES) {
    const built = buildTranscriptRows(rows)
    console.log(`  rows=${built.length}  textLines=${estimatedDisplayLines(built)}  json≈${(bytes(built) / 1048576).toFixed(1)}MB`)
  }
  for (const events of [10000, 100000] as const) {
    const built = buildSessionEvents(events)
    console.log(`  events=${built.length}  json≈${(bytes(built) / 1048576).toFixed(1)}MB`)
  }
  const scenario = buildApprovalScenario({ totalEvents: 100000 })
  console.log(`  approval scenario: events=${scenario.events.length} callIndex=${scenario.callIndex} tailDistance=${scenario.events.length - 1 - scenario.callIndex}`)
}