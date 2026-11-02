/**
 * #901 P1 回归：agentViewRows 快照身份稳定。
 *
 * Chat 用 useSyncExternalStore 读 channel.agentViewRows()，React 在每次 commit
 * 比对快照。投影层（agent-view-projection.ts 的 rowsCache）在 notify 前返回
 * 同一数组；本回归断言 adapter/channel/ui.ts 的投影结果也保持同一身份：
 *   1. 同一 version 重复读：身份相同；
 *   2. 无关 version 递增（agent 数据未变）：身份相同；
 *   3. 源数组换新（notify 后）：身份变化，内容更新可见；
 *   4. lease 结束后读取抛错；
 *   5. 旧快照不可变（Object.isFrozen）。
 *
 * Run: node --import tsx/esm scripts/verify-perf-agent-view-identity.ts
 */
import assert from 'node:assert/strict'

const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')

let checks = 0
const check = (name: string, ok: boolean): void => {
  checks += 1
  if (!ok) throw new Error('FAIL ' + name)
  console.log('ok   ' + name)
}

type Row = { id: string; status: string }
const row = (id: string, status = 'idle'): Row => ({ id, status })

let source: readonly Row[] = [row('a'), row('b')]
const raw = {
  version: 0,
  agentViewRows: () => source,
  subscribeAgentView: () => () => undefined,
} as never
const lease = createChannelUiLease(() => true)
const ui = createChannelUi(raw as never, 'legacy', lease)

// 1. 同一 version 重复读：身份相同（read-view 既有行为）。
const first = ui.agentViewRows()
check('同 version 重复读身份稳定', first === ui.agentViewRows())
check('投影结果冻结', Object.isFrozen(first) && Object.isFrozen(first[0]!))
check('内容正确', first.length === 2 && first[0]!.id === 'a')

// 2. 无关 version 递增：源数组未变，投影身份必须保持。
const rawVersioned = raw as unknown as { version: number }
rawVersioned.version = 1
const second = ui.agentViewRows()
check('无关 version 递增后身份稳定', second === first)

rawVersioned.version = 42
check('连续 version 递增后身份稳定', ui.agentViewRows() === first)

// 3. notify 后源数组换新：身份变化，内容更新。
source = [row('a', 'needs-input'), row('b'), row('c')]
const third = ui.agentViewRows()
check('源数组换新后身份变化', third !== first)
check('新内容可见', third.length === 3 && third[0]!.status === 'needs-input')
check('旧快照不被改写', first.length === 2 && first[0]!.status === 'idle')
check('旧快照仍冻结', Object.isFrozen(first))

// 4. 同一新源数组的重复读仍然稳定。
check('新源数组重复读身份稳定', ui.agentViewRows() === third)

// 5. lease 结束后读取抛错。
lease.dispose()
let threw = false
try {
  ui.agentViewRows()
} catch (error) {
  threw = error instanceof Error && /lifetime/i.test(error.message)
}
check('lease 结束后读取抛错', threw)

console.log('\n' + checks + '/' + checks + ' checks passed')
