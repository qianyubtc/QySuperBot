import { useState } from 'react';
import { api } from './api';
export default function QQLogin({
  id,
  name,
  connected,
  close,
}: {
  id?: string;
  name?: string;
  connected: (result: any) => void;
  close: () => void;
}) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="demo-login">
      <div className="demo-login-symbol">QQ</div>
      <h3>QQ 扫码登录 · 模拟窗口</h3>
      <p>正式部署由 VPS 上的 QQ 客户端展示二维码。此处不生成真实二维码，也不读取手机信息。</p>
      <small>无需打开手机 QQ</small>
      {error && <p role="alert">{error}</p>}
      {!ready ? (
        <button className="btn" onClick={() => setReady(true)}>
          模拟手机确认
        </button>
      ) : (
        <button
          className="btn primary"
          onClick={() =>
            void api(id ? `/accounts/${id}/refresh` : '/accounts', {
              method: 'POST',
              body: { kind: 'qq', name: name ?? 'QQ 演示机器人' },
            })
              .then(connected)
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
