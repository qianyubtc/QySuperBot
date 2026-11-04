import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from './api';
import '../login-flow.css';
import '../qq-login.css';
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
    <div className="qq-login">
      <ol className="login-steps">
        {['扫码', '手机确认', '初始化', '连接账号'].map((label, index) => (
          <li key={label} className={ready ? (index < 3 ? 'done' : 'current') : index === 0 ? 'current' : ''}>
            {label}
          </li>
        ))}
      </ol>
      <div className="qq-login-body">
        <div className={`qq-login-code demo-login-code ${ready ? 'ready' : ''}`}>
          {ready ? <CheckCircle2 size={56} /> : <span className="demo-login-symbol">QQ</span>}
        </div>
        <div className="qq-login-info" role="status">
          <strong>{ready ? '模拟登录完成，可以连接' : 'QQ 扫码登录 · 模拟窗口'}</strong>
          <p>正式部署由服务器上的 QQ 客户端展示二维码。这里不生成真实二维码，也不读取手机信息。</p>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {!ready && (
            <div className="qq-login-retry">
              <button className="btn" onClick={() => setReady(true)}>
                模拟手机确认
              </button>
            </div>
          )}
        </div>
      </div>
      <footer className="login-foot">
        <small>本地演示，无需打开手机 QQ</small>
        <button className="btn" onClick={close}>
          关闭
        </button>
        <button
          className="btn primary"
          disabled={!ready}
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
      </footer>
    </div>
  );
}
