// 「哪一行」的唯一定义。
//
// 三个入口都要回答同一个问题——某个 DOM 元素属于哪一条用户消息：
//   * 翻页器（collect）把行绑进版本树；
//   * 锚点（findAnchors）把行对到宿主日志里的 seq；
//   * 桥接（bridgeForeignEditor）把**它的**编辑框反解回某一行。
//
// 真机 DOM 里一条消息是**嵌套的两层**（外层 flow div + 内层
// input-message div），三个入口天然会落在不同层上。原来三处各写一套规则
// （并集+去重 / 第一个命中的选择器 / 未去重的原始列表），于是同一条消息被
// 认成三个不同元素：按元素身份一比对就全部对不上——真机上这就是
// "这一行还没进我的版本树"（桥接反解落到了被去重丢掉的那一层）。
//
// 因此这里只保留一条规则：**同一层里只认最外层**，另外给一个把"可能是
// 另一层的元素"归一回绑定行的函数。三处都用它，身份才可能对上。

/**
 * 只保留**最外层**的匹配元素。
 *
 * 一条消息在真实 DOM 里是嵌套的几层（外层 flow div 带 data-chat-node-key，
 * 里面还有 <section data-turn-trigger>），多个选择器会同时命中它们 —— 那样
 * 同一条消息会被当成好几轮，翻页器也会重复注入。按"谁包含谁"去重即可。
 */
export function outermost<T extends HTMLElement>(elements: readonly T[]): T[] {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)))
}

/**
 * 把某个元素归一到**绑定行**上；认不出来返回 null。
 *
 * 先找它自己，再找"装着它的那一行"（它在更外层被认出来），最后找"被它装在
 * 里面的那一行"（它在更内层被认出来）。两个方向都要：桥接反解落在哪一层
 * 取决于对方的实现，我们不可能预先知道。
 *
 * 认不出来就是真的认不出来（例如"加载更早"插进来的历史行，版本树刻意不碰
 * 它们）—— 那时调用方必须拒绝，而不是猜一行。
 */
export function normalizeRow<T extends HTMLElement>(rows: readonly T[], element: HTMLElement): T | null {
  if (rows.length === 0) return null
  const exact = rows.find((row) => row === element)
  if (exact) return exact
  const ancestor = rows.find((row) => row.contains(element))
  if (ancestor) return ancestor
  const descendant = rows.find((row) => element.contains(row))
  return descendant ?? null
}
