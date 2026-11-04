import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from './api';
import '../login-flow.css';
import '../binance-login.css';
export default function BinanceLogin({
  id,
  connected,
  close,
}: {
  id: string;
  windowId: string;
  connected: (warning?: string) => void;
  close: () => void;
  relogin?: boolean;
}) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="binance-login">
      <ol className="login-steps">
        {['在窗口中登录币安', '连接此账号', '服务器持续同步'].map((label, index) => (
          <li
            key={label}
            className={index === (ready ? 1 : 0) ? 'current' : index < (ready ? 1 : 0) ? 'done' : ''}
          >
            {label}
          </li>
        ))}
      </ol>
      <div className="binance-window">
        <div className="binance-window-bar">
          <span className="login-dot online" />
          <span className="binance-window-url">本地演示 · 不打开币安，不采集任何凭据</span>
        </div>
        <div className="binance-login-screen demo-login-screen">
          {ready ? <CheckCircle2 size={48} /> : <span className="demo-login-symbol">BN</span>}
          <strong>{ready ? '模拟登录完成，可以连接' : '币安服务器登录 · 模拟窗口'}</strong>
          <p>正式部署可在这里操作服务器上的浏览器完成登录，无需扫码、密码或验证码。</p>
          {!ready && (
            <button className="btn" onClick={() => setReady(true)}>
              模拟完成登录
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <footer className="login-foot">
        <small>本地演示</small>
        <button className="btn" onClick={close}>
          关闭窗口
        </button>
        <button
          className="btn primary"
          disabled={!ready}
          onClick={() =>
            void api(`/accounts/${id}/binance-browser/connect`, { method: 'POST' })
              .then(() => connected('已恢复本地演示连接'))
              .catch((e) => setError(e.message))
          }
        >
          连接此虚拟账号
        </button>
      </footer>
    </div>
  );
}
