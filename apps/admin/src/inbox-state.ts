type Data = Record<string, any>;
export const visibleInboxGroups = (groups: Data[]) => groups.filter((group) => group.sync_enabled !== false);
export type InboxSnapshot = {
  observed_at?: string;
  conversation: Data;
  conversations: Data[];
  messages: Data[];
  deliveries: Data[];
  pagination: { has_more: boolean; before: string | null };
};

export type InboxDirectory = { observed_at: string; groups: Data[] };

// A room's cached messages can be old; its sidebar must still use the latest global selection.
export function rememberSnapshot(
  cache: Map<string, InboxSnapshot>,
  incoming: InboxSnapshot,
  directory?: InboxDirectory,
): InboxDirectory {
  if (!directory || (incoming.observed_at ?? '') >= directory.observed_at)
    directory = {
      observed_at: incoming.observed_at ?? '',
      groups: visibleInboxGroups(incoming.conversations),
    };
  const enabled = new Set(directory.groups.map((group) => group.id));
  cache.delete(incoming.conversation.id);
  cache.set(incoming.conversation.id, incoming);
  for (const [id, snapshot] of cache)
    cache.set(id, {
      ...snapshot,
      conversation: {
        ...snapshot.conversation,
        sync_enabled: enabled.has(id),
        ...(!enabled.has(id)
          ? { can_send: false, send_error: '此群已取消同步，可在连接账号中重新勾选' }
          : {}),
      },
      conversations: directory.groups,
    });
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return directory;
}

export const mergeMessages = (older: Data[], newer: Data[]) =>
  [...new Map([...older, ...newer].map((message) => [message.id, message])).values()].sort(
    (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id),
  );

export function mergeSnapshot(previous: InboxSnapshot | undefined, incoming: InboxSnapshot): InboxSnapshot {
  if (
    previous &&
    previous.conversation.id === incoming.conversation.id &&
    previous.observed_at &&
    incoming.observed_at &&
    incoming.observed_at < previous.observed_at
  )
    return previous;
  if (!previous || previous.conversation.id !== incoming.conversation.id || !incoming.pagination.has_more)
    return incoming;
  const known = new Set(previous.messages.map((message) => message.id));
  // A room can receive more than a snapshot's 100 messages while it is closed.
  // Without overlap, merging would hide the missing interval behind an old history cursor.
  if (!incoming.messages.some((message) => known.has(message.id))) return incoming;
  const messages = mergeMessages(previous.messages, incoming.messages);
  const preserveCursor = messages[0]?.id === previous.messages[0]?.id;
  return { ...incoming, messages, pagination: preserveCursor ? previous.pagination : incoming.pagination };
}

export function prependHistory(
  current: InboxSnapshot,
  page: Pick<InboxSnapshot, 'messages' | 'pagination'>,
  before: string,
): InboxSnapshot {
  // A reconnect may have replaced a discontinuous cache while this page was loading.
  if (current.pagination.before !== before) return current;
  return {
    ...current,
    messages: mergeMessages(page.messages, current.messages),
    pagination: page.pagination,
  };
}
