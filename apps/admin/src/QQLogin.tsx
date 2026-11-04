import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api';
import './login-flow.css';
import './qq-login.css';

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
  const endpoint = id ? `/accounts/${id}/qq-login` : '/qq-local/login';
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api(endpoint, { signal: ctrl.signal });
        if (!ctrl.signal.aborted) {
          setData(value);
          setError('');
        }
      } catch (e: any) {
        if (!ctrl.signal.aborted) {
          setError(e.message);
          setData(undefined);
        }
      } finally {
        if (!ctrl.signal.aborted) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [endpoint]);
  async function action(action: string) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      const result = await api(endpoint + '/' + action, {
        method: 'POST',
        ...(action === 'connect'
          ? { body: { ...(name ? { name } : {}), resume: data?.paused === true } }
          : {}),
      });
      if (action === 'connect') connected(result);
      else setData(await api(endpoint));
    } catch (e: any) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const ready = data?.is_login === true && data?.core_ready === true;
  const step = ready
    ? 3
    : ['initializing', 'reconnecting', 'ready'].includes(data?.phase)
      ? 2
      : data?.login_accepted || data?.phase === 'qrcode_scanned'
        ? 1
        : 0;
  const problems = [
    error,
    actionError,
    !ready && data?.error,
    data?.identity_mismatch &&
      '当前 QQ 与此连接不一致。请恢复原 QQ；如需更换账号，先暂停旧连接，再添加新连接。',
  ].filter(Boolean) as string[];
  return (
    <div className="qq-login">
      <ol className="login-steps">
        {['扫码', '手机确认', '初始化', '连接账号'].map((label, index) => (
          <li key={label} className={index < step ? 'done' : index === step ? 'current' : ''}>
            {label}
          </li>
        ))}
      </ol>
      <div className="qq-login-body">
        <div className={`qq-login-code ${ready ? 'ready' : ''}`}>
          {ready ? (
            <CheckCircle2 size={56} />
          ) : data?.qr_value ? (
            <QRCodeSVG value={data.qr_value} size={200} level="M" marginSize={3} title="QQ 登录二维码" />
          ) : (
            <LoaderCircle size={28} className="spin" />
          )}
        </div>
        <div className="qq-login-info" role="status">
          <strong>
            {ready
              ? 'QQ 已登录，可以连接'
              : data?.login_accepted
                ? '已扫码，请在手机上确认'
                : data?.qr_value
                  ? '用手机 QQ 扫描二维码'
                  : data
                    ? '正在准备二维码…'
                    : '正在核对 QQ 状态…'}
          </strong>
          <p>
            {ready
              ? '连接后自动登记账号并读取群列表。'
              : step === 2
                ? '登录成功，QQ 正在初始化，稍候片刻。'
                : '二维码只用于本次登录，扫码后在手机上点确认。'}
          </p>
          {(data?.current_id || data?.expected_id) && (
            <dl className="qq-login-ids">
              {data?.current_id && (
                <div>
                  <dt>当前 QQ</dt>
                  <dd>{data.current_id}</dd>
                </div>
              )}
              {data?.expected_id && (
                <div>
                  <dt>此连接绑定</dt>
                  <dd>{data.expected_id}</dd>
                </div>
              )}
            </dl>
          )}
          {problems.map((text) => (
            <div key={text} className="form-error" role="alert">
              {text}
            </div>
          ))}
          {!ready && (
            <div className="qq-login-retry">
              <button
                className="text-button"
                disabled={busy || !data?.available || data?.login_accepted}
                onClick={() => void action('refresh')}
              >
                <RefreshCw size={13} /> 刷新二维码
              </button>
              {id && (
                <button
                  className="text-button"
                  disabled={busy || !data?.available || data?.login_accepted}
                  onClick={() => void action('quick')}
                >
                  尝试原账号快速登录
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="login-foot">
        <small>关闭窗口会保留已建立的登录状态</small>
        <button className="btn" disabled={busy} onClick={close}>
          关闭
        </button>
        <button
          className="btn primary"
          disabled={busy || !ready || data?.identity_mismatch}
          onClick={() => void action('connect')}
        >
          {busy ? '正在验证连接…' : data?.paused ? '恢复并连接此账号' : '连接此账号'}
        </button>
      </footer>
    </div>
  );
}
