import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from './api';
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
  return (
    <div className="qq-login-panel">
      <div className="qq-login-state" role="status">
        <strong>
          {ready
            ? 'VPS 上的 QQ 已登录'
            : data?.login_accepted
              ? '已扫码，正在等待手机确认及 QQ 初始化'
              : data?.qr_value
                ? '请用手机 QQ 扫码，并在手机确认'
                : data
                  ? '正在等待 QQ 登录服务准备二维码…'
                  : '正在核对 VPS QQ 状态…'}
        </strong>
        {data?.current_id && <p>当前 QQ：{data.current_id}</p>}
        {data?.expected_id && <p>此连接绑定 QQ：{data.expected_id}</p>}
        {!ready && data?.phase && (
          <small>
            登录阶段：
            {(
              {
                waiting_qrcode: '等待扫码',
                qrcode_scanned: '已扫码，等待确认',
                initializing: '登录成功，正在初始化',
                reconnecting: '正在恢复登录服务',
                ready: '正在核对在线状态',
              } as Record<string, string>
            )[data.phase] ?? data.phase}
          </small>
        )}
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      {data?.error && !ready && (
        <div className="form-error" role="alert">
          {data.error}
        </div>
      )}
      {data?.identity_mismatch && (
        <div className="form-error" role="alert">
          当前 QQ 与此连接不一致。请恢复原 QQ；如需更换账号，先暂停旧连接，再从“添加连接”登记新账号。
        </div>
      )}
      {data?.qr_value && !ready && (
        <div className="qq-login-qr">
          <QRCodeSVG value={data.qr_value} size={240} level="M" marginSize={4} title="VPS QQ 登录二维码" />
          <p>二维码仅供本次登录使用，请在手机 QQ 中确认。</p>
        </div>
      )}
      <p className="muted">
        登录后点击连接，自动登记账号并读取群列表。此 VPS 当前使用一个 QQ
        登录实例；关闭窗口会保留已建立的登录状态。
      </p>
      <div className="qq-login-actions">
        {!ready && (
          <button
            className="btn"
            disabled={busy || !data?.available || data?.login_accepted}
            onClick={() => void action('refresh')}
          >
            刷新二维码
          </button>
        )}
        {!ready && id && (
          <button
            className="btn"
            disabled={busy || !data?.available || data?.login_accepted}
            onClick={() => void action('quick')}
          >
            尝试原账号快速登录
          </button>
        )}
        <button
          className="btn primary"
          disabled={busy || !ready || data?.identity_mismatch}
          onClick={() => void action('connect')}
        >
          {busy ? '正在验证连接…' : data?.paused ? '恢复并连接此账号' : '连接此账号'}
        </button>
        <button className="btn" disabled={busy} onClick={close}>
          关闭
        </button>
      </div>
    </div>
  );
}
