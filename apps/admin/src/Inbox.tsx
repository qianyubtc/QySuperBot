import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock3,
  LoaderCircle,
  MessageSquare,
  Radio,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { api, RequestError, mediaUrl, openChatStream } from './api';
import ModerationResult from './ModerationResult';
import { ImageViewer } from './ConsoleTools';
import {
  readInboxDrafts,
  saveInboxDrafts,
  readInboxSendAttempts,
  saveInboxSendAttempts,
  inboxSendIntent,
  readInboxReplies,
  saveInboxReplies,
  type InboxSendAttempt,
} from './inbox-drafts';
import {
  mergeSnapshot,
  prependHistory,
  rememberSnapshot,
  visibleInboxGroups,
  type InboxDirectory,
  type InboxSnapshot as Snapshot,
} from './inbox-state';

type Data = Record<string, any>;
type LiveStatus = 'connecting' | 'live' | 'reconnecting';
function ChatImage({
  conversationId,
  messageId,
  index = 0,
  assetId,
}: {
  conversationId?: string;
  messageId?: string;
  index?: number;
  assetId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [viewing, setViewing] = useState(false);
  const src = mediaUrl(
    assetId
      ? `/api/v1/uploads/images/${encodeURIComponent(assetId)}?preview=1`
      : `/api/v1/conversations/${encodeURIComponent(conversationId!)}/messages/${encodeURIComponent(messageId!)}/image?index=${index}`,
  );
  if (failed)
    return (
      <div className="chat-image-frame chat-image-error">
        <p>图片暂时无法加载，请确认平台连接在线，或稍后重试。</p>
        <button
          className="text-button"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          重试加载
        </button>
      </div>
    );
  return (
    <>
      <a
        className="chat-image-frame chat-image-link"
        href={src}
        target="_blank"
        rel="noreferrer"
        title="查看原图"
        onClick={(event) => {
          event.preventDefault();
          setViewing(true);
        }}
      >
        <img
          key={attempt}
          src={src.startsWith('data:') ? src : `${src}&attempt=${attempt}`}
          alt="群聊图片"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </a>
      {viewing && <ImageViewer src={src} close={() => setViewing(false)} />}
    </>
  );
}
function ChatAvatar({
  conversationId,
  message,
  supported,
}: {
  conversationId: string;
  message: Data;
  supported: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="chat-avatar">
      {message.direction === 'outgoing' ? (
        <Bot size={17} />
      ) : (
        String(message.sender_name || message.sender_id).slice(0, 1)
      )}
      {!failed && supported && !message.deleted && (
        <img
          src={mediaUrl(
            `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}/avatar`,
          )}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
const verdicts: Record<string, string> = {
  allowed: '已放行',
  blocked: '规则命中',
  observed: '规则命中（观察）',
  historical: '历史快照',
  pending: '待验证 / 核对',
  official: '官方消息',
};
const states: Record<string, string> = {
  pending: '排队中',
  in_flight: '发送中',
  accepted: '平台处理中',
  succeeded: '已发送',
  failed: '发送失败',
  unknown: '结果待核对',
  cancelled: '已取消',
};
const platformName = (group: Data) =>
  group.is_demo
    ? '本地演示'
    : (({ telegram: 'Telegram', qq: 'QQ', binance: '币安聊天', custom: '自有聊天' } as Data)[
        group.platform
      ] ?? group.platform);
const time = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
const day = (value: string) =>
  new Date(value).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Shanghai',
  });

function useLiveChat(id?: string) {
  const cache = useRef(new Map<string, Snapshot>());
  const directory = useRef<InboxDirectory | undefined>(undefined);
  const preparing = useRef(new Map<string, Promise<void>>());
  const [state, setSnapshot] = useState<Snapshot>();
  const snapshot = state?.conversation.id === id ? state : id ? cache.current.get(id) : undefined;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyLocks = useRef(new Set<string>());
  const activeId = useRef(id);
  activeId.current = id;
  const store = (value: Snapshot) => {
    directory.current = rememberSnapshot(cache.current, value, directory.current);
    const active = activeId.current ? cache.current.get(activeId.current) : undefined;
    if (active) setSnapshot(active);
  };
  const latest = (value: Snapshot) => {
    store(mergeSnapshot(cache.current.get(value.conversation.id), value));
  };
  const prepare = (groupId: string) => {
    if (cache.current.has(groupId)) return Promise.resolve();
    let request = preparing.current.get(groupId);
    if (!request) {
      request = api<Snapshot>(`/conversations/${encodeURIComponent(groupId)}/chat`)
        .then(latest)
        .finally(() => preparing.current.delete(groupId));
      preparing.current.set(groupId, request);
    }
    return request;
  };
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    setSnapshot(id ? cache.current.get(id) : undefined);
    setHistoryError('');
    setLoadingHistory(!!id && historyLocks.current.has(id));
    setError('');
    setStatus('connecting');
    if (!id) return;
    let active = true,
      source: EventSource | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      revision = 0;
    const path = `/conversations/${encodeURIComponent(id)}`;
    const refresh = async () => {
      const started = revision;
      try {
        const value = await api<Snapshot>(`${path}/chat`);
        // A slower HTTP refresh must not replace a newer live snapshot.
        if (active && started === revision) {
          revision++;
          latest(value);
          setError('');
        }
      } catch (err: any) {
        if (active && started === revision)
          setError(err instanceof RequestError ? err.message : '消息连接暂不可用，正在自动重试');
      }
    };
    refreshRef.current = refresh;
    function retryClosedConnection() {
      clearTimeout(retry);
      retry = setTimeout(async () => {
        if (!active) return;
        try {
          await api('/auth/me');
          connect();
        } catch (err: any) {
          if (active && err.status === 401) window.dispatchEvent(new Event('superbot:unauthorized'));
          else if (active) {
            setError('连接暂不可用，正在自动重试');
            retryClosedConnection();
          }
        }
      }, 2000);
    }
    function connect() {
      if (!active) return;
      source = openChatStream(`/api/v1${path}/stream`);
      source.onopen = () => {
        if (active) {
          setStatus('live');
          setError('');
        }
      };
      source.addEventListener('chat.snapshot', (event) => {
        if (!active) return;
        try {
          const value = JSON.parse((event as MessageEvent).data) as Snapshot;
          if (value.conversation.id === id) {
            revision++;
            latest(value);
            setError('');
            setStatus('live');
          }
        } catch {
          setError('消息数据读取失败，请重新连接');
        }
      });
      source.addEventListener('auth.expired', () => {
        source?.close();
        if (active) window.dispatchEvent(new Event('superbot:unauthorized'));
      });
      source.addEventListener('stream.error', () => {
        if (active) setStatus('reconnecting');
      });
      source.onerror = () => {
        if (!active) return;
        setStatus('reconnecting');
        // Native EventSource reconnects on transport failures. Recreate only when it has stopped permanently.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retryClosedConnection();
        }
      };
    }
    void refresh();
    connect();
    return () => {
      active = false;
      source?.close();
      clearTimeout(retry);
      refreshRef.current = async () => {};
    };
  }, [id, connection]);
  return {
    snapshot,
    status,
    error,
    refresh: () => refreshRef.current(),
    reconnect: () => setConnection((current) => current + 1),
    loadingHistory,
    historyError,
    prepare,
    loadOlder: async (beforeApply: () => void) => {
      if (!id || historyLocks.current.has(id)) return;
      const current = cache.current.get(id);
      if (!current?.pagination.has_more || !current.pagination.before) return;
      historyLocks.current.add(id);
      setLoadingHistory(true);
      setHistoryError('');
      try {
        const page = await api<{ messages: Data[]; pagination: Snapshot['pagination'] }>(
          `/conversations/${encodeURIComponent(id)}/history?before=${encodeURIComponent(current.pagination.before)}&limit=50`,
        );
        const fresh = cache.current.get(id);
        if (fresh && fresh.pagination.before === current.pagination.before) {
          if (activeId.current === id) beforeApply();
          store(prependHistory(fresh, page, current.pagination.before));
        }
      } catch (err: any) {
        if (activeId.current === id) setHistoryError(err.message || '历史消息加载失败，请重试');
      } finally {
        historyLocks.current.delete(id);
        if (activeId.current === id) setLoadingHistory(false);
      }
    },
  };
}

export default function Inbox({
  initialGroups,
  toast,
  draftScope,
}: {
  initialGroups: Data[];
  toast: (message: string, error?: boolean) => void;
  draftScope: string;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    snapshot: state,
    status,
    error,
    refresh,
    reconnect,
    loadOlder,
    loadingHistory,
    historyError,
    prepare,
  } = useLiveChat(id);
  const snapshot = state?.conversation.id === id ? state : undefined;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [showGroups, setShowGroups] = useState(false);
  const draftKey = `superbot:inbox-drafts:${draftScope}`;
  const sendKey = `superbot:inbox-sends:${draftScope}`;
  const replyKey = `superbot:inbox-quotes:${draftScope}`;
  const [storedAttempts] = useState(() => readInboxSendAttempts(sendKey));
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readInboxDrafts(draftKey));
  const [draftPersisted, setDraftPersisted] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const [replies, setReplies] = useState<Record<string, Data | undefined>>(
    () =>
      readInboxReplies(replyKey) ??
      Object.fromEntries(
        Object.entries(storedAttempts)
          .filter(([groupId, attempt]) => attempt.reply && drafts[groupId]?.trim() === attempt.text)
          .map(([groupId, attempt]) => [groupId, attempt.reply]),
      ),
  );
  useEffect(() => {
    const textSaved = saveInboxDrafts(draftKey, drafts);
    const quotesSaved = saveInboxReplies(replyKey, replies as Record<string, InboxSendAttempt['reply']>);
    setDraftPersisted(textSaved && quotesSaved);
  }, [draftKey, replyKey, drafts, replies]);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [newMessages, setNewMessages] = useState(0);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState('');
  const [opening, setOpening] = useState('');
  const switchRequest = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const groupSearch = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const positions = useRef(new Map<string, { top: number; follow: boolean }>());
  const scrollAnchor = useRef<{ id: string; top: number; height: number } | undefined>(undefined);
  const restoringRoom = useRef(false);
  const lastMessage = useRef('');
  const lastGroups = useRef<Map<string, string> | undefined>(undefined);
  const selectedId = useRef(id);
  selectedId.current = id;
  const requests = useRef(
    new Map(
      Object.entries(storedAttempts).map(([groupId, attempt]) => [
        groupId,
        { intent: inboxSendIntent(attempt), key: attempt.key },
      ]),
    ),
  );
  const editorValues = useRef({ drafts, replies });
  editorValues.current = { drafts, replies };
  const forgetAttempt = (groupId: string) => {
    if (!requests.current.has(groupId)) return;
    requests.current.delete(groupId);
    const saved = readInboxSendAttempts(sendKey);
    delete saved[groupId];
    saveInboxSendAttempts(sendKey, saved);
  };
  useEffect(() => {
    const completed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.scope !== sendKey || requests.current.get(detail.groupId)?.key !== detail.key) return;
      const current = JSON.stringify({
        text: editorValues.current.drafts[detail.groupId]?.trim() ?? '',
        quote: editorValues.current.replies[detail.groupId]?.id,
      });
      if (current !== detail.intent) return;
      setDrafts((previous) => ({ ...previous, [detail.groupId]: '' }));
      setReplies((previous) => ({ ...previous, [detail.groupId]: undefined }));
    };
    window.addEventListener('superbot:inbox-send-completed', completed);
    return () => window.removeEventListener('superbot:inbox-send-completed', completed);
  }, [sendKey]);
  const locks = useRef(new Set<string>());
  const previousConversations = useRef<Data[] | undefined>(undefined);
  useLayoutEffect(() => {
    if (snapshot?.conversations) previousConversations.current = snapshot.conversations;
  }, [snapshot?.conversations]);
  const room = snapshot?.conversation ?? initialGroups.find((group) => group.id === id);
  const directoryById = new Map(initialGroups.map((group) => [group.id, group]));
  const groups = visibleInboxGroups(
    snapshot?.conversations ?? previousConversations.current ?? initialGroups,
  ).map((group) => ({ ...directoryById.get(group.id), ...group }));
  const messages = snapshot?.messages ?? [];
  const deliveries = snapshot?.deliveries.filter((d) => d.status !== 'succeeded') ?? [];
  const draft = id ? (drafts[id] ?? '') : '';
  const reply = id ? replies[id] : undefined;
  const replyState = reply && messages.find((m) => m.id === reply.id);
  const unavailableReply = !!reply && !!replyState?.deleted;
  const limit = room?.platform === 'telegram' ? 4096 : room?.platform === 'binance' ? 2000 : 8000;
  const matches = findQuery.trim()
    ? messages.filter(
        (message) =>
          !message.deleted &&
          `${message.sender_name} ${message.sender_id} ${message.content}`
            .toLocaleLowerCase()
            .includes(findQuery.trim().toLocaleLowerCase()),
      )
    : [];
  const currentMatch = matches[Math.min(matchIndex, Math.max(0, matches.length - 1))]?.id;
  const jumpMatch = (index: number) => {
    if (!matches.length) return;
    const next = (index + matches.length) % matches.length;
    setMatchIndex(next);
    follow.current = false;
    history.current
      ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(matches[next]!.id)}"]`)
      ?.scrollIntoView({ block: 'center' });
  };
  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (findOpen && findQuery.trim()) jumpMatch(0);
  }, [findQuery]);
  useEffect(() => {
    if (showGroups) groupSearch.current?.focus();
  }, [showGroups]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const resized = () => {
      if (!media.matches) setShowGroups(false);
    };
    media.addEventListener('change', resized);
    return () => media.removeEventListener('change', resized);
  }, []);
  useEffect(() => {
    if ((!id || snapshot?.conversation.sync_enabled === false) && groups.length)
      navigate(`/inbox/${groups[0]!.id}`, { replace: true });
    else if (id && snapshot?.conversation.sync_enabled === false) navigate('/inbox', { replace: true });
  }, [id, snapshot?.conversation.sync_enabled, groups[0]?.id, navigate]);
  useLayoutEffect(() => {
    switchRequest.current++;
    setOpening('');
    const saved = id ? positions.current.get(id) : undefined;
    follow.current = saved?.follow ?? true;
    restoringRoom.current = true;
    lastMessage.current = '';
    setNewMessages(0);
    setShowGroups(false);
    setFindOpen(false);
    setFindQuery('');
    setMatchIndex(0);
    setUnread((previous) => {
      const next = new Set(previous);
      if (id) next.delete(id);
      return next;
    });
  }, [id]);
  useLayoutEffect(() => {
    if (!snapshot) return;
    const previous = lastGroups.current;
    setUnread((current) => {
      const next = new Set(current);
      if (previous)
        for (const g of snapshot.conversations)
          if (
            g.id !== id &&
            g.last_message_id &&
            previous.has(g.id) &&
            previous.get(g.id) !== g.last_message_id
          )
            next.add(g.id);
      if (id) next.delete(id);
      return next;
    });
    lastGroups.current = new Map(snapshot.conversations.map((g) => [g.id, g.last_message_id]));
    const newest = snapshot.messages.at(-1)?.id ?? '';
    const changed = newest !== lastMessage.current;
    if (changed && !follow.current && lastMessage.current) setNewMessages((n) => n + 1);
    lastMessage.current = newest;
    const element = history.current;
    if (element) {
      if (restoringRoom.current) {
        const saved = id ? positions.current.get(id) : undefined;
        element.scrollTop = saved && !saved.follow ? saved.top : element.scrollHeight;
        restoringRoom.current = false;
      } else if (scrollAnchor.current?.id === id) {
        const anchor = scrollAnchor.current!;
        element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
        scrollAnchor.current = undefined;
      } else if (follow.current) element.scrollTop = element.scrollHeight;
    }
  }, [snapshot, id]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.matchMedia('(max-width: 760px)').matches ? 100 : 130)}px`;
    if (follow.current && history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [id, draft]);
  const jumpLatest = useCallback(() => {
    follow.current = true;
    setNewMessages(0);
    const el = history.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const choose = async (groupId: string) => {
    if (groupId === id) {
      switchRequest.current++;
      setOpening('');
      setShowGroups(false);
      return;
    }
    const request = ++switchRequest.current;
    setOpening(groupId);
    try {
      await prepare(groupId);
      if (request !== switchRequest.current) return;
      navigate(`/inbox/${groupId}`);
      setShowGroups(false);
    } catch (err: any) {
      if (request === switchRequest.current) toast(err.message || '社群消息暂不可用，请重试', true);
    } finally {
      if (request === switchRequest.current) setOpening('');
    }
  };
  async function send() {
    if (
      !id ||
      !room ||
      !draft.trim() ||
      locks.current.has(id) ||
      !room.can_send ||
      unavailableReply ||
      opening
    )
      return;
    const groupId = id,
      text = draft.trim(),
      quote = reply?.id;
    const intent = JSON.stringify({ text, quote });
    let request = requests.current.get(groupId);
    if (!request || request.intent !== intent) {
      request = { intent, key: crypto.randomUUID() };
      requests.current.set(groupId, request);
    }
    const savedAttempts = readInboxSendAttempts(sendKey);
    delete savedAttempts[groupId];
    savedAttempts[groupId] = {
      key: request.key,
      text,
      ...(reply
        ? {
            reply: {
              id: reply.id,
              sender_name: String(reply.sender_name ?? '引用消息').slice(0, 120),
              content: String(reply.content ?? '').slice(0, 280),
            },
          }
        : {}),
    };
    if (!saveInboxSendAttempts(sendKey, savedAttempts)) {
      const savedDrafts = readInboxDrafts(draftKey);
      delete savedDrafts[groupId];
      saveInboxDrafts(draftKey, savedDrafts);
      setDraftPersisted(false);
    }
    locks.current.add(groupId);
    setSending((v) => ({ ...v, [groupId]: true }));
    setSendErrors((v) => ({ ...v, [groupId]: '' }));
    try {
      await api('/messages', {
        method: 'POST',
        key: request.key,
        signal: AbortSignal.timeout(15_000),
        body: {
          conversation_ids: [groupId],
          text,
          ...(quote ? { reply_to_message_id: quote } : {}),
        },
      });
      if (readInboxSendAttempts(sendKey)[groupId]?.key === request.key) {
        const savedDrafts = readInboxDrafts(draftKey);
        if (savedDrafts[groupId]?.trim() === text) {
          delete savedDrafts[groupId];
          saveInboxDrafts(draftKey, savedDrafts);
          const savedReplies = readInboxReplies(replyKey) ?? {};
          if (savedReplies[groupId]?.id === quote) {
            delete savedReplies[groupId];
            saveInboxReplies(replyKey, savedReplies);
          }
        }
      }
      window.dispatchEvent(
        new CustomEvent('superbot:inbox-send-completed', {
          detail: { scope: sendKey, groupId, key: request.key, intent },
        }),
      );
      toast('消息已加入发送队列');
      if (selectedId.current === groupId) {
        follow.current = true;
        setNewMessages(0);
        await refresh();
      }
    } catch (err: any) {
      setSendErrors((v) => ({
        ...v,
        [groupId]:
          err instanceof RequestError ? err.message : '连接中断，草稿已保留。可重试本次发送，避免重复提交。',
      }));
    } finally {
      locks.current.delete(groupId);
      setSending((v) => ({ ...v, [groupId]: false }));
    }
  }
  async function retryDelivery(job: Data) {
    setRetrying(job.id);
    try {
      await api(`/deliveries/${job.id}/retry`, { method: 'POST' });
      toast('已重新加入发送队列');
      await refresh();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setRetrying('');
    }
  }
  const filtered = groups.filter(
    (g) =>
      (filter === 'all' || g.platform === filter) &&
      `${g.name} ${g.external_id} ${platformName(g)}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <div className="page-head inbox-page-head">
        <div>
          <div className="eyebrow">LIVE COMMUNITY INBOX</div>
          <h1>实时消息</h1>
          <p>在一个工作台里跟进社群讨论，直接发送与回复。</p>
        </div>
        <div className="inbox-head-actions">
          <Link className="btn" to="/announcements?compose=1">
            <Send size={15} />
            群发消息
          </Link>
          <div className={`live-state ${status}`}>
            <span />
            {status === 'live' ? (
              <Wifi size={14} />
            ) : status === 'connecting' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <WifiOff size={14} />
            )}
            <strong>
              {status === 'live' ? '消息实时更新' : status === 'connecting' ? '正在连接' : '正在重连'}
            </strong>
          </div>
        </div>
      </div>
      <div className={`inbox-shell ${showGroups ? 'show-group-list' : ''}`}>
        <aside
          className="inbox-groups"
          aria-label="聊天社群列表"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setShowGroups(false);
          }}
        >
          <div className="inbox-list-head">
            <h2>
              我的社群 <span>{groups.length}</span>
            </h2>
            <button
              className="icon-btn inbox-group-close"
              aria-label="关闭社群列表"
              onClick={() => setShowGroups(false)}
            >
              <X size={18} />
            </button>
          </div>
          <label className="inbox-search">
            <Search size={16} />
            <input
              ref={groupSearch}
              aria-label="搜索聊天社群"
              placeholder="搜索群名、平台或 ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="icon-btn"
                aria-label="清空社群搜索"
                onClick={() => setSearch('')}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <div className="inbox-platform-tabs" aria-label="筛选聊天平台">
            {(
              [
                ['all', '全部'],
                ['telegram', 'TG'],
                ['qq', 'QQ'],
                ['binance', '币安'],
                ['custom', '自有'],
              ] as const
            ).map(([key, name]) => (
              <button
                key={key}
                aria-pressed={filter === key}
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >
                {name}
                <span>{key === 'all' ? groups.length : groups.filter((g) => g.platform === key).length}</span>
              </button>
            ))}
          </div>
          <div className="inbox-group-items">
            {filtered.length ? (
              filtered.map((g) => (
                <button
                  key={g.id}
                  className={`inbox-group-item ${id === g.id ? 'selected' : ''}`}
                  onClick={() => void choose(g.id)}
                  aria-busy={opening === g.id}
                  aria-current={id === g.id ? 'true' : undefined}
                >
                  <span className={`inbox-group-avatar ${g.platform}`}>
                    {g.kind === 'channel' ? <Radio size={19} /> : <Users size={19} />}
                  </span>
                  <span className="inbox-group-copy">
                    <span>
                      <strong>{g.name}</strong>
                      {g.last_at && <time>{time(g.last_at)}</time>}
                    </span>
                    <small className={drafts[g.id] ? 'has-draft' : ''}>
                      {drafts[g.id] ? `草稿：${drafts[g.id]}` : g.last_content || '等待新的讨论'}
                    </small>
                    <em>
                      <span className={`inbox-platform-tag ${g.platform}`}>{platformName(g)}</span>
                      {g.kind === 'channel' ? '频道' : '群聊'}
                    </em>
                  </span>
                  {opening === g.id ? (
                    <LoaderCircle size={14} className="spin" aria-label="正在打开社群" />
                  ) : unread.has(g.id) ? (
                    <i className="inbox-unread" aria-label={`${g.name}有新消息`} />
                  ) : null}
                </button>
              ))
            ) : (
              <div className="inbox-small-empty">
                <Search size={22} />
                <p>{groups.length ? '没有匹配的社群' : '还没有连接社群'}</p>
                {groups.length ? (
                  <button
                    className="text-button"
                    onClick={() => {
                      setSearch('');
                      setFilter('all');
                    }}
                  >
                    重置筛选
                  </button>
                ) : (
                  <Link to="/accounts">
                    连接账号 <ChevronRight size={13} />
                  </Link>
                )}
              </div>
            )}
          </div>
          <div className="inbox-list-foot">
            <ShieldCheck size={14} />
            仅显示已启用同步的社群
          </div>
        </aside>
        <section className="inbox-conversation" aria-label="当前社群聊天" inert={showGroups}>
          {!id ? (
            <div className="inbox-empty">
              <MessageSquare size={36} />
              <h2>从一段讨论开始</h2>
              <p>连接社群后，在这里实时接收消息并回复。</p>
              <Link className="btn primary" to="/accounts">
                连接社群
              </Link>
            </div>
          ) : (
            <>
              <header className="inbox-room-head">
                <button
                  className="icon-btn inbox-switch"
                  aria-label="切换聊天社群"
                  onClick={() => setShowGroups(true)}
                >
                  <ArrowLeft size={19} />
                </button>
                <span className="inbox-room-icon">
                  {room?.kind === 'channel' ? <Radio size={20} /> : <MessageSquare size={20} />}
                </span>
                <div>
                  <h2>{room?.name ?? '正在加载社群…'}</h2>
                  <p>
                    {room
                      ? `${platformName(room)} · ${room.member_count ?? '未知'} 位成员`
                      : '连接后显示最新消息'}
                    {room?.connection?.state && room.connection.state !== 'connected' && (
                      <span className="inbox-room-connection"> · {room.connection.title}</span>
                    )}
                  </p>
                </div>
                <div className="inbox-room-actions">
                  <button
                    ref={findButton}
                    className={`icon-btn ${findOpen ? 'active' : ''}`}
                    aria-label="查找当前聊天消息"
                    title="查找已加载的消息"
                    aria-pressed={findOpen}
                    onClick={() => setFindOpen((value) => !value)}
                  >
                    <Search size={18} />
                  </button>
                  <Link
                    className="btn inbox-room-details"
                    to={`/groups/${id}?tab=policy`}
                    aria-label="管理当前社群"
                  >
                    <Settings2 size={16} />
                    管理社群
                  </Link>
                  <button
                    className="icon-btn"
                    aria-label="刷新当前聊天"
                    onClick={() => {
                      if (status === 'live') void refresh();
                      else reconnect();
                    }}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </header>
              {findOpen && (
                <div className="inbox-find" role="search" aria-label="查找已加载消息">
                  <Search size={17} />
                  <input
                    ref={findInput}
                    aria-label="查找已加载消息"
                    value={findQuery}
                    placeholder="查找消息内容、昵称或成员 ID"
                    onChange={(event) => {
                      setFindQuery(event.target.value);
                      setMatchIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        jumpMatch(matchIndex + (event.shiftKey ? -1 : 1));
                      }
                      if (event.key === 'Escape') {
                        setFindOpen(false);
                        setFindQuery('');
                        findButton.current?.focus();
                      }
                    }}
                  />
                  <span role="status">
                    {findQuery.trim()
                      ? `${matches.length ? Math.min(matchIndex + 1, matches.length) : 0} / ${matches.length}`
                      : `已加载 ${messages.length} 条`}
                  </span>
                  <button
                    className="icon-btn"
                    aria-label="上一条匹配消息"
                    disabled={!matches.length}
                    onClick={() => jumpMatch(matchIndex - 1)}
                  >
                    <ChevronUp size={17} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="下一条匹配消息"
                    disabled={!matches.length}
                    onClick={() => jumpMatch(matchIndex + 1)}
                  >
                    <ChevronDown size={17} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="关闭消息查找"
                    onClick={() => {
                      setFindOpen(false);
                      setFindQuery('');
                    }}
                  >
                    <X size={17} />
                  </button>
                  <small>仅查找已加载消息；需要更早记录可先加载历史。</small>
                </div>
              )}
              {room?.is_demo && (
                <div className="inbox-demo-note">
                  <Bot size={14} />
                  <span>演示群 · 消息与回复只在本地模拟</span>
                  <Link to={`/groups/${id}`}>
                    模拟成员发言 <ChevronRight size={12} />
                  </Link>
                </div>
              )}
              {error && (
                <div className="inbox-error" role="alert">
                  <CircleAlert size={15} />
                  <span>{error}</span>
                  <button onClick={reconnect}>重新连接</button>
                </div>
              )}
              <div
                className="inbox-history"
                role="region"
                aria-label="聊天消息记录"
                tabIndex={0}
                ref={history}
                onScroll={() => {
                  const el = history.current;
                  if (el) {
                    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
                    if (id) positions.current.set(id, { top: el.scrollTop, follow: follow.current });
                    if (follow.current) setNewMessages(0);
                  }
                }}
              >
                {!snapshot ? (
                  !error && (
                    <div className="inbox-empty">
                      <LoaderCircle className="spin" size={24} />
                      <p>正在读取消息…</p>
                    </div>
                  )
                ) : !messages.length && !deliveries.length ? (
                  <div className="inbox-empty">
                    <MessageSquare size={34} />
                    <h2>等待第一条消息</h2>
                    <p>群内新消息会自动出现在这里，也可以先发一条招呼。</p>
                  </div>
                ) : (
                  <>
                    <div className="inbox-history-note">
                      <ShieldCheck size={12} />
                      已显示 {messages.length} 条消息 · 北京时间
                    </div>
                    {snapshot.pagination?.has_more && (
                      <div className="inbox-history-load">
                        <button
                          className="btn"
                          disabled={loadingHistory}
                          onClick={() => {
                            follow.current = false;
                            void loadOlder(() => {
                              const el = history.current;
                              if (el && id)
                                scrollAnchor.current = {
                                  id,
                                  top: el.scrollTop,
                                  height: el.scrollHeight,
                                };
                            });
                          }}
                        >
                          {loadingHistory ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <Clock3 size={14} />
                          )}
                          {loadingHistory ? '加载中…' : '加载更早消息'}
                        </button>
                      </div>
                    )}
                    {historyError && (
                      <p className="form-error" role="alert">
                        {historyError}
                      </p>
                    )}
                    {messages.map((message, index) => (
                      <div
                        key={message.id}
                        data-message-id={message.id}
                        className={findOpen && currentMatch === message.id ? 'chat-search-match' : ''}
                      >
                        {(index === 0 ||
                          day(messages[index - 1]!.created_at) !== day(message.created_at)) && (
                          <div className="inbox-day">
                            <span>{day(message.created_at)}</span>
                          </div>
                        )}
                        <article
                          className={`chat-line ${message.direction} ${message.deleted ? 'is-deleted' : ''}`}
                        >
                          <ChatAvatar
                            key={`${id}:${message.sender_id}`}
                            conversationId={id!}
                            message={message}
                            supported={
                              ['telegram', 'qq', 'binance'].includes(room?.platform) && !room?.is_demo
                            }
                          />
                          <div className="chat-message">
                            <div className="chat-author">
                              <strong>
                                {message.direction === 'outgoing' ? room?.account_name : message.sender_name}
                              </strong>
                              <time>{time(message.created_at)}</time>
                            </div>
                            <div className="chat-bubble">
                              {message.reply_to && (
                                <div className="chat-quote">
                                  <Reply size={12} />
                                  <div>
                                    <strong>{message.reply_sender_name || '引用消息'}</strong>
                                    <p>{message.reply_content || `消息 #${message.reply_to}`}</p>
                                  </div>
                                </div>
                              )}
                              {message.deleted ? (
                                <p>此消息已删除</p>
                              ) : message.segments?.some((segment: Data) => segment.type === 'image') ? (
                                <div className="chat-media">
                                  {message.segments.map((segment: Data, segmentIndex: number) =>
                                    segment.type === 'image' ? (
                                      <ChatImage
                                        key={segment.asset_id}
                                        conversationId={id!}
                                        messageId={message.id}
                                        index={
                                          message.segments
                                            .slice(0, segmentIndex)
                                            .filter((part: Data) => part.type === 'image').length
                                        }
                                      />
                                    ) : (
                                      <p key={segmentIndex}>{segment.text || `[${segment.type}]`}</p>
                                    ),
                                  )}
                                </div>
                              ) : ['binance', 'telegram', 'qq'].includes(room?.platform) &&
                                (message.content === '[图片]' || message.content.includes('[image]')) ? (
                                <ChatImage conversationId={id!} messageId={message.id} />
                              ) : (
                                <p>{message.content}</p>
                              )}
                              {message.content_truncated && (
                                <Link to={`/groups/${id}`}>内容较长，前往消息记录查看</Link>
                              )}
                            </div>
                            <div className="chat-message-foot">
                              <span className={`chat-verdict ${message.verdict}`}>
                                {message.direction === 'outgoing' ? (
                                  <>
                                    <CheckCheck size={13} />
                                    {message.deleted
                                      ? '已发送，后已删除'
                                      : room?.is_demo
                                        ? '演示发送完成'
                                        : '已发送'}
                                  </>
                                ) : (
                                  (verdicts[message.verdict] ?? message.verdict)
                                )}
                              </span>
                              {message.direction !== 'outgoing' && (
                                <span className="chat-sender-id">{message.sender_id}</span>
                              )}
                              {['telegram', 'binance'].includes(room?.platform) &&
                                room?.kind === 'group' &&
                                message.direction !== 'outgoing' &&
                                /^[1-9]\d*$/.test(message.sender_id) && (
                                  <Link
                                    className="chat-reply"
                                    to={`/groups/${id}?member=${encodeURIComponent(message.sender_id)}`}
                                    aria-label={`管理成员${message.sender_name}`}
                                  >
                                    <ShieldCheck size={13} />
                                    管理
                                  </Link>
                                )}
                              {!message.deleted && (
                                <button
                                  className="chat-reply"
                                  aria-label={`回复${message.sender_name}的消息`}
                                  disabled={!!sending[id] || !!opening}
                                  onClick={() => {
                                    if (locks.current.has(id)) return;
                                    if (replies[id]?.id !== message.id) forgetAttempt(id);
                                    setReplies((v) => ({ ...v, [id]: message }));
                                    textarea.current?.focus();
                                  }}
                                >
                                  <Reply size={13} />
                                  回复
                                </button>
                              )}
                            </div>
                            {message.reason && <small className="chat-reason">{message.reason}</small>}
                            <ModerationResult message={message} demo={room?.is_demo} />
                          </div>
                        </article>
                      </div>
                    ))}
                    {deliveries.map((job) => (
                      <article
                        className={`chat-line outgoing delivery-${job.status}`}
                        key={`delivery-${job.id}`}
                      >
                        <span className="chat-avatar">
                          <Bot size={17} />
                        </span>
                        <div className="chat-message">
                          <div className="chat-author">
                            <strong>{room?.account_name}</strong>
                            <time>{time(job.created_at)}</time>
                          </div>
                          <div className="chat-bubble">
                            {job.reply_to && (
                              <div className="chat-quote">
                                <Reply size={12} />
                                <span>引用消息 #{job.reply_to}</span>
                              </div>
                            )}
                            <p>{job.content}</p>
                            {job.image_asset_id && <ChatImage assetId={job.image_asset_id} />}
                          </div>
                          <div className="chat-message-foot">
                            <span className={`chat-delivery-state ${job.status}`}>
                              {['pending', 'in_flight', 'accepted'].includes(job.status) ? (
                                <Clock3 size={12} />
                              ) : (
                                <CircleAlert size={12} />
                              )}{' '}
                              {states[job.status] ?? job.status}
                            </span>
                            {job.status === 'failed' && job.retryable && (
                              <button
                                className="chat-reply"
                                disabled={retrying === job.id}
                                onClick={() => void retryDelivery(job)}
                              >
                                <RefreshCw size={12} />
                                重试
                              </button>
                            )}
                            {job.status === 'unknown' && (
                              <Link className="chat-reply" to={`/announcements?delivery=${job.id}`}>
                                核对结果 <ChevronRight size={12} />
                              </Link>
                            )}
                          </div>
                          {job.last_error && <small className="chat-reason">{job.last_error}</small>}
                        </div>
                      </article>
                    ))}
                  </>
                )}
              </div>
              {newMessages > 0 && (
                <button className="chat-jump-latest" onClick={jumpLatest}>
                  <ArrowDown size={14} />
                  有新消息，回到底部
                </button>
              )}
              <form
                className="chat-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                {reply && (
                  <div className={`composer-quote ${unavailableReply ? 'unavailable' : ''}`}>
                    <Reply size={16} />
                    <div>
                      <strong>回复 {reply.sender_name}</strong>
                      <p>
                        {unavailableReply
                          ? '原消息已删除，请取消引用'
                          : (replyState?.content ?? reply.content)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="取消引用回复"
                      disabled={!!sending[id!]}
                      onClick={() => {
                        if (!locks.current.has(id!)) {
                          forgetAttempt(id!);
                          setReplies((v) => ({ ...v, [id!]: undefined }));
                        }
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}
                {room?.send_error && (
                  <div className="composer-warning">
                    <CircleAlert size={14} />
                    {room.send_error}
                    <Link
                      to={
                        room.connection?.needs_relogin && room.connection?.login_available
                          ? `/accounts?relogin=${encodeURIComponent(room.account_id)}`
                          : '/accounts'
                      }
                    >
                      {room.connection?.needs_relogin && room.connection?.login_available
                        ? '重新登录币安'
                        : '检查连接'}
                    </Link>
                  </div>
                )}
                {id && sendErrors[id] && (
                  <div className="inbox-error" role="alert">
                    <CircleAlert size={14} />
                    {sendErrors[id]}
                  </div>
                )}
                <label className="sr-only" htmlFor="chat-reply-text">
                  聊天回复内容
                </label>
                <textarea
                  ref={textarea}
                  id="chat-reply-text"
                  value={draft}
                  maxLength={limit}
                  rows={2}
                  disabled={!room?.can_send || !!opening || !!(id && sending[id])}
                  placeholder={
                    opening
                      ? '正在切换社群，请稍候…'
                      : room?.can_send
                        ? '输入消息，继续这段讨论…'
                        : '恢复账号连接与发送权限后，即可回复'
                  }
                  onChange={(e) => {
                    const text = e.target.value;
                    if (text !== draft) forgetAttempt(id!);
                    setDrafts((v) => {
                      const next = { ...v };
                      delete next[id!];
                      return { ...next, [id!]: text };
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <span>
                    <span className="composer-identity">
                      <Bot size={13} />
                      {room?.account_name ?? '连接账号'}
                    </span>
                    <small title="草稿按管理员账号隔离，仅保留在当前浏览器标签页，最多保留最近 30 个群。">
                      {draft
                        ? draftPersisted
                          ? '草稿已保存，刷新后可继续'
                          : '草稿暂存在此页面，刷新前请复制'
                        : 'Ctrl / ⌘ + Enter 发送'}
                    </small>
                  </span>
                  <span className="composer-controls">
                    <small>
                      {draft.length} / {limit}
                    </small>
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={
                        !room?.can_send ||
                        !!opening ||
                        !draft.trim() ||
                        unavailableReply ||
                        !!(id && sending[id])
                      }
                    >
                      {id && sending[id] ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                      发送
                    </button>
                  </span>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </>
  );
}
