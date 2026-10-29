import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoStore, DEMO_KEY } from '../src/demo/store.ts';
import { clearDemoInbox } from '../src/demo/storage.ts';
import { partitionInboxDeliveries } from '../src/inbox-state.ts';
const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
};
const post = (store: DemoStore, path: string, body: any, key?: string) =>
  store.request(path, { method: 'POST', body, key });
test('history pages contain every synthetic message exactly once', () => {
  const s = new DemoStore(),
    snapshot = s.snapshot('demo-qq-0'),
    older = s.request('/conversations/demo-qq-0/history?before=' + snapshot.pagination.before);
  assert.equal(snapshot.messages.length, 100);
  assert.equal(older.messages.length, 25);
  assert.equal(older.pagination.has_more, false);
  assert.equal(new Set([...older.messages, ...snapshot.messages].map((m) => m.id)).size, 125);
});
test('selected rooms are enforced for lists and sends and persist after reload', () => {
  const storage = memory(),
    s = new DemoStore(storage);
  s.request('/accounts/demo-account-qq/groups', {
    method: 'PUT',
    body: { group_ids: [], revision: 'initial' },
  });
  assert.equal(s.snapshot('demo-qq-0').conversation.can_send, false);
  assert(!s.snapshot('demo-telegram-0').conversations.some((g: any) => g.id === 'demo-qq-0'));
  assert.throws(() => post(s, '/messages', { conversation_ids: ['demo-qq-0'], text: 'hello' }));
  assert.equal(new DemoStore(storage).enabled('demo-qq-0'), false);
  assert.throws(
    () =>
      s.request('/accounts/demo-account-qq/groups', {
        method: 'PUT',
        body: { group_ids: [], revision: 'initial' },
      }),
    /同步范围/,
  );
});
test('selection refuses rooms owned by a different account', () => {
  const s = new DemoStore();
  assert.throws(() =>
    s.request('/accounts/demo-account-qq/groups', {
      method: 'PUT',
      body: { group_ids: ['demo-room-binance'], revision: 'initial' },
    }),
  );
});
test('local replies deduplicate and reject cross-room quotes', () => {
  const s = new DemoStore(),
    quote = s.snapshot('demo-telegram-0').messages.at(-1)!;
  const body = {
    conversation_ids: ['demo-telegram-0'],
    text: 'reply',
    reply_to_message_id: quote.id,
  };
  const a = post(s, '/messages', body, 'same'),
    b = post(s, '/messages', body, 'same');
  assert.deepEqual(a, b);
  assert.equal(s.state.deliveries.length, 1);
  assert.equal(s.snapshot('demo-telegram-0').messages.at(-1)?.reply_content, quote.content);
  assert.throws(() => post(s, '/messages', { ...body, text: 'different' }, 'same'), /相同请求/);
  assert.throws(() => post(s, '/messages', { ...body, conversation_ids: ['demo-qq-0'] }), /不属于/);
});
test('a partially invalid broadcast rolls back every target', () => {
  const s = new DemoStore();
  assert.throws(() =>
    post(s, '/announcements', {
      title: 'demo',
      content: 'hello',
      conversation_ids: ['demo-telegram-0', 'not-a-room'],
    }),
  );
  assert.equal(s.state.deliveries.length, 0);
  assert.equal(s.state.announcements.length, 0);
});
test('image plus caption reaches three synthetic platforms and keeps an image reference', () => {
  const s = new DemoStore();
  s.update((d) => {
    d.images.picture = { url: 'data:image/png;base64,synthetic' };
  });
  const a = post(
    s,
    '/announcements',
    {
      title: 'image',
      content: 'caption',
      image_asset_id: 'picture',
      conversation_ids: ['demo-telegram-0', 'demo-qq-0', 'demo-binance-0'],
    },
    'broadcast',
  );
  assert.equal(a.deliveries.length, 3);
  for (const id of ['demo-telegram-0', 'demo-qq-0', 'demo-binance-0']) {
    const m = s.snapshot(id).messages.at(-1)!;
    assert.equal(m.content, 'caption');
    assert.equal(m.segments.at(-1).asset_id, 'picture');
  }
});
test('scheduled tasks never run while the room is deselected', () => {
  const s = new DemoStore();
  const a = post(s, '/announcements', {
    title: 'later',
    content: 'pending',
    conversation_ids: ['demo-telegram-0'],
    scheduled_at: new Date(Date.now() + 60000).toISOString(),
  });
  s.request('/accounts/demo-account-telegram/groups', {
    method: 'PUT',
    body: { group_ids: [], revision: 'initial' },
  });
  s.update((d) => {
    d.deliveries[0].due_at = new Date(Date.now() - 1000).toISOString();
  });
  s.tick();
  assert.equal(s.state.deliveries[0].status, 'cancelled');
  assert.equal(s.state.messages.filter((m: any) => m.content === 'pending').length, 0);
  assert.equal(s.state.announcements.find((v: any) => v.id === a.id).deliveries[0].status, 'cancelled');
});
test('mutations survive reload and reset restores isolated fixtures', () => {
  const storage = memory(),
    a = new DemoStore(storage),
    b = new DemoStore(memory());
  post(a, '/messages', { conversation_ids: ['demo-telegram-0'], text: 'private sandbox' });
  assert(storage.getItem(DEMO_KEY));
  assert.equal(new DemoStore(storage).state.deliveries.length, 1);
  assert.equal(b.state.deliveries.length, 0);
  a.reset();
  assert.equal(a.state.deliveries.length, 0);
  assert.equal(storage.getItem(DEMO_KEY), null);
});
test('deselecting a scheduled target cancels it permanently without cancelling other rooms', () => {
  const storage = memory(),
    s = new DemoStore(storage);
  const announcement = post(s, '/announcements', {
    title: 'scheduled',
    content: 'scheduled caption',
    conversation_ids: ['demo-telegram-0', 'demo-qq-0'],
    scheduled_at: new Date(Date.now() + 60000).toISOString(),
  });
  s.request('/accounts/demo-account-qq/groups', {
    method: 'PUT',
    body: { group_ids: [], revision: 'initial' },
  });
  assert.equal(s.state.deliveries.find((d: any) => d.conversation_id === 'demo-qq-0').status, 'cancelled');
  const revision = s.request('/accounts/demo-account-qq/groups').revision;
  s.request('/accounts/demo-account-qq/groups', {
    method: 'PUT',
    body: { group_ids: ['demo-room-qq'], revision },
  });
  const restored = new DemoStore(storage);
  restored.update((d) => {
    for (const job of d.deliveries) job.due_at = new Date(Date.now() - 1000).toISOString();
  });
  restored.tick();
  assert.equal(
    restored.state.deliveries.find((d: any) => d.conversation_id === 'demo-qq-0').status,
    'cancelled',
  );
  assert.equal(
    restored.state.deliveries.find((d: any) => d.conversation_id === 'demo-telegram-0').status,
    'succeeded',
  );
  assert.equal(
    restored.state.messages.filter(
      (m: any) => m.conversation_id === 'demo-qq-0' && m.content === 'scheduled caption',
    ).length,
    0,
  );
  assert.equal(
    restored.state.announcements
      .find((a: any) => a.id === announcement.id)
      .deliveries.find((d: any) => d.conversation_id === 'demo-qq-0').status,
    'cancelled',
  );
});
test('demo reset clears drafts, quotes and pending sends without touching another administrator', () => {
  const session = memory(),
    local = memory();
  for (const storage of [session, local]) {
    for (const kind of ['drafts', 'sends', 'quotes']) {
      storage.setItem(`superbot:inbox-${kind}:demo-admin`, 'demo');
      storage.setItem(`superbot:inbox-${kind}:another-admin`, 'keep');
    }
    clearDemoInbox(storage);
    for (const kind of ['drafts', 'sends', 'quotes']) {
      assert.equal(storage.getItem(`superbot:inbox-${kind}:demo-admin`), null);
      assert.equal(storage.getItem(`superbot:inbox-${kind}:another-admin`), 'keep');
    }
  }
});
test('permission refresh cannot resume a paused virtual account', () => {
  const s = new DemoStore();
  post(s, '/accounts/demo-account-qq/pause', {});
  post(s, '/accounts/demo-account-qq/permissions-refresh', {});
  assert.equal(s.account('demo-account-qq').status, 'paused');
  assert.equal(s.snapshot('demo-qq-0').conversation.can_send, false);
});
test('reconnecting a demo account restores sending while keeping old failures in history', () => {
  const storage = memory(),
    s = new DemoStore(storage);
  post(s, '/announcements', {
    title: 'recovery fixture',
    content: 'unsent demo message',
    conversation_ids: ['demo-qq-0'],
    scheduled_at: new Date(Date.now() + 60000).toISOString(),
  });
  post(s, '/accounts/demo-account-qq/pause', {});
  s.update((d) => {
    d.deliveries[0].status = 'failed';
    d.deliveries[0].last_error = '账号未在线';
  });
  assert.equal(s.snapshot('demo-qq-0').conversation.can_send, false);
  post(s, '/accounts/demo-account-qq/refresh', {});
  const restored = new DemoStore(storage).snapshot('demo-qq-0');
  assert.equal(restored.conversation.can_send, true);
  assert.equal(restored.conversation.send_error, null);
  const { active, history } = partitionInboxDeliveries(restored.deliveries);
  assert.equal(active.length, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.status, 'failed');
  assert.equal(history[0]?.last_error, '账号未在线');
  assert(!restored.messages.some((message) => message.content === 'unsent demo message'));
});
test('quota failure is explicit and never claims a successful mutation', () => {
  const s = new DemoStore({
    ...memory(),
    setItem: () => {
      throw new Error('quota');
    },
  });
  const count = s.state.messages.length;
  assert.throws(
    () => post(s, '/messages', { text: 'hello', conversation_ids: ['demo-telegram-0'] }),
    /存储空间/,
  );
  assert.equal(s.state.messages.length, count);
  assert.equal(s.state.deliveries.length, 0);
});
test('account creation never stores credentials or connection endpoints', () => {
  const s = new DemoStore();
  post(s, '/accounts', {
    name: 'test',
    kind: 'telegram',
    token: 'DO_NOT_STORE',
    api_token: 'DO_NOT_STORE',
    endpoint: 'https://secret.invalid',
  });
  assert(!JSON.stringify(s.state).includes('DO_NOT_STORE'));
  assert(!JSON.stringify(s.state).includes('secret.invalid'));
});
test('member administration protects synthetic admin and records warnings locally', () => {
  const s = new DemoStore();
  assert.throws(
    () =>
      post(s, '/conversations/demo-binance-0/binance-member-actions', {
        user_id: '900002',
        action: 'remove',
        reason: 'test',
      }),
    /受保护/,
  );
  post(s, '/conversations/demo-telegram-0/member-actions', {
    user_id: '100001',
    action: 'warn',
    reason: 'test',
  });
  assert.equal(
    s.request('/conversations/demo-telegram-0/member-management?user_id=100001').selected_warning_count,
    1,
  );
});
test('unknown endpoints fail closed instead of falling back to HTTP', () => {
  const s = new DemoStore();
  assert.throws(() => s.request('/unimplemented'), /真实平台服务/);
});
