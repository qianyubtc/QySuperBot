# 自有聊天项目最小接入示例

这个示例用原生 HTTP Request/Response 对象，在同一 Node.js 进程中模拟“你的聊天项目”和“超级机器人核心”的双向通信。实际使用运行时校验、带 Key-Id/用途的 HMAC、防重放、权限范围比对、审核门禁、执行尝试状态机与群发现；不启动监听端口、不连接真实群。

## 运行

在仓库根目录执行：

```sh
npm ci
npm run demo
```

预期结果：command_status 为 succeeded，重复上报后的消息数为 1，篡改请求的 HTTP 状态为 401，discovered_conversations 为 1。

## 消息路径

1. 自有项目生成一个 message.created 事件，使用事件密钥签名。
2. 核心接收 `/api/v1/connector-events`，验证签名、来源范围、事件载荷并去重。
3. 示例业务等待审核结果并通过 authorizeSync 检查，再创建确认回复和 attempt_number=1 的不可变指令，保存到内存 outbox。
4. 核心用独立指令密钥调用项目的 `/superbot/v1/commands`。
5. 项目验证目标、幂等键与期限，模拟发消息并返回平台消息标识。
6. 再次上报同一事件，返回原处理结果，不重复发送。
7. 核心用 control 用途签名 GET `/superbot/v1/conversations`，取得群名、人数覆盖、能力及当前账号权限，即使该群还没有收到消息也可以发现它。

确认回复只是演示业务；默认审核策略固定返回 allowed，不提供真正的广告识别。测试通过注入阻塞/拒绝策略验证未审核不外发。正式接入时将权威审核决定、消息版本和 outbox 持久化，执行前再次检查。已发送消息的 outgoing 回流、携带 trace 的转发事件不再触发本示例的自动回复。

## 迁移到你的项目

如果现有项目使用 Node.js，可以复用 `packages/contracts/src` 的 Schema 与签名工具。其他语言按协议文档实现相同的 JSON 格式、签名字节序列和幂等语义。

- 在现有项目的消息创建、编辑、撤回和成员变更入口生成事件，稳定保存 event_id 后投递。
- 在现有 HTTP 框架中挂载指令处理端点，保留原始请求体做签名验证，再解析 JSON。
- 从服务端凭据配置确定账号和允许的群，再执行操作；不使用请求自报的身份选择权限。
- 用真实发消息方法替换示例的 `messages.push`，返回实际消息 ID。执行结果不确定时返回 unknown。
- 指令按稳定业务操作和编号连续的执行尝试持久保存，禁止因服务重启遗忘已执行操作；unknown 先核对，明确无副作用且可重试才创建新 attempt。原子 nonce 存储用 Redis 等实现。
- 将直接调用 handleCommand 的部分替换为受控 HTTPS Webhook 投递。同次尝试重投保持全部载荷不变，每次重新签名；新尝试使用新 attempt_id/number，保留原业务意图、command_id 与幂等键。
- 预注册 Key-Id 与账号/用途范围，签名用途由端点确定；接入握手、session、心跳、权限变化与稳定分页快照。
- 将账号视角的会话映射到核心逻辑群，用规范事件生成 trace；调用 startTrace(logicalConversationId, canonicalEventId)，不能按昵称或文本认定同一事实。
- 对接真实会话与成员查询、附件资源、登录鉴权和有效权限发现，后台才能展示它们。

示例只授权一个账号的一个逻辑群，只执行普通 message.send，并返回一页群发现。按钮、条件解除限制、账号握手等已定义契约和测试，示例未执行真实平台操作。密钥运行时随机生成，没有持久化、任务调度、真实数据库或正式网络投递。生产接入以 [架构设计](../../docs/architecture.md) 和 [连接器协议](../../docs/connector-protocol.md) 为准。
