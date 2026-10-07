# dsh-rewind-pro

[English](README.en.md) · DeepSeek Harness（DSH）会话回退插件 —— **回退不再是有去无回**。

## 这是什么

给 DSH 装上"可撤销的时间旅行"：

- **对话版本树 + 翻页器** — 每一轮都有自己的**输入版本链**和**回复版本链**：改一次输入就是一个新输入版本，重跑一次就多一个回复版本，两者各自用 `‹ n/N ›` 翻页。**旧版本一条都不删**，翻回去时后面的整条后缀原样回来。当前分支 = 从根开始，每轮取"选中回复 → next"一路走到底。
- **两阶段可取消回退** — 用户消息旁的 ↶ 按钮先进入 pending：打断正在运行的回合、遮住尾部消息、把目标消息文本填进输入框。**发送才真正回退**，点 ✕ 完全取消，连你刚才打到一半的草稿都会原样还给你。
- **撤销回退 + 回退历史**（核心差异化）— 每次回退都可撤销；历史面板能跳回任意节点。撤销前会分级评估：干净 → 直接撤；有分歧 → 强制二次确认并告诉你差几轮；宿主不支持 → 明说不可逆，提供只读查看。
- **工作区文件还原** — 每次写文件前先做检查点（含子代理的写入）。回退时逐文件哈希比对、幂等还原；内容有分叉的**先移入 rescue 目录再覆盖**，永远不会丢数据；崩溃中断的还原操作会在下次启动时续完。
- **诚实的影响清单** — 回退前告诉你会撤回几轮、还原哪些文件，以及**区间内有几次 shell 调用无法撤销**。
- **多策略遮蔽 + 版本自愈** — 优先可逆的 derive-patch，探测不到就降级 surface-op / ui-only；DSH 升级后能力缓存自动失效、策略静默升级。
- **`/rewind` 命令族** — 候选列表（键盘导航）、`/rewind-undo`、`/rewind-history`、`/rewind-export-clean`（净化导出：删掉被回退的轮次，但明确声明删了什么）。
- **多标签页同步** — ledger 单调 version + 回显抑制，SSE + BroadcastChannel 双通道。
- **不变量** — 会话日志 append-only，从不删改原始事件；所有 JSON 原子写；所有失败都是状态码，绝不抛穿宿主。

## 安装

```bash
dsh plugin --profile web add dsh-rewind-pro
# 或本地路径
dsh plugin --profile web add e:/path/to/dsh-rewind
```

配置默认值见 `cordis.patch.yml`（strategy / snapshot / trackSubagent / maxAnchorGroups / maxFileBytes / rescueRetention / apiPrefix），均可按 profile 覆盖。

## 开发

```bash
npm install
npm run check        # typecheck + vitest + build + 端到端 verify-host + pack 干跑
npm run check:version
```

- 运行时零依赖：host 只用 Node 内置模块，client 从宿主冻结模块表取 React。
- 测试：`tests/host`（Node）+ `tests/client`（happy-dom）。
- 端到端：`npm run verify:host` 用构建产物在真实 socket 上跑完 mark → cancel → commit → 文件还原 → undo → jump 全链路。

## 文档

- [架构](docs/architecture.md) — 两半结构、两阶段回退、撤销分级、快照引擎
- [落盘格式](docs/format.md) — ledger / anchor / journal / rescue 的精确格式
- [兼容性审计](docs/compat/audit.md) — 哪些宿主接口是探测的、哪些还未实机验证
- [客户端契约](docs/contract/client-contract.md) — HTTP/SSE/slots 的完整契约

## 兼容性

目标宿主：DSH `0.2.0-rc.2`（本地实机实测，cordis 4.0.4）。宿主接口以**运行时探测**绑定，未探测到的能力一律降级而不是崩溃；详见兼容性审计文档。

移植到 0.2.0-rc.2 时修正的宿主契约（1.x 时代的写法在这里已经失效）：

- **webServer 挂载**：`ctx.inject(deps, cb)` 的回调收到的是**子 context**，不是服务对象。
  必须读 `child.webServer`，并在 `child.effect(...)` 里注册路由，让路由随 fiber 注销。
  （旧写法把回调实参当 service 读 `.register`，在 cordis 4 上直接抛
  `cannot get property "register" without inject`，路由静默不挂载。）
- **斜杠命令**：注册表在 `commands` 服务上（`ctx.commands.register({name, description, handler})`，
  handler 返回 `{kind:'success'|'error', text}`）。宿主 ctx 上从来没有 `registerCommand` 方法。
- **surfaceOp**：遮蔽载荷是 `{op:'replace', startSeq, endSeq}`；旧的 `{start,end}`
  会被 `Session.append` 以 `carries an invalid replace surfaceOp` 拒绝。
- **服务读取**：可选服务走 `ctx.get(name, false)`，不需要 inject 声明；
  对未注入服务的普通属性读取在 cordis 4 上会抛错。
- **`session.snapshotEvents()`** 已被宿主标记 deprecated，但没有同步替代
  （`eventAt` / `ownEvents` 同样 deprecated，正式的 `ctx.sessionQuery.readSession()` 是异步的）。
  控制器的读路径是同步的，因此按宿主政策暂留，并集中隔离在 `src/host/adapter.ts` 的
  `sessionToMessages` 单一接缝处。
- **`session/event` 是位置参数**：签名是 `(session, event)`，不是单个 `{session, event}` 对象。
  按对象解构会两个都拿到 `undefined`，handler 静默 return——文件检查点与"提交回退"整条链
  因此完全失效。
- **`ctx.root` 是 Context，不是目录**：cordis 里 `this.root = self`。把它 `path.join` 进状态
  目录会抛 `ERR_INVALID_ARG_TYPE`，而 `apply()` 的外层 try/catch 会把这个错吞掉——于是插件
  "加载成功"却什么都没做。状态根以 `DSH_HOME` 为基准（可用 `stateDir` 覆盖）。
- **不要导出 `default`**：加载器的 `unwrapExports` 会 `exports = exports.default ?? exports`，
  再对没有 `__esModule` 的值直接返回。如果 `default` 是裸的 `apply` 函数，加载器就只挂载那个
  函数，**同模块命名空间的 `inject` 与 `name` 会被丢弃** → fiber 的 inject 为空 →
  `ctx.sessions` 读不到 → 适配器降级为空实现。本模块只 `export { apply, inject, name, ... }`。
- **条目配置是 `apply` 的第二个参数**：cordis 调用 `runtime.callback(ctx, config)`。
  只在 `ctx.model.config['<name>']` 里找配置会让 profile 的全部设置（`workspaceRoot`、
  `snapshotDir`、`apiPrefix`、各开关）被静默忽略，插件转而写进默认的 DSH home。

有一条教训值得写下来：`scripts/verify-host.mjs` 的假宿主必须**照抄真实契约**（回调收子
context、命令走 `ctx.commands.register`、事件是位置参数、不导出 `default`、配置走第二个
参数）。它此前是按插件自身的假设搭的台，所以上面每一条都"自检通过"，却在真实宿主上全部失效。

## License

[MIT](LICENSE)
