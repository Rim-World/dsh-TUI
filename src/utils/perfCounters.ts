/**
 * 显式开启的性能计数器（WP0）。
 *
 * 只做计数，不在热路径放 performance.now()；输出只走 stderr，不写 stdout。
 * 开关：DSH_TUI_PERF_COUNTERS=1。默认关闭时每个调用只多一次布尔判断。
 *
 * 计数器名（供脚本与报告引用）：
 * - channel.versionBumps  read-view 看到的 channel.version 递增次数
 * - channel.markDirty     markChannelReadDirty 调用次数
 * - readview.visits       进入 copy() 的对象访问次数
 * - readview.copies       实际新建的冻结拷贝数（含数组/Map/Set/函数包装）
 */
const enabled = process.env.DSH_TUI_PERF_COUNTERS === '1'
const counters = new Map<string, number>()

export function perfCountersEnabled(): boolean {
  return enabled
}

export function perfCount(name: string, delta = 1): void {
  if (!enabled) return
  counters.set(name, (counters.get(name) ?? 0) + delta)
}

export function perfValue(name: string): number {
  return counters.get(name) ?? 0
}

export function perfReset(): void {
  counters.clear()
}

export function perfReport(): string {
  const names = [...counters.keys()].sort()
  return names.length === 0 ? 'perf-counters: (empty)' : names.map(name => name + '=' + String(counters.get(name))).join('\n')
}

export function perfLog(): void {
  if (enabled) process.stderr.write(perfReport() + '\n')
}
