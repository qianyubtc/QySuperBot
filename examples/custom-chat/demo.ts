import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connectorEventSchema, signRequest } from '../../packages/contracts/src/index.ts';
import { createDemoBridge, EVENT_PATH, CONVERSATION_PATH } from './handlers.ts';

// Fresh credentials per demo run. Do not log or commit real account credentials.
const eventSecret = randomBytes(32).toString('hex');
const commandSecret = randomBytes(32).toString('hex');
const source = { connector_id: 'custom-chat', account_id: 'demo-account', conversation_id: 'demo-room' };
const bridge = createDemoBridge({ conversation: source, eventSecret, commandSecret });
const event = connectorEventSchema.parse({
  schema_version: '1', event_id: 'demo-event-1', occurred_at: new Date().toISOString(),
  source, type: 'message.created',
  data: {
    message_id: 'demo-message-1', sender_id: 'demo-user', direction: 'incoming',
    segments: [{ type: 'text', text: '你好，这是我自己的聊天项目。' }],
  },
});
const body = JSON.stringify(event);
function request(signedBody = body, sentBody = signedBody) {
  return new Request(`http://superbot.local${EVENT_PATH}`, {
    method: 'POST', body: sentBody,
    headers: signRequest({ method: 'POST', path: EVENT_PATH, body: signedBody, secret: eventSecret, keyId: 'demo-events', purpose: 'events' }),
  });
}

const first = await bridge.handleEvent(request());
assert.equal(first.status, 200);
const receipt = await first.json();
assert.equal(receipt.receipt.status, 'succeeded');
const repeated = await bridge.handleEvent(request());
assert.equal((await repeated.json()).duplicate, true);
assert.equal(bridge.messages.length, 1);
const tampered = await bridge.handleEvent(request(body, body + ' '));
assert.equal(tampered.status, 401);
const discovery = await bridge.handleDiscovery(new Request(`http://custom-chat.local${CONVERSATION_PATH}`, {
  headers: signRequest({ method: 'GET', path: CONVERSATION_PATH, body: '', secret: commandSecret, keyId: 'demo-commands', purpose: 'control' }),
}));
assert.equal(discovery.status, 200);
const groups = await discovery.json();
assert.equal(groups.items.length, 1);

console.log('双向接入：聊天项目上报消息 → 核心验证并审核 → 聊天项目执行发送 → 返回示例回执');
console.log(JSON.stringify({
  conversation: bridge.conversation.name,
  command_status: receipt.receipt.status,
  messages_sent_after_duplicate: bridge.messages.length,
  tampered_request_http_status: tampered.status,
  discovered_conversations: groups.items.length,
  transport: '同进程 HTTP Request/Response 模拟，无外部平台连接',
}, null, 2));
