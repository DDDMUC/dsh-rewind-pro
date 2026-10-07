// 失败原因必须**能指导下一步动作**。
//
// 真实踩到的场景：宿主半还没重新加载（插件宿主模块被进程按 id 持有，卸载再挂载
// 不会重新 import），此时路由返回 404。原先把这句话原样丢给用户
// （"宿主拒绝了这次分页重跑（HTTP 404）"），看了也不知道该做什么。
// 这里把每种已知失败翻译成一句"看得懂 + 知道下一步"的话。

import { describe, expect, it } from 'vitest'
import { branchFailureReason } from '../../src/client/contract'

describe('branchFailureReason', () => {
  it('404 = 宿主半没加载：说明要重启，并明说这一步没有生效', () => {
    const reason = branchFailureReason(404, undefined)
    expect(reason).toContain('重启')
    expect(reason).toContain('没有生效')
  })

  it('400/409 带上宿主给的原因（stale / bad-target 之类要原样看得见）', () => {
    expect(branchFailureReason(409, 'stale: expected seq 5, found 7')).toContain('stale')
    expect(branchFailureReason(400, 'bad-target')).toContain('bad-target')
  })

  it('连不上宿主（status 0）时说清是没连上，而不是"被拒绝"', () => {
    const reason = branchFailureReason(0, undefined)
    expect(reason).toContain('连不上')
  })

  it('未知状态码也带上状态码，便于排查', () => {
    expect(branchFailureReason(500, undefined)).toContain('500')
  })
})
