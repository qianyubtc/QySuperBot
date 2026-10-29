import { useState } from 'react';
import { api } from './api';
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
    <div className="demo-login">
      <div className="demo-login-symbol">BN</div>
      <h3>币安服务器登录 · 模拟窗口</h3>
      <p>
        正式部署可在这里操作 VPS 浏览器完成登录。此处只演示连接步骤，不打开币安，也不采集任何凭据。
      </p>
      <small>无需扫码、密码或验证码</small>
      {error && <p role="alert">{error}</p>}
      {!ready ? (
        <button className="btn" onClick={() => setReady(true)}>
          模拟完成登录
        </button>
      ) : (
        <button
          className="btn primary"
          onClick={() =>
            void api(`/accounts/${id}/binance-browser/connect`, { method: 'POST' })
              .then(() => connected('已恢复本地演示连接'))
              .catch((e) => setError(e.message))
          }
        >
          连接此虚拟账号
        </button>
      )}
      <button className="btn" onClick={close}>
        关闭窗口
      </button>
    </div>
  );
}
