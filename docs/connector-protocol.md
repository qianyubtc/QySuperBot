# 连接器协议 v1 草案（修订 0.2）

协议用于 Telegram、QQ、币安、X 与自有聊天系统和核心之间的边界。当前实现是 [运行时 Schema 与类型](../packages/contracts/src/schema.ts)，示例实现见 [handlers.ts](../examples/custom-chat/handlers.ts)。生产 HTTP 路由与持久化尚待实现。

协议使用 schema_version `1`，握手 protocol_revision `0.2`。载荷与签名规则以本文件和 `packages/contracts` 中的 Schema 为准。

## 身份与版本

- `schema_version` 固定为字符串 `"1"`。当前解析器拒绝未知字段和版本；新事件、动作或字段需先部署支持它们的接收端，再协商启用。
- 连接器类型可注册，例如 `telegram`、`qq-onebot`、`binance-chat`、`x-community`、`custom-teamchat`；类型名不写死在事件协议里。
- `connector_id` 标识连接器实例，`account_id` 标识该实例中的账号，`conversation_id` 为账号视角的会话标识。
- 所有平台 ID 使用非空字符串，不转成 JavaScript Number。显示名不能代替身份。
- 时间为 ISO 8601 UTC，使用 `Z` 结尾。HTTP 签名时间则为 Unix 秒。
- 密钥在服务端绑定连接器、账号和允许的会话。请求体中的身份必须与绑定比对，签名有效也不能越权。
- 核心为经过确认的群分配 logical_conversation_id。不同账号的绑定可指向同一逻辑群；路由、审核和业务投递使用逻辑群，平台操作才选择账号绑定。连接器自报的逻辑标识不能直接作为绑定依据。

## 能力发现

连接器声明下列能力的 supported / unsupported / unknown，以及原因：

```text
conversations.list   messages.read     messages.send
messages.delete      messages.hide    members.list
members.mute         members.remove   members.ban
members.release_conditionally         membership.review
interactions.buttons                  interactions.ack
```

`conversationSchema` 还包含会话类型（group/community/channel/direct/other）、名称、可为空的成员数和观测时间。capabilities 声明平台支持，permissions 分别声明当前账号的 granted / denied / unknown 权限。未声明、未知或冲突的条目不能获得有效能力。hasEffectiveCapability 检查两者交集，工作空间与群策略还需在核心授权。

`reply_to` 表示引用消息，`thread_id` 表示所属讨论串，连接器明确声明是否保留它们。带按钮的发送同时需要 messages.send 和 interactions.buttons；解除限制需要 members.mute 和 members.release_conditionally，不能用单一发消息/禁言权限替代。

## 账号与群发现

管理员预先注册连接器及凭据；握手不能自行获得工作空间或群管理权限。[control.ts](../packages/contracts/src/control.ts) 定义以下契约：

| 方向与端点 | 契约与处理 |
| --- | --- |
| 连接器 → 核心：POST /api/v1/connectors/handshake | handshakeSchema：连接器/账号、实例 ID、类型、协议修订、显示名与能力。核心返回绑定该账号的 session_id 与租约到期时间 |
| 连接器 → 核心：POST /api/v1/connectors/heartbeat | heartbeatSchema：session_id、递增 sequence、连接状态、观测时间、最后事件时间 |
| 核心 → 连接器：GET /superbot/v1/conversations | conversationPageSchema：账号、session_id、snapshot_id、revision、items、next_cursor、coverage 与时间 |
| 核心 → 连接器：GET /superbot/v1/members?conversation_id=... | memberPageSchema：群成员、角色、可为空的入群批次、分页快照和覆盖范围 |
| 连接器 → 核心：POST /api/v1/connectors/permissions | permissionSnapshotSchema：指定群的当前权限、session_id、revision 与时间；权限变化时推送，也在群发现快照中刷新 |

旧 session、同 session 非递增序号/版本以及账号不匹配的状态更新不能覆盖新状态。连接租约超时显示离线/未知并停止新任务；恢复后先刷新权限与未确认任务。状态消息不能改变身份授权。

查询参数为 cursor、snapshot_id、limit（1–100）。携带 cursor 时必须指定同一个 snapshot_id；过期游标返回明确错误后重新发现。核心遍历完同一快照的全部页面且 coverage=complete 后，才能认定缺席的群/成员已移除；partial 或失败不能清空旧数据。比较 revision 的作用域为账号/session/对象，不能只比较跨实例时间戳。

这些端点使用 control 用途签名。GET 的 body 是空字节，签名仍覆盖完整 query；响应中的账号、群和 session 也要与请求授权范围核对。当前示例实现一页群发现；握手、心跳、成员和权限推送已有 Schema，正式服务端点后续建设。历史消息补取是独立能力，尚未承诺完整覆盖。

## 事件上报：聊天项目 → 核心

`POST /api/v1/connector-events`，原始 JSON 请求体使用事件方向密钥签名。

```json
{
  "schema_version": "1",
  "event_id": "evt-001",
  "occurred_at": "2026-10-26T15:10:00.000Z",
  "source": {
    "connector_id": "custom-teamchat",
    "account_id": "bot-1",
    "conversation_id": "group-42"
  },
  "type": "message.created",
  "data": {
    "message_id": "msg-100",
    "sender_id": "user-8",
    "direction": "incoming",
    "segments": [{ "type": "text", "text": "大家好" }]
  }
}
```

当前支持的事件：

| type | data |
| --- | --- |
| message.created / message.edited | message_id、sender_id、direction、segments；可选 reply_to、thread_id |
| message.deleted | message_id |
| member.joined / member.left | user_id、membership_id（本次入群批次） |
| membership.requested | request_id、user_id |
| interaction.created | interaction_id、user_id、value、expires_at、acknowledged；可选 message_id |

`event_id` 表示某次事实事件，在连接器/账号范围内唯一；重投同一事件时保持不变。消息的创建、不同编辑和撤回使用各自的 event_id，关联同一 message_id。`direction=outgoing` 用来标识接入账号自己的发送回流；普通用户消息为 incoming。

membership_id 必须随退出后再次加入而变化。平台没有此 ID 时，由桥接层持久生成并由核心关联；无法确认批次时，不自动执行旧验证的处罚或解除限制。多个观察账号的原始事件经核心确认平台消息/版本后映射为 canonical_event_id，不能将跨账号的原始 event_id 直接当作同一事实。

interaction.created 保留点击者和原始回调标识，核心将 value 解析为绑定用户、群、入群批次和期限的一次性挑战。连接器优先在平台期限内本地应答回调并标记 acknowledged=true，再投递业务事件；需要核心应答时使用高优先级 interaction.ack，expires_at 不得晚于交互期限。已应答不等于验证已通过。

内容段包括 text、image（asset_id、可选 alt）、file（asset_id、name）、mention（user_id）。附件通过受控资源标识引用；资源归属与上传协议后续细化，接收端不直接下载任意用户提供的 URL。

正式核心在持久接收后返回 HTTP 202 与 event_id、接收状态；重复事件返回原接收结果并标记 duplicate。当前本地示例同步执行完整流程，返回 HTTP 200、event_id、duplicate 和示例执行回执。

## 执行指令：核心 → 聊天项目

`POST /superbot/v1/commands` 为自有聊天项目需要实现的指令 Webhook，使用独立的指令方向密钥签名。

```json
{
  "schema_version": "1",
  "command_id": "cmd-001",
  "idempotency_key": "delivery-001",
    "attempt_id": "attempt-001",
    "attempt_number": 1,
    "logical_conversation_id": "logical-group-42",
  "created_at": "2026-10-26T15:10:00.000Z",
  "expires_at": "2026-10-26T15:11:00.000Z",
  "target": {
    "connector_id": "custom-teamchat",
    "account_id": "bot-1",
    "conversation_id": "group-42"
  },
  "action": "message.send",
  "params": {
    "segments": [{ "type": "text", "text": "项目通知" }]
  }
}
```

| action | params | 必需能力 |
| --- | --- | --- |
| message.send | segments；可选 reply_to、thread_id、二维 buttons | messages.send；有按钮时另需 interactions.buttons |
| message.delete | message_id、reason | messages.delete |
| message.hide | message_id、reason | messages.hide |
| member.mute | user_id、正整数 duration_seconds、reason | members.mute |
| member.unmute | user_id、reason、preconditions | members.mute + members.release_conditionally |
| member.remove | user_id、reason | members.remove |
| member.ban / member.unban | user_id、reason | members.ban |
| membership.approve / membership.reject | request_id、reason | membership.review |
| interaction.ack | interaction_id；可选 text | interactions.ack |

按钮分 callback（label、value）与 url（label、http(s) url）两类，保留行布局。平台的回调字节长度、按钮数量等限制由适配器校验；不支持时明确失败，不能静默删除验证按钮。示例执行端只模拟普通消息发送，不宣称已经实现 Telegram 交互。

member.unmute 的 preconditions 必须包含 restriction_id、owner_type（verification/moderation）、owner_id（挑战/处罚来源）、membership_id、expected_version、platform_fingerprint。连接器与核心核对限制归属和当前状态；存在其他限制时只能解除本条核心记录，不触碰平台禁言。仅“先读取再写入”无法防止并发管理员修改；缺少平台原子条件更新或经确认的独占写入约束时返回需要人工处理，不自动清除限制。详见 evaluateRestrictionRelease。

接收端先认证和授权，再校验幂等。对首次执行的指令检查 expires_at、当前权限和能力；已完成的重试返回原回执，即使它现在已过期。仅识别出动作名称不能作为已实现该操作的证据。示例执行端只实现 message.send，其余动作明确返回不支持。

## 回执

```json
{
  "schema_version": "1",
  "command_id": "cmd-001",
    "attempt_id": "attempt-001",
    "attempt_number": 1,
    "revision": 1,
  "observed_at": "2026-10-26T15:10:01.000Z",
  "status": "succeeded",
  "result": { "message_id": "platform-message-123" }
}
```

| status | 语义与字段 |
| --- | --- |
| accepted | 已持久排队，尚未完成；没有 result |
| succeeded | 执行成功，result 可包含平台 message_id |
| failed | 确认没有产生目标外部副作用的失败，error 包含 code、message、retryable |
| unknown | 结果无法确定，error.retryable 必须为 false；进入核对流程 |

同步处理在 HTTP 200 响应中返回回执。异步处理先返回 HTTP 202 与 accepted，最终回执计划经 `POST /api/v1/connector-receipts` 签名回传；该异步端点当前未实现。核心应验证 command_id 属于该凭据及目标，防止错配回执。

revision 在同一 attempt 内递增，不能用 observed_at 代替顺序。低版本回执忽略；同版本同载荷幂等，同版本不同载荷冲突。accepted 可转为确定结果或 unknown；succeeded/failed 为该尝试的终态，不允许被迟到 accepted 覆盖。unknown 只有经过核心授权核对，才可转为 succeeded 或明确 failed。普通回调不能自报“已核对”来获得重试权限。异步最终回执应高于初始 accepted 的 revision，即使它先到达也保留最终状态。

## 签名与防重放

生产使用 HTTPS。两个方向配置不同的高熵密钥，每个至少 32 字节。示例每次运行随机生成密钥。

```text
X-Superbot-Key-Id: <已预先注册的密钥标识>
X-Superbot-Timestamp: <Unix 秒>
X-Superbot-Nonce: <每次 HTTP 尝试唯一的随机值>
X-Superbot-Signature: v1=<64 位小写十六进制 HMAC-SHA256>
```

签名原文由下列 UTF-8 前缀与未经改写的 body 字节拼接：

```text
v1\n<key_id>\n<purpose>\n<METHOD 大写>\n<原始 path，含 query>\n<timestamp>\n<nonce>\n<body 原始字节>
```

接收端先用 Key-Id 查找预配置凭据，检查其有效期、撤销状态、用途和账号范围，再验证原始字节签名，最后解析 JSON 并核对身份。Key-Id 只是查找线索，不能直接授予权限。purpose 由端点确定为 events、commands 或 control，不能信任调用者自选用途。密钥标识和用途也进入 HMAC 原文，使用常量时间比较。代理层必须保留双方约定的外部路径。

允许时钟差 ±300 秒，nonce 格式为 16–128 位字母、数字、下划线或连字符。通过签名后原子占用 nonce，在该签名仍可能被接受的时间窗口内保留。无效签名不占用 nonce。正文上限 256 KiB，示例在流式读取时检查限制。

防重放与业务去重是两层机制：一次 HTTP 投递的 nonce 只能使用一次，作用域包含密钥标识与用途。重新投递相同事件或相同执行尝试时生成新签名和 nonce，保持业务载荷不变。密钥轮换期间可短期允许多个已注册 Key-Id，撤销后立即拒绝旧凭据；业务去重不能随密钥轮换丢失。

## 幂等与错误

- 事件去重键为 `(connector_id, account_id, event_id)`。
- 核心操作按 `(workspace_id, idempotency_key)` 去重，command_id 同样唯一，目标为稳定的逻辑群；更换执行账号不能创建新的业务操作。连接器在其授权命名空间内存储同一操作的各次尝试。
- command_id、幂等键、逻辑目的地、动作、内容、创建/到期时间和 trace 构成不可变业务意图。attempt_id、attempt_number 和经核心授权选择的执行绑定独立保存。
- 相同 attempt_id 必须保持完整载荷不变并返回该尝试最新回执；同一尝试改变载荷返回 409。第一次 attempt_number=1，后续必须连续递增并使用新 attempt_id。
- 只有上次尝试明确 failed 且 retryable=true，才允许发起下一次执行。in_flight、accepted、unknown、succeeded、不可重试失败都不能直接执行新尝试。unknown 先核对；换账号也不能绕过此限制。
- 并发的相同请求只允许一次业务执行。幂等信息不能只依赖进程内 Map；生产使用数据库唯一约束及持久结果。
- 执行异常或回执格式/身份错误不能证明没有副作用，MemoryExecutionStore 将其转为 unknown 并禁止重试。MemoryIdempotencyStore 仅供不可变事件结果缓存，不再作为执行重试状态机。
- 幂等记录至少覆盖业务最长重试与补偿窗口；保存、清理和归档策略与任务期限一起设计。

| HTTP | 代码示例 | 处理 |
| --- | --- | --- |
| 400 | INVALID_PAYLOAD | 修正协议版本或载荷 |
| 401 | INVALID_SIGNATURE / STALE_REQUEST / REPLAYED_REQUEST | 检查密钥、时间与签名；合法重试重新签名 |
| 403 | FORBIDDEN_SCOPE | 检查账号及允许的会话 |
| 409 | IDEMPOTENCY_CONFLICT | 检查是否错误复用了事件或指令标识 |
| 409 | RETRY_NOT_ALLOWED / ATTEMPT_OUT_OF_ORDER | 读取当前尝试状态，按顺序执行或先核对 |
| 409 | RECEIPT_CONFLICT / INVALID_RECEIPT_TRANSITION | 检查回执版本和是否试图回滚终态 |
| 413 | PAYLOAD_TOO_LARGE | 附件使用资源引用或缩小载荷 |
| 429 / 5xx | 平台/投递错误 | 按期限与退避处理；指令结果不确定时先核对 |

协议验证失败返回 `{ "error": { "code": "...", "message": "..." } }`。已通过验证的明确业务失败可以在 HTTP 200 中返回 failed 回执；调用者必须读取 status，不能只看 HTTP 成功。

## 同步 trace

trace 包含 trace_id、origin（logical_conversation_id 与 canonical_event_id，后者放入 event_id）、visited（已访问的逻辑群 ID）。startTrace 的输入由核心从绑定与平台事实映射取得；nextSyncTrace 使用逻辑目的地检查未访问及默认 5 跳限制。同群的不同账号共享路由身份，两个不同逻辑群可以同步。

syncDeliveryKey 使用 `(trace_id, 目标逻辑群)`，不包含账号、密钥或路由版本，避免合流和执行账号变更造成重复投递。显式重新投递必须产生有审计原因的新业务操作。没有可靠跨账号事实映射时，不自动按文本合并事件，也不启用不能识别回流的双向同步。

同步必须先通过 authorizeSync：群/用户验证和黑名单检查通过、该消息当前内容版本与指纹有 allowed 审核结果、策略版本仍有效、消息未删除。把审核决定 ID 保存到 outbox，执行前重新检查；变更后重新审核或取消旧投递。该凭据只在核心内部产生，外部项目不能自报“审核通过”。

该路径检查还需要持久目的地去重、路由授权和发出消息映射配合。连接器必须让自己的发送回流关联原 trace；未知来源的 trace 不能用于绕过广告审核或项目权限。

## 外部项目业务 API 草案

以下为后续正式服务预留，当前仓库尚未实现：

```text
GET  /api/v1/conversations           查询项目有权访问的群/社群
POST /api/v1/messages                向授权目标提交发送任务
GET  /api/v1/deliveries/{id}         查询逐目标执行结果
POST /api/v1/lotteries               在有权会话创建抽奖
```

业务 API 使用项目 API Key 与动作/群范围授权；连接器协议使用绑定账号的签名凭据。两类权限分别管理，普通项目发布权限不自动包含群管理员权限。
