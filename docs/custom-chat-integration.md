# 自有聊天与项目 API 接入

只发通知的项目使用 API Key；有群聊和成员管理功能的项目，创建“自有聊天”连接器。

## 项目 API

认证 Header 为 `Authorization: Bearer qsb_…`。在管理台按群和操作授权。

| 端点                         | 权限 / 请求                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /api/v1/conversations`  | `conversations.read`，只返回授权群                                                             |
| `POST /api/v1/messages`      | `messages.send`；`conversation_ids: string[]`、`text: string`，必须有 `Idempotency-Key` Header |
| `GET /api/v1/deliveries/:id` | `deliveries.read`，只查询本项目任务                                                            |
| `POST /api/v1/lotteries`     | `lotteries.write`；`conversation_id`、`title`、`winners_count`、`closes_at`（UTC ISO 时间）    |

消息返回 `{ "delivery_ids": ["…"] }`，表示持久入队；succeeded 才是确认结果。演示群只模拟执行。相同项目与幂等键不能更换内容或目标集合。当前抽奖创建没有幂等键保障，超时先查后台再决定是否重建。

## 聊天连接器

在“连接账号”创建自有聊天，填写你的服务根地址，保存一次性返回的 `connector_id/account_id`、`event_key_id/event_secret`、`command_key_id/command_secret`。当前一个连接对应一个账号，两种 ID 相同。

你的服务需要提供（路径追加到所填根地址）：

| 端点                                       | 签名用途 | 职责                                              |
| ------------------------------------------ | -------- | ------------------------------------------------- |
| `GET /superbot/v1/conversations?limit=100` | control  | 当前 session 群快照，稳定 snapshot_id/cursor 分页 |
| `POST /superbot/v1/commands`               | commands | 验签、持久幂等、实际执行与回执                    |

你的服务用事件方向密钥调用核心：

| 核心端点                              | 用途    | 内容                                                |
| ------------------------------------- | ------- | --------------------------------------------------- |
| `POST /api/v1/connectors/handshake`   | control | 修订 0.2 握手，获取 session 与 90 秒租期            |
| `POST /api/v1/connectors/heartbeat`   | control | 当前 session、递增 sequence、状态；建议每 30 秒续租 |
| `POST /api/v1/connectors/permissions` | control | 当前会话、群、递增 revision 和权限快照              |
| `POST /api/v1/connector-events`       | events  | 消息、编辑、删除、入退群与交互事件                  |
| `POST /api/v1/connector-receipts`     | events  | 延迟最终回执或经实际核对的结果                      |

先握手，再点管理台“连接 / 刷新”，核心会主动拉群；之后定时刷新在线连接。先登记群再上报消息，未发现群返回 403。部分快照不会自动删除旧群。第一版未启用成员分页业务和自动禁言/解禁。

## 验签与示例

签名覆盖原始字节、Key-Id、用途、HTTP 方法和含 query 的精确路径。使用共享协议工具，或按[连接器协议](connector-protocol.md)实现同一算法。验证成功后才解析 JSON。

```ts
import { signRequest } from './packages/contracts/src/index.ts';

const path = '/api/v1/connectors/handshake';
const body = JSON.stringify({
  schema_version: '1',
  protocol_revision: '0.2',
  connector_id: accountId,
  account_id: accountId,
  connector_type: 'my-chat',
  instance_id: instanceId,
  display_name: '我的聊天项目',
  capabilities: [{ capability: 'messages.send', state: 'supported' }],
});
const response = await fetch(superbotOrigin + path, {
  method: 'POST',
  body,
  headers: signRequest({
    method: 'POST',
    path,
    body,
    purpose: 'control',
    keyId: eventKeyId,
    secret: eventSecret,
  }),
});
```

重投使用同一 event_id / attempt，并重新生成签名 nonce。nonce 重放 401；同一 event_id 换载荷 409。允许时钟偏差 5 分钟，核心数据库持久记录 nonce。

群发现响应示例：

```json
{
  "schema_version": "1",
  "connector_id": "ACCOUNT_ID",
  "account_id": "ACCOUNT_ID",
  "session_id": "SESSION_ID",
  "snapshot_id": "stable-001",
  "revision": 1,
  "observed_at": "2026-10-27T00:00:00.000Z",
  "coverage": "complete",
  "next_cursor": null,
  "items": [
    {
      "connector_id": "ACCOUNT_ID",
      "account_id": "ACCOUNT_ID",
      "conversation_id": "your-room-id",
      "kind": "group",
      "name": "我的群",
      "member_count": null,
      "observed_at": "2026-10-27T00:00:00.000Z",
      "capabilities": [{ "capability": "messages.send", "state": "supported" }],
      "permissions": [{ "capability": "messages.send", "permission": "granted" }]
    }
  ]
}
```

只声明已实现能力，未知权限不可写 granted。权限快照超过 5 分钟拒绝执行，需刷新。平台 ID 均为字符串，与后台逻辑群 ID 分开。

新消息类型为 `message.created`，包含稳定 event_id、source、occurred_at 和 `data: { message_id, sender_id, direction, segments }`；文本段 `{ type: 'text', text: '…' }`。入群事件提供区分重进群的 membership_id。

机器人消息必须标 outgoing，同步消息保留命令 trace，避免回声再变为新来源。第一版只转发一跳，不传播媒体、编辑或删除。

命令有稳定 command_id/idempotency_key 和独立 attempt_id/attempt_number。动作前持久记录尝试，校验目标、权限和有效期；同 attempt 重投返回原结果。正式服务不能只用内存去重。

立即完成返回 succeeded；明确无副作用失败返回 failed；异步返回 accepted 后调用回执入口。无法确认是否执行时返回 unknown、不可标 retryable。更高 revision 才能更新结果，终态不可回滚。

`apps/server/test/http.test.ts` 包含真实本机 HTTP 的完整握手、群发现、事件上报、指令验签、幂等执行与回执测试；测试聊天服务不能替代你的项目实际集成。
