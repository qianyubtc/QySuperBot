import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api';
import './binance-login.css';

export default function BinanceLogin({
  id,
  windowId,
  connected,
  close,
  relogin = false,
}: {
  id: string;
  windowId: string;
  connected: (warning?: string) => void;
  close: () => void;
  relogin?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState('正在连接登录窗口…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState('正在打开官方登录页');
  const [revision, setRevision] = useState(0);
  const moveTime = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const node = canvas.current;
    const preventScroll = (e: WheelEvent) => e.preventDefault();
    node?.addEventListener('wheel', preventScroll, { passive: false });
    return () => {
      mounted.current = false;
      node?.removeEventListener('wheel', preventScroll);
    };
  }, []);
  useEffect(() => {
    let active = true,
      drawing = false,
      latest: string | undefined;
    const image = new Image();
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/accounts/${id}/binance-browser/socket?window_id=${encodeURIComponent(windowId)}`,
    );
    socket.current = ws;
    function draw(data: string) {
      drawing = true;
      image.onload = () => {
        if (!active || ws.readyState !== WebSocket.OPEN) return;
        canvas.current?.getContext('2d')?.drawImage(image, 0, 0, 1200, 800);
        setReady(true);
        setState('窗口已连接 · 点击画面即可操作');
        drawing = false;
        if (latest) {
          const next = latest;
          latest = undefined;
          draw(next);
        }
      };
      image.onerror = () => {
        drawing = false;
      };
      image.src = `data:image/jpeg;base64,${data}`;
    }
    ws.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        if (value.type === 'page' && typeof value.url === 'string') setPage(value.url);
        if (value.type === 'frame' && typeof value.data === 'string') {
          if (drawing) latest = value.data;
          else draw(value.data);
        }
      } catch {
        /* Incomplete display frames may be skipped. */
      }
    };
    ws.onclose = () => {
      if (active) {
        setReady(false);
        setState('窗口已断开，可重新连接；超过 15 分钟请关闭后重新打开。');
      }
    };
    ws.onerror = () => {
      if (active) setState('窗口连接失败，请尝试重新连接。');
    };
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 15_000);
    return () => {
      active = false;
      clearInterval(ping);
      image.onload = null;
      image.onerror = null;
      ws.close();
      if (socket.current === ws) socket.current = null;
    };
  }, [id, windowId, revision]);
  function send(value: Record<string, unknown>) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value));
  }
  function pointer(e: React.PointerEvent<HTMLCanvasElement>, action: string) {
    if (action === 'mouseMoved' && Date.now() - moveTime.current < 40) return;
    moveTime.current = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    send({
      type: 'pointer',
      action,
      x: Math.max(0, Math.min(1200, ((e.clientX - rect.left) / rect.width) * 1200)),
      y: Math.max(0, Math.min(800, ((e.clientY - rect.top) / rect.height) * 800)),
      button: action === 'mouseMoved' ? 'none' : (['left', 'middle', 'right'][e.button] ?? 'none'),
      buttons: e.buttons & 7,
    });
  }
  function key(e: React.KeyboardEvent<HTMLCanvasElement>, action: 'keyDown' | 'keyUp') {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    // Browser navigation shortcuts do not belong in the embedded login window.
    if ((e.ctrlKey || e.metaKey) && ['l', 't', 'n', 'w', 'r'].includes(e.key.toLowerCase())) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (action === 'keyDown') send({ type: 'text', text: e.key });
      return;
    }
    if (e.key.length > 30 || e.code.length > 30) return;
    send({
      type: 'key',
      action,
      // The hosted Chrome runs on Linux; Command shortcuts from a Mac map to Control.
      key: e.key === 'Meta' ? 'Control' : e.key,
      code: e.key === 'Meta' ? 'ControlLeft' : e.code,
      keyCode: e.key === 'Meta' ? 17 : e.keyCode,
      modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0),
    });
  }
  async function connect() {
    setBusy(true);
    setError('');
    try {
      const result = await api(`/accounts/${id}/binance-browser/connect`, {
        method: 'POST',
        body: { window_id: windowId },
      });
      if (mounted.current) connected(result.warning);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="binance-login">
      <div className="binance-login-guide">
        <strong>{relogin ? '重新登录，恢复同步' : '登录后由服务器持续同步'}</strong>
        <p>① 在下方窗口完成币安登录或验证　② 点击“连接此账号”　③ 验证成功后自动关闭窗口并恢复同步</p>
        {relogin && <p>请使用原来的币安账号。原群选择和历史消息保留，无需重新配对或复制令牌。</p>}
      </div>
      <div className="binance-login-status">
        <span className={ready ? 'login-dot online' : 'login-dot'} />
        {state}
        {!ready && (
          <button
            className="text-button"
            onClick={() => {
              setState('正在重新连接…');
              setRevision((v) => v + 1);
            }}
          >
            重新连接窗口
          </button>
        )}
      </div>
      <div className="binance-login-address" title={page}>
        {page}
      </div>
      <div className="binance-login-screen">
        {!ready && (
          <div className="binance-login-placeholder">
            <LoaderCircle size={26} className="spin" />
            <span>等待服务器画面</span>
          </div>
        )}
        <canvas
          ref={canvas}
          width={1200}
          height={800}
          tabIndex={0}
          aria-label="币安登录窗口，点击画面后可输入，支持粘贴文字"
          role="application"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            pointer(e, 'mousePressed');
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            pointer(e, 'mouseReleased');
          }}
          onPointerCancel={(e) => pointer(e, 'mouseReleased')}
          onPointerMove={(e) => pointer(e, 'mouseMoved')}
          onWheel={(e) => {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            send({
              type: 'pointer',
              action: 'mouseWheel',
              x: Math.max(0, Math.min(1200, ((e.clientX - r.left) / r.width) * 1200)),
              y: Math.max(0, Math.min(800, ((e.clientY - r.top) / r.height) * 800)),
              deltaX: Math.max(-5000, Math.min(5000, e.deltaX)),
              deltaY: Math.max(-5000, Math.min(5000, e.deltaY)),
            });
          }}
          onKeyDown={(e) => key(e, 'keyDown')}
          onKeyUp={(e) => key(e, 'keyUp')}
          onPaste={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const text = e.clipboardData.getData('text/plain');
            if (text && text.length <= 4096) send({ type: 'text', text });
          }}
          onCompositionEnd={(e) => {
            if (e.data && e.data.length <= 4096) send({ type: 'text', text: e.data });
          }}
        />
      </div>
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      <p className="binance-login-help">
        在窗口内完成币安登录、扫码或验证码，再连接此账号。连接时会读取必要登录凭据并加密保存到本服务器；验证失败可继续操作窗口。窗口关闭后保留此专用账号的登录会话。
      </p>
      <div className="binance-login-actions">
        <div>
          <button
            className="btn"
            disabled={busy || !ready}
            onClick={() => {
              void api(`/accounts/${id}/binance-browser/navigate`, {
                method: 'POST',
                body: { destination: 'login', window_id: windowId },
              }).catch((e) => setError(e.message));
            }}
          >
            打开登录页
          </button>
          <button
            className="btn"
            disabled={busy || !ready}
            onClick={() => {
              void api(`/accounts/${id}/binance-browser/navigate`, {
                method: 'POST',
                body: { window_id: windowId },
              }).catch((e) => setError(e.message));
            }}
          >
            <RefreshCw size={15} />
            打开聊天页
          </button>
        </div>
        <div>
          <button className="btn" disabled={busy} onClick={close}>
            关闭窗口
          </button>
          <button className="btn primary" disabled={busy || !ready} onClick={() => void connect()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}
            {busy ? '正在验证并连接…' : '连接此账号'}
          </button>
        </div>
      </div>
    </div>
  );
}
