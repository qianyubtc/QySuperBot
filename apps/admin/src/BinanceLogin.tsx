import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api';
import './login-flow.css';
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
  const pendingMove = useRef<Record<string, unknown> | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const node = canvas.current;
    const preventScroll = (e: WheelEvent) => e.preventDefault();
    node?.addEventListener('wheel', preventScroll, { passive: false });
    return () => {
      mounted.current = false;
      clearTimeout(moveTimer.current);
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
        // The server sends the next (newest) frame only after this, so a slow link never
        // queues up stale frames ahead of the result of a click.
        ws.send(JSON.stringify({ type: 'frame_ack' }));
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
    ws.onclose = (event) => {
      if (!active) return;
      setReady(false);
      setState(
        event.code === 1008
          ? '登录窗口已失效（会话过期、账号已暂停或超时），请关闭后重新打开。'
          : '窗口已断开，可重新连接；超过 15 分钟请关闭后重新打开。',
      );
    };
    ws.onerror = () => {
      if (active)
        setState('窗口连接失败：若后台经过反向代理，请确认已转发 WebSocket（Upgrade / Connection）。');
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
    const rect = e.currentTarget.getBoundingClientRect();
    const value = {
      type: 'pointer',
      action,
      x: Math.max(0, Math.min(1200, ((e.clientX - rect.left) / rect.width) * 1200)),
      y: Math.max(0, Math.min(800, ((e.clientY - rect.top) / rect.height) * 800)),
      button: action === 'mouseMoved' ? 'none' : (['left', 'middle', 'right'][e.button] ?? 'none'),
      buttons: e.buttons & 7,
    };
    if (action === 'mouseMoved') {
      // At most one move every 40 ms, but the last position always arrives (hover menus).
      pendingMove.current = value;
      if (!moveTimer.current)
        moveTimer.current = setTimeout(
          () => {
            moveTimer.current = undefined;
            moveTime.current = Date.now();
            if (pendingMove.current) send(pendingMove.current);
            pendingMove.current = null;
          },
          Math.max(0, moveTime.current + 40 - Date.now()),
        );
      return;
    }
    // A press or release carries its own position; an older queued move must not follow it.
    clearTimeout(moveTimer.current);
    moveTimer.current = undefined;
    pendingMove.current = null;
    moveTime.current = Date.now();
    send(value);
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
      <ol className="login-steps">
        {['在窗口中登录币安', '连接此账号', '服务器持续同步'].map((label, index) => (
          <li
            key={label}
            className={index === (busy ? 1 : 0) ? 'current' : index < (busy ? 1 : 0) ? 'done' : ''}
          >
            {label}
          </li>
        ))}
      </ol>
      {relogin && <p className="login-note">请使用原来的币安账号登录；原群选择和历史消息都会保留。</p>}
      <div className="binance-window">
        <div className="binance-window-bar">
          <span className={ready ? 'login-dot online' : 'login-dot'} title={state} />
          <span className="binance-window-url" title={page}>
            {page}
          </span>
          {ready ? (
            <>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  void api(`/accounts/${id}/binance-browser/navigate`, {
                    method: 'POST',
                    body: { destination: 'login', window_id: windowId },
                  }).catch((e) => setError(e.message));
                }}
              >
                登录页
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  void api(`/accounts/${id}/binance-browser/navigate`, {
                    method: 'POST',
                    body: { window_id: windowId },
                  }).catch((e) => setError(e.message));
                }}
              >
                <RefreshCw size={12} /> 聊天页
              </button>
            </>
          ) : (
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
        <div className="binance-login-screen">
          {!ready && (
            <div className="binance-login-placeholder">
              <LoaderCircle size={26} className="spin" />
              <span>{state}</span>
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
      </div>
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      <footer className="login-foot">
        <small>{ready ? '登录凭据加密保存在本服务器' : state}</small>
        <button className="btn" disabled={busy} onClick={close}>
          关闭窗口
        </button>
        <button className="btn primary" disabled={busy || !ready} onClick={() => void connect()}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}
          {busy ? '正在验证并连接…' : '连接此账号'}
        </button>
      </footer>
    </div>
  );
}
