import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  CircleCheck,
  Code2,
  Copy,
  ExternalLink,
  Gift,
  Menu,
  MessageCircle,
  MessageSquare,
  Image,
  Plug,
  Reply,
  Send,
  ShieldCheck,
  ShieldX,
  Server,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Users,
  VolumeX,
  Webhook,
  X,
} from 'lucide-react';

const repository = 'https://github.com/qianyubtc/QySuperBot';
const guide = repository + '/blob/main/docs/operations.md';
const deploymentGuide = repository + '/blob/main/docs/vps-deployment.md';
const connectorGuide = repository + '/blob/main/docs/custom-chat-integration.md';
const channels = [
  {
    id: 'tg',
    name: '千羽技术交流群',
    platform: 'Telegram',
    mark: 'TG',
    member: '小羽',
    text: '有 Telegram 和 QQ 两个群，也能在一个后台查看和回复吗？',
  },
  {
    id: 'qq',
    name: '产品体验群',
    platform: 'QQ',
    mark: 'QQ',
    member: '阿木',
    text: '今晚的功能介绍想定时发到群里，可以提前安排吗？',
  },
  {
    id: 'bn',
    name: '社群公开交流',
    platform: '币安聊天室',
    mark: 'BN',
    member: '小林',
    text: '币安的消息也能同步进来吗？我想在这里回复群友。',
  },
  {
    id: 'custom',
    name: '开发者讨论区',
    platform: '自定义源',
    mark: '</>',
    member: '林一',
    text: '我们的项目也有聊天功能，想接到这里统一处理。',
  },
] as const;
type DemoMessage = { text: string; quote?: string };
const features = [
  {
    icon: ShieldCheck,
    tag: '守护入群第一步',
    title: '活人验证',
    text: 'QQ 新成员可 @ 机器人或引用题目作答；Telegram 支持验证按钮。按群设置时限，跟进通过、超时与后续处理。',
  },
  {
    icon: ShieldX,
    tag: '把规则交给机器人',
    title: '广告拦截与黑名单',
    text: '关键词、域名与群级黑名单协同处理。从观察模式开始，再决定自动执行。',
  },
  {
    icon: Users,
    tag: '群秩序，有据可查',
    title: '踢人、封禁与成员管理',
    text: 'TG 的禁言、封禁与警告，QQ 的移出与验证处罚，币安直连的禁言、手动解禁与踢人，都有独立操作记录。',
    note: '币安踢人仅限免费普通群；真实操作待验收',
    noteIcon: VolumeX,
  },
  {
    icon: Gift,
    tag: '让社群参与进来',
    title: '社群抽奖',
    text: '群内指令报名，到期复查资格并自动开奖。固定结果，方便后续人工发奖。',
  },
  {
    icon: CalendarClock,
    tag: '重要消息，按时抵达',
    title: '图文群发与定时消息',
    text: '一张图片、一段说明，发往多个已选群。支持即时发布或单次定时发送，逐群跟进投递结果。',
  },
  {
    icon: Shuffle,
    tag: '连接讨论，也连接业务',
    title: '消息同步与项目 API',
    text: '审核通过的文本可单向、单跳同步到其他群。你的项目也能通过授权接口发送通知。',
  },
];
const platforms = [
  {
    name: 'Telegram',
    icon: Send,
    className: 'tg',
    state: 'Bot Token 接入',
    text: '连接机器人，管理已发现的群，在后台收消息、回复与安排活动。',
    connection: '填写 Bot Token，把机器人加入群并授予所需权限。',
    points: [
      '群消息与图片聚合',
      '图文群发与定时消息',
      '超级群限时禁言、封禁与警告',
      '按群开启管理员命令',
    ],
    management: '机器人实际获得的管理权限决定可用动作；执行前会再次核对。',
    limit: '群列表来自机器人已发现的会话。新群加入机器人后，发送一条消息再刷新列表。',
  },
  {
    name: 'QQ',
    icon: MessageCircle,
    className: 'qq',
    state: '后台扫码登录',
    text: '用专用 QQ 号连接普通群，在后台扫码登录，选择需要同步的群。',
    connection: '在后台打开 VPS QQ 登录窗口，手机扫码确认后连接此账号。',
    points: [
      '普通群消息、图片与头像',
      '入群申请自动审核',
      '@ 或引用回答活人验证',
      '验证超时处理与禁言后重试',
    ],
    management: '自动审核与验证分别配置。需要管理员权限的动作会在执行前重新核对。',
    limit: '采用个人号桥接；平台要求重新确认登录时，后台会显示状态并提供扫码入口。',
  },
  {
    name: '币安聊天室',
    icon: MessageSquare,
    className: 'bn',
    state: '支持服务器登录',
    text: '在后台完成服务器登录，由 VPS 持续同步，也可使用浏览器桥接。',
    connection: '在后台登录服务器上的币安账号，再勾选需要同步的聊天室。',
    points: ['文字与图文收发', '已加入聊天室自动发现', '直连禁言与手动解禁', '免费普通群移出成员'],
    management:
      '成员管理仅服务器直连可用。付费普通群支持单独禁言与解禁，踢人需在币安官方处理；VIP 社群暂不支持成员管理。',
    limit: '令牌失效时从后台重新登录。成员管理已通过隔离回归，真实写操作仍待验收。',
  },
  {
    name: '自定义源',
    icon: Webhook,
    className: 'custom',
    state: '协议已实现',
    text: '通过签名 HTTP 协议，把你自己的聊天项目接进统一后台。',
    connection: '实现连接器协议，上报群信息和消息，再接收后台发送的指令。',
    points: ['自有群与成员身份', '消息事件与执行回执', '按源声明管理能力', '项目 API 按群授权'],
    management: '可用功能由你的连接器声明，后台按已上报能力和账号权限开放操作。',
    limit: '需要在你的项目中实现消息收发及相应动作，接入不会自动获得所有群管能力。',
  },
];
const questions = [
  {
    q: '目前哪些平台可以接入？',
    a: '支持 Telegram、QQ、币安聊天室和自定义聊天源。QQ 可从后台扫码登录 VPS 上的专用账号；币安可在后台完成服务器登录，由 VPS 直连同步。连接后可选择需要同步的群，后续随时增删。Telegram 的群列表来自机器人已发现的会话。',
  },
  {
    q: '能在网页实时查看消息，也能直接回复吗？',
    a: '可以。后台聚合已选群的消息，显示昵称、头像和图片，支持在原群回复、引用、保留各群草稿和阅读位置。也可向前加载后台已保存的历史；接入前的全部平台历史不保证可用。消息更新速度取决于平台和连接状态。',
  },
  {
    q: '踢人、封禁和禁言都能直接执行吗？',
    a: '管理动作取决于平台能力和账号权限。QQ 已接入移除成员及入群验证处罚；Telegram 支持超级群限时禁言、封禁、警告和管理员命令。币安成员管理仅服务器直连可用，禁言持续至手动解禁，踢人仅限免费普通群；付费群踢人需在币安官方处理，VIP 社群暂不支持成员管理，真实写操作仍待验收。权限不支持或无法确认时会停止操作。',
  },
  {
    q: '群发支持图片和定时发送吗？',
    a: 'Telegram、QQ、币安均支持图片加说明或纯文字群发。选好目标群后预览内容，立即发布或按北京时间安排一次定时发送；不同平台的内容限制会在后台提示。每个群单独显示结果，待核对的投递不会自动重复发送。',
  },
  {
    q: 'QQ 自动审核后，怎么继续验证新成员？',
    a: '入群自动审核与活人验证需要分别按群开启。申请通过后，收到真实入群通知才发送验证题。新成员可真正 @ 机器人或引用这道题，直接回复数字答案。超时可转人工、按权限移出，或禁言 10 分钟、到期重新出题。每轮状态和处理结果都能在后台查看。',
  },
  {
    q: '可以部署到自己的服务器，接入自己的项目吗？',
    a: '可以。把工作空间部署到自己的 VPS，在网页连接账号、选择群和配置规则。项目 API 可按群授权，供你的业务发送通知并查询回执；自定义源则把你现有的聊天功能接到统一后台。部署与接入文档随开源代码提供。',
  },
];

function Brand({ footer = false }: { footer?: boolean }) {
  return (
    <a
      className={'lp-brand' + (footer ? ' lp-brand-footer' : '')}
      href="#top"
      aria-label="千羽 Superbot 返回页首"
    >
      <span className="lp-brand-icon">
        <Bot size={24} strokeWidth={1.7} />
      </span>
      <span>
        千羽 <b>Superbot</b>
        <small>ONE CONSOLE. EVERY COMMUNITY.</small>
      </span>
    </a>
  );
}

function ProductDemo() {
  const [active, setActive] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [quotes, setQuotes] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, DemoMessage[]>>({
    tg: [{ text: '可以，在统一后台查看和引用回复，消息会回到原群。', quote: channels[0].text }],
  });
  const input = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const channel = channels[active]!;
  const draft = drafts[channel.id] ?? '';
  const quoted = quotes[channel.id] ?? false;
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [channel.id]: value }));
  const setQuoted = (value: boolean) =>
    setQuotes((current) => ({ ...current, [channel.id]: value }));
  const sent = messages[channel.id] ?? [];
  useEffect(() => {
    const el = history.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, active]);
  function send() {
    const text = draft.trim();
    if (!text) return;
    setMessages((current) => ({
      ...current,
      [channel.id]: [
        ...(current[channel.id] ?? []),
        { text, ...(quoted ? { quote: channel.text } : {}) },
      ].slice(-20),
    }));
    setDraft('');
    setQuoted(false);
    input.current?.focus();
  }
  return (
    <div className="lp-product" aria-label="实时聚合聊天交互演示">
      <div className="lp-product-bar">
        <span className="lp-window-dots">
          <i />
          <i />
          <i />
        </span>
        <span>
          <ShieldCheck size={12} />
          千羽工作空间
        </span>
        <span className="lp-demo-indicator">
          <i />
          交互演示
        </span>
      </div>
      <div className="lp-product-body">
        <div className="lp-demo-rail" aria-hidden="true">
          <Bot size={21} />
          <div>
            <MessageSquare size={17} />
            <ShieldCheck size={17} />
            <Gift size={17} />
            <SlidersHorizontal size={17} />
          </div>
          <span>千</span>
        </div>
        <div className="lp-demo-groups">
          <strong>
            社群消息 <span>{channels.length}</span>
          </strong>
          <p>不同平台，同一处对话</p>
          {channels.map((c, index) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={index === active}
              className={index === active ? 'selected' : ''}
              onClick={() => setActive(index)}
            >
              <span className={'lp-platform-mark ' + c.id}>{c.mark}</span>
              <span>
                <b>{c.name}</b>
                <small>{c.platform}</small>
              </span>
              <i />
            </button>
          ))}
          <span className="lp-demo-groups-note">
            <Plug size={12} />
            统一接入 · 按源回复
          </span>
        </div>
        <div className="lp-demo-chat">
          <div className="lp-demo-room">
            <span>
              <strong>{channel.name}</strong>
              <small>{channel.platform} · 演示会话</small>
            </span>
            <span className="lp-demo-room-state">
              <i />
              消息聚合
            </span>
          </div>
          <div className="lp-demo-history" ref={history} role="log" aria-label="演示聊天记录">
            <div className="lp-demo-day">今天 · 产品演示</div>
            <div className="lp-demo-incoming">
              <span className="lp-demo-avatar">{channel.member.slice(0, 1)}</span>
              <div>
                <small>
                  {channel.member}
                  <time>09:41</time>
                </small>
                <p>{channel.text}</p>
                <button
                  type="button"
                  onClick={() => {
                    setQuoted(true);
                    input.current?.focus();
                  }}
                >
                  <Reply size={12} />
                  回复
                </button>
              </div>
            </div>
            {sent.length === 0 && (
              <div className="lp-demo-tip">
                <Sparkles size={13} />
                切换社群，试试聚合查看与回复
              </div>
            )}
            {sent.map((message, index) => (
              <div className="lp-demo-outgoing" key={index}>
                <div>
                  {message.quote && (
                    <blockquote>
                      <Reply size={11} />
                      <span>{message.quote}</span>
                    </blockquote>
                  )}
                  <p>{message.text}</p>
                  <small>
                    <CheckCheck size={11} />
                    演示发送完成
                  </small>
                </div>
                <span className="lp-demo-avatar">
                  <Bot size={15} />
                </span>
              </div>
            ))}
          </div>
          <form
            className="lp-demo-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            {quoted && (
              <div className="lp-demo-quote">
                <Reply size={12} />
                <span>回复 {channel.member}</span>
                <button type="button" aria-label="取消演示引用" onClick={() => setQuoted(false)}>
                  <X size={12} />
                </button>
              </div>
            )}
            <label className="sr-only" htmlFor="lp-demo-input">
              官网演示回复内容
            </label>
            <div>
              <input
                ref={input}
                id="lp-demo-input"
                value={draft}
                maxLength={140}
                placeholder="试着回复这段讨论…"
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" disabled={!draft.trim()} aria-label="发送演示回复">
                <Send size={16} />
              </button>
            </div>
            <small>
              <ShieldCheck size={10} />
              仅在当前页面演示，不发送到真实群
            </small>
          </form>
        </div>
      </div>
      <div className="lp-product-foot">
        <span>
          <CircleCheck size={12} />
          看见每一条消息，也接住每一次回应
        </span>
        <span>SUPERBOT / INBOX</span>
      </div>
    </div>
  );
}

function PlatformConnections() {
  const [active, setActive] = useState(0);
  const platform = platforms[active]!;
  return (
    <>
      <div className="lp-platform-grid" aria-label="选择平台查看接入说明">
        {platforms.map(({ name, icon: Icon, className, state, text }, index) => (
          <button
            type="button"
            className="lp-platform-card"
            key={name}
            aria-pressed={active === index}
            aria-controls="lp-platform-detail"
            onClick={() => setActive(index)}
          >
            <span className={'lp-platform-icon ' + className}>
              <Icon size={23} strokeWidth={1.7} />
            </span>
            <strong>{name}</strong>
            <span className="lp-platform-description">{text}</span>
            <span className="lp-support-state ready">
              <i />
              {state}
              <ArrowUpRight size={13} />
            </span>
          </button>
        ))}
      </div>
      <div id="lp-platform-detail" className="lp-platform-detail">
        <div>
          <span className="lp-eyebrow">{platform.name} · 接入与管理</span>
          <h3>{platform.connection}</h3>
          <p>{platform.management}</p>
          <Link className="lp-text-button" to="/accounts">
            连接{platform.name}
            <ArrowUpRight size={15} />
          </Link>
        </div>
        <div>
          <ul>
            {platform.points.map((point) => (
              <li key={point}>
                <CircleCheck size={15} />
                {point}
              </li>
            ))}
          </ul>
          <p className="lp-platform-limit">{platform.limit}</p>
        </div>
      </div>
    </>
  );
}

function BroadcastShowcase() {
  const [targets, setTargets] = useState(['Telegram', 'QQ', '币安']);
  const [timing, setTiming] = useState('scheduled');
  return (
    <div className="lp-broadcast-preview" aria-label="图文群发交互演示">
      <div className="lp-broadcast-top">
        <span>
          <Image size={17} />
          图文通知
        </span>
        <small>交互演示</small>
      </div>
      <div className="lp-poster" role="img" aria-label="社群分享会海报示意：一起聊聊，下一种可能">
        <span>QIAN YU / COMMUNITY</span>
        <strong>
          一起聊聊，
          <br />
          下一种可能。
        </strong>
        <small>社群分享会 · COMMUNITY TALK</small>
        <MessageCircle
          className="lp-poster-symbol"
          size={110}
          strokeWidth={0.7}
          aria-hidden="true"
        />
      </div>
      <p className="lp-broadcast-caption">
        今晚一起聊聊新功能与社群近况。欢迎带上你的想法，我们群里见。
      </p>
      <fieldset className="lp-broadcast-targets">
        <legend>试着选择发布平台</legend>
        {['Telegram', 'QQ', '币安'].map((target) => (
          <label key={target}>
            <input
              type="checkbox"
              checked={targets.includes(target)}
              onChange={({ currentTarget: { checked } }) =>
                setTargets((current) =>
                  checked
                    ? current.includes(target)
                      ? current
                      : [...current, target]
                    : current.filter((value) => value !== target),
                )
              }
            />
            {target}
          </label>
        ))}
      </fieldset>
      <div className="lp-broadcast-timing">
        <label htmlFor="lp-broadcast-time">
          <CalendarClock size={15} />
          发送时间
        </label>
        <select
          id="lp-broadcast-time"
          value={timing}
          onChange={(event) => setTiming(event.target.value)}
        >
          <option value="scheduled">今晚 20:00 · 北京时间</option>
          <option value="now">立即发送</option>
        </select>
      </div>
      <p className="lp-broadcast-summary" role="status">
        {targets.length
          ? `${timing === 'scheduled' ? '定时发布' : '立即发布'} · 已选 ${targets.length} 个演示社群`
          : '请选择至少一个演示平台'}
        <small>仅在当前页面演示，不创建任务或发送消息</small>
      </p>
    </div>
  );
}

function DeveloperExample() {
  const [tab, setTab] = useState<'send' | 'receipt'>('send');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendTab = useRef<HTMLButtonElement>(null);
  const receiptTab = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const example =
    tab === 'send'
      ? [
          'curl http://127.0.0.1:3000/api/v1/messages \\',
          '  -H "Authorization: Bearer YOUR_PROJECT_KEY" \\',
          '  -H "Content-Type: application/json" \\',
          '  -H "Idempotency-Key: release-001" \\',
          "  -d '{",
          '    "conversation_ids": ["GROUP_ID"],',
          '    "text": "新版本已发布，欢迎体验。"',
          "  }'",
        ].join('\n')
      : [
          'curl http://127.0.0.1:3000/api/v1/deliveries/DELIVERY_ID \\',
          '  -H "Authorization: Bearer YOUR_PROJECT_KEY"',
          '',
          '# DELIVERY_ID 来自发送接口返回的 delivery_ids',
          '# GROUP_ID 和项目 Key 在管理后台获取',
        ].join('\n');
  async function copy() {
    try {
      await navigator.clipboard.writeText(example);
      setCopied(true);
      setCopyError(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <div className="lp-code-panel">
      <div
        className="lp-code-tabs"
        role="tablist"
        aria-label="项目 API 示例"
        onKeyDown={(event) => {
          if (
            (event.target as HTMLElement).getAttribute('role') !== 'tab' ||
            !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          )
            return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'send'
              : event.key === 'End'
                ? 'receipt'
                : tab === 'send'
                  ? 'receipt'
                  : 'send';
          setTab(next);
          setCopied(false);
          setCopyError(false);
          (next === 'send' ? sendTab : receiptTab).current?.focus();
        }}
      >
        <button
          type="button"
          role="tab"
          id="lp-send-tab"
          ref={sendTab}
          tabIndex={tab === 'send' ? 0 : -1}
          aria-selected={tab === 'send'}
          aria-controls="lp-code"
          onClick={() => {
            setTab('send');
            setCopied(false);
            setCopyError(false);
          }}
        >
          发送消息
        </button>
        <button
          type="button"
          role="tab"
          id="lp-receipt-tab"
          ref={receiptTab}
          tabIndex={tab === 'receipt' ? 0 : -1}
          aria-selected={tab === 'receipt'}
          aria-controls="lp-code"
          onClick={() => {
            setTab('receipt');
            setCopied(false);
            setCopyError(false);
          }}
        >
          查询回执
        </button>
        <button
          type="button"
          className="lp-copy"
          onClick={() => void copy()}
          aria-label="复制 API 示例"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <div className="lp-code-file">
        <span />
        <span>terminal</span>
        <span>HTTP API</span>
      </div>
      <pre
        id="lp-code"
        role="tabpanel"
        aria-labelledby={tab === 'send' ? 'lp-send-tab' : 'lp-receipt-tab'}
        tabIndex={0}
      >
        <code>{example}</code>
      </pre>
      <div className="lp-code-foot" role="status">
        {copyError ? (
          '未能复制，请直接选中示例代码。'
        ) : copied ? (
          '示例已复制，请替换项目 Key 与群 ID。'
        ) : (
          <>
            <ShieldCheck size={12} />
            按群授权 · 幂等请求 · 可查询回执
          </>
        )}
      </div>
    </div>
  );
}

export default function Landing() {
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { hash } = useLocation();
  useLayoutEffect(() => {
    if (!hash) return;
    // The fragment may be visited before React has mounted its target section.
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [hash]);
  useEffect(() => {
    const previous = document.title;
    document.title = '千羽 Superbot · 一个工作台，连接每个社群';
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="landing" id="top">
      <a className="lp-skip" href="#lp-content">
        跳到主要内容
      </a>
      <header
        className="lp-header"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setMenu(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className="lp-container lp-nav">
          <Brand />
          <nav id="lp-navigation" className={menu ? 'open' : ''} aria-label="官网导航">
            <a href="#platforms" onClick={() => setMenu(false)}>
              平台接入
            </a>
            <a href="#features" onClick={() => setMenu(false)}>
              社群管理
            </a>
            <a href="#broadcast" onClick={() => setMenu(false)}>
              图文群发
            </a>
            <a href="#developers" onClick={() => setMenu(false)}>
              开发者
            </a>
            <a href="#faq" onClick={() => setMenu(false)}>
              常见问题
            </a>
          </nav>
          <div className="lp-nav-actions">
            <a
              className="lp-github"
              href={repository}
              target="_blank"
              rel="noreferrer"
              aria-label="在 GitHub 查看千羽 Superbot"
            >
              <Code2 size={19} />
            </a>
            <Link className="lp-button lp-button-small" to="/dashboard">
              {import.meta.env.MODE === 'demo' ? '体验演示' : '进入后台'}
              <ArrowUpRight size={15} />
            </Link>
            <button
              className="lp-menu"
              ref={menuButton}
              type="button"
              onClick={() => setMenu(!menu)}
              aria-expanded={menu}
              aria-controls="lp-navigation"
              aria-label={menu ? '关闭官网导航' : '打开官网导航'}
            >
              {menu ? <X size={21} /> : <Menu size={21} />}
            </button>
          </div>
        </div>
      </header>
      <main className="lp-main" id="lp-content">
        <section className="lp-hero lp-container" aria-labelledby="lp-title">
          <div className="lp-hero-copy">
            <div className="lp-eyebrow">
              <span />
              为多平台社群而生
            </div>
            <h1 id="lp-title">
              群在不同平台，
              <br />
              管理在<span>同一处。</span>
            </h1>
            <p className="lp-hero-description">
              Telegram、QQ、币安聊天室，还有你自己的聊天项目。
              <br />
              看消息、回复群友、管理成员、发布图文通知，
              <br />
              都在你的社群工作台里完成。
            </p>
            <div className="lp-hero-actions">
              <Link className="lp-button" to="/dashboard">
                {import.meta.env.MODE === 'demo' ? '体验演示控制台' : '开启社群工作台'}
                <ArrowRight size={17} />
              </Link>
              <a className="lp-text-button" href="#platforms">
                看看如何接入
                <ArrowDown size={15} />
              </a>
            </div>
            <div className="lp-hero-trust">
              <span>
                <Check size={13} />
                支持自托管
              </span>
              <span>
                <Check size={13} />
                自定义源接入
              </span>
              <span>
                <Check size={13} />
                项目 API
              </span>
            </div>
          </div>
          <div className="lp-hero-visual">
            <div className="lp-visual-orbit" aria-hidden="true" />
            <div className="lp-visual-label">
              <span />
              YOUR COMMUNITIES, CONNECTED.
            </div>
            <ProductDemo />
            <div className="lp-visual-caption">
              <span className="lp-caption-line" />
              <p>一个后台，让分散的对话重新连接。</p>
              <span>01 / CONVERSATIONS</span>
            </div>
          </div>
        </section>

        <div className="lp-container lp-workspace-links" aria-label="了解主要工作场景">
          <a href="#inbox">
            <MessageSquare size={21} />
            <span>
              <strong>对话聚合，回复回到原群</strong>
              <small>图片、头像、历史与各群独立草稿</small>
            </span>
            <ArrowUpRight size={16} />
          </a>
          <a href="#platforms">
            <Server size={21} />
            <span>
              <strong>专用账号，在后台连接</strong>
              <small>QQ 扫码、币安服务器登录、按群选择</small>
            </span>
            <ArrowUpRight size={16} />
          </a>
          <a href="#broadcast">
            <Image size={21} />
            <span>
              <strong>一份图文，发布到多个群</strong>
              <small>预览内容、安排时间、逐群跟进结果</small>
            </span>
            <ArrowUpRight size={16} />
          </a>
        </div>

        <section className="lp-platform-section" id="platforms" aria-labelledby="lp-platform-title">
          <div className="lp-container">
            <div className="lp-section-top">
              <div>
                <div className="lp-eyebrow">CONNECTED BY DESIGN</div>
                <h2 id="lp-platform-title">你的社群，都有接入的方式。</h2>
              </div>
              <p>
                选择平台，看看怎么连接、能做什么。
                <br />
                需要同步哪些群，由你决定。
              </p>
            </div>
            <PlatformConnections />
            <p className="lp-platform-note">
              <CircleCheck size={13} />
              Telegram、QQ、币安的真实文本与图文收发已验证。各平台管理能力不同，后台会说明不可用动作的原因。
            </p>
          </div>
        </section>

        <section
          className="lp-features lp-container"
          id="features"
          aria-labelledby="lp-feature-title"
        >
          <div className="lp-section-top">
            <div>
              <div className="lp-eyebrow">LESS REPETITION. MORE COMMUNITY.</div>
              <h2 id="lp-feature-title">
                从新成员入群，
                <br />
                到社群的每一天。
              </h2>
            </div>
            <p>
              从新成员入群到每一次活动发布，
              <br />
              把高频的运营动作，变成清晰的流程。
            </p>
          </div>
          <div className="lp-feature-grid">
            {features.map(({ icon: Icon, tag, title, text, note, noteIcon: NoteIcon }, index) => (
              <article className="lp-feature" key={title}>
                <div className="lp-feature-heading">
                  <span className="lp-feature-icon">
                    <Icon size={23} strokeWidth={1.55} />
                  </span>
                  <span>0{index + 1}</span>
                </div>
                <small>{tag}</small>
                <h3>{title}</h3>
                <p>{text}</p>
                {note && (
                  <span className="lp-feature-note">
                    {NoteIcon && <NoteIcon size={11} />}
                    {note}
                  </span>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="lp-sync" id="inbox" aria-labelledby="lp-sync-title">
          <div className="lp-container lp-sync-layout">
            <div className="lp-sync-copy">
              <div className="lp-eyebrow">EVERY MESSAGE HAS A WAY HOME</div>
              <h2 id="lp-sync-title">
                对话分散在各处，
                <br />
                <span>回应可以在一处。</span>
              </h2>
              <p>
                把多平台已接收消息聚合到管理后台。
                <br />
                看见昵称、头像与图片，带着上下文回复原群。
              </p>
              <Link className="lp-light-link" to="/inbox">
                打开实时消息
                <ArrowUpRight size={17} />
              </Link>
            </div>
            <div className="lp-flow" aria-label="平台消息聚合到后台，再回复原群或按规则同步的流程">
              <div className="lp-flow-sources">
                <span>
                  <Send size={15} />
                  Telegram
                </span>
                <span>
                  <MessageCircle size={15} />
                  QQ
                </span>
                <span>
                  <MessageSquare size={15} />
                  币安
                </span>
                <span>
                  <Webhook size={15} />
                  自定义源
                </span>
              </div>
              <div className="lp-flow-tracks" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <div className="lp-flow-hub">
                <span className="lp-hub-icon">
                  <Bot size={29} />
                </span>
                <div>
                  <strong>千羽 Superbot</strong>
                  <small>实时聚合 · 统一管理</small>
                </div>
                <span className="lp-hub-online">
                  <i />
                  管理后台
                </span>
              </div>
              <div className="lp-flow-outputs">
                <div>
                  <Reply size={19} />
                  <strong>回复原群</strong>
                  <small>按平台能力保留引用</small>
                </div>
                <div>
                  <Shuffle size={19} />
                  <strong>规则同步</strong>
                  <small>审核后单向转发文本</small>
                </div>
              </div>
              <div className="lp-flow-note">
                <ShieldCheck size={12} />
                发送结果按回执更新，不确定时进入人工核对
              </div>
            </div>
          </div>
          <div className="lp-container lp-sync-details">
            <span>
              <Image size={15} />
              图片、昵称与头像
            </span>
            <span>
              <MessageSquare size={15} />
              向前翻阅已存历史
            </span>
            <span>
              <SlidersHorizontal size={15} />
              各群独立草稿
            </span>
            <span>
              <CheckCheck size={15} />
              逐条投递状态
            </span>
          </div>
        </section>

        <section
          className="lp-broadcast lp-container"
          id="broadcast"
          aria-labelledby="lp-broadcast-title"
        >
          <div className="lp-broadcast-copy">
            <div className="lp-eyebrow">CREATE ONCE. REACH YOUR COMMUNITIES.</div>
            <h2 id="lp-broadcast-title">
              好内容，
              <br />
              值得让每个群看见。
            </h2>
            <p>活动海报、产品更新、官方通知或合作广告。把图片与说明准备好，剩下的交给发布流程。</p>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>先看清，再发布</strong>
                  <p>预览图文内容，按平台筛选目标群，核对字数与发送条件。</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>现在发送，或安排时间</strong>
                  <p>支持 Telegram、QQ、币安；定时任务统一按北京时间安排。</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>一群一条结果，跟进有依据</strong>
                  <p>成功、失败与待核对分开显示，不确定的投递不会自动重发。</p>
                </div>
              </li>
            </ol>
            <Link className="lp-text-button" to="/announcements">
              打开群发与通知
              <ArrowUpRight size={17} />
            </Link>
          </div>
          <BroadcastShowcase />
        </section>

        <section
          className="lp-developers lp-container"
          id="developers"
          aria-labelledby="lp-dev-title"
        >
          <div className="lp-dev-copy">
            <div className="lp-eyebrow">BUILT TO CONNECT</div>
            <h2 id="lp-dev-title">
              你的项目，
              <br />
              也能成为连接的一部分。
            </h2>
            <p>给现有业务留一个消息出口，也给自有聊天系统留一条双向通道。</p>
            <ul>
              <li>
                <span>
                  <Code2 size={18} />
                </span>
                <div>
                  <strong>用项目 API 发布消息</strong>
                  <p>按群和操作授权，业务通知发送后可查询投递回执。</p>
                </div>
              </li>
              <li>
                <span>
                  <Webhook size={18} />
                </span>
                <div>
                  <strong>用连接器接入自定义源</strong>
                  <p>签名事件上报、会话握手、群发现、外发执行与最终回执。</p>
                </div>
              </li>
            </ul>
            <a className="lp-text-button" href={connectorGuide} target="_blank" rel="noreferrer">
              阅读接入文档
              <ArrowUpRight size={16} />
            </a>
          </div>
          <DeveloperExample />
        </section>

        <section className="lp-start">
          <div className="lp-container">
            <div className="lp-section-top">
              <div>
                <div className="lp-eyebrow">MAKE IT YOURS</div>
                <h2>从第一个群，开始。</h2>
              </div>
              <a className="lp-text-button" href={deploymentGuide} target="_blank" rel="noreferrer">
                查看部署指南
                <ArrowUpRight size={16} />
              </a>
            </div>
            <ol className="lp-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>部署你的工作空间</h3>
                  <p>
                    运行服务，创建管理员。
                    <br />
                    消息和配置保存在自己的环境里。
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>连接账号与社群</h3>
                  <p>
                    填入 TG Token，或在后台完成扫码登录，
                    <br />
                    勾选同步群，再核对管理权限。
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>按你的节奏运营</h3>
                  <p>
                    从规则观察开始，安排消息与活动，
                    <br />
                    在实时工作台里跟进每次讨论。
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="lp-faq lp-container" id="faq" aria-labelledby="lp-faq-title">
          <div>
            <div className="lp-eyebrow">A FEW THINGS TO KNOW</div>
            <h2 id="lp-faq-title">
              开始之前，
              <br />
              你可能想知道。
            </h2>
            <p>能力、接入与边界，讲清楚再开始。</p>
          </div>
          <div className="lp-faq-items">
            {questions.map(({ q, a }) => (
              <details key={q}>
                <summary>
                  {q}
                  <ChevronDown size={17} />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lp-final">
          <div className="lp-container">
            <div>
              <span>让社群有序，让连接发生。</span>
              <h2>
                把下一段讨论，
                <br className="lp-mobile-break" />
                交给更从容的你。
              </h2>
            </div>
            <Link className="lp-button lp-button-lime" to="/dashboard">
              {import.meta.env.MODE === 'demo' ? '体验演示控制台' : '开启社群工作台'}
              <ArrowUpRight size={20} />
            </Link>
          </div>
        </section>
      </main>
      <footer className="lp-footer">
        <div className="lp-container">
          <Brand footer />
          <div>
            <a href={repository} target="_blank" rel="noreferrer">
              GitHub
              <ExternalLink size={12} />
            </a>
            <a href={deploymentGuide} target="_blank" rel="noreferrer">
              部署文档
              <ArrowUpRight size={12} />
            </a>
            <a href={guide} target="_blank" rel="noreferrer">
              使用指南
              <ArrowUpRight size={12} />
            </a>
            <Link to="/dashboard">
              管理后台
              <ArrowUpRight size={12} />
            </Link>
          </div>
          <small>
            千羽 Superbot · v0.1
            <br />
            MIT License · 为社群而构建
          </small>
        </div>
      </footer>
    </div>
  );
}
