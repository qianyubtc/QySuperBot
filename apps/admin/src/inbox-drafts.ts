type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};
export type InboxSendAttempt = {
  key: string;
  text: string;
  reply?: { id: string; sender_name: string; content: string };
};
export type InboxReplyDraft = NonNullable<InboxSendAttempt['reply']>;
export function readInboxReplies(
  key: string,
  storage?: DraftStorage,
): Record<string, InboxReplyDraft> | undefined {
  try {
    const raw = (storage ?? sessionStorage).getItem(key);
    if (raw === null) return undefined;
    if (raw.length > 512_000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([room, item]) => room.length <= 256 && item && typeof item === 'object')
        .flatMap(([room, item]) => {
          const quote = item as Record<string, unknown>;
          if (typeof quote.id !== 'string' || !quote.id || quote.id.length > 256) return [];
          return [
            [
              room,
              {
                id: quote.id,
                sender_name: String(quote.sender_name ?? '引用消息').slice(0, 120),
                content: String(quote.content ?? '').slice(0, 280),
              },
            ],
          ];
        })
        .slice(-30),
    );
  } catch {
    return {};
  }
}
export function saveInboxReplies(
  key: string,
  replies: Record<string, InboxReplyDraft | undefined>,
  storage?: DraftStorage,
) {
  try {
    // An empty record prevents a cleared quote being restored from an older send attempt.
    (storage ?? sessionStorage).setItem(
      key,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(replies)
            .filter(([room, quote]) => room.length <= 256 && quote?.id && quote.id.length <= 256)
            .slice(-30)
            .map(([room, quote]) => [
              room,
              {
                id: quote!.id,
                sender_name: String(quote!.sender_name ?? '引用消息').slice(0, 120),
                content: String(quote!.content ?? '').slice(0, 280),
              },
            ]),
        ),
      ),
    );
    return true;
  } catch {
    return false;
  }
}
export const inboxSendIntent = (attempt: InboxSendAttempt) =>
  JSON.stringify({ text: attempt.text, quote: attempt.reply?.id });
export function readInboxSendAttempts(key: string, storage?: DraftStorage): Record<string, InboxSendAttempt> {
  try {
    const raw = (storage ?? sessionStorage).getItem(key);
    if (!raw || raw.length > 512_000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries: [string, InboxSendAttempt][] = [];
    for (const [id, item] of Object.entries(value)) {
      if (id.length > 256 || !item || typeof item !== 'object') continue;
      const row = item as Record<string, any>;
      if (
        typeof row.key !== 'string' ||
        !/^[A-Za-z0-9_.:-]{8,128}$/.test(row.key) ||
        typeof row.text !== 'string' ||
        !row.text.trim() ||
        row.text.length > 8000
      )
        continue;
      if (
        row.reply !== undefined &&
        (!row.reply || typeof row.reply.id !== 'string' || !row.reply.id || row.reply.id.length > 256)
      )
        continue;
      entries.push([
        id,
        {
          key: row.key,
          text: row.text,
          ...(row.reply
            ? {
                reply: {
                  id: row.reply.id,
                  sender_name: String(row.reply.sender_name ?? '引用消息').slice(0, 120),
                  content: String(row.reply.content ?? '').slice(0, 280),
                },
              }
            : {}),
        },
      ]);
    }
    return Object.fromEntries(entries.slice(-30));
  } catch {
    return {};
  }
}
export function saveInboxSendAttempts(
  key: string,
  attempts: Record<string, InboxSendAttempt>,
  storage?: DraftStorage,
) {
  try {
    const value = Object.fromEntries(Object.entries(attempts).slice(-30));
    if (Object.keys(value).length) (storage ?? sessionStorage).setItem(key, JSON.stringify(value));
    else (storage ?? sessionStorage).removeItem(key);
    return true;
  } catch {
    return false;
  }
}
export function readInboxDrafts(key: string, storage?: DraftStorage): Record<string, string> {
  try {
    const raw = (storage ?? sessionStorage).getItem(key);
    if (!raw || raw.length > 512_000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([id, text]) => id.length <= 256 && typeof text === 'string' && text.length <= 8000)
        .slice(-30),
    );
  } catch {
    return {};
  }
}
export function saveInboxDrafts(key: string, drafts: Record<string, string>, storage?: DraftStorage) {
  try {
    const value = Object.fromEntries(
      Object.entries(drafts)
        .filter(([, text]) => text.trim())
        .slice(-30),
    );
    if (Object.keys(value).length) (storage ?? sessionStorage).setItem(key, JSON.stringify(value));
    else (storage ?? sessionStorage).removeItem(key);
    return true;
  } catch {
    return false;
  }
}
