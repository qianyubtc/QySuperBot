import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, Bot, LoaderCircle, MessagesSquare, Send, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { Data } from '../console/shared';
import './auth.css';

export default function Auth({
  setup,
  needsToken,
  done,
  themeButton,
}: {
  setup: boolean;
  needsToken: boolean;
  done: (v: Data) => void;
  themeButton?: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      done(
        await api(setup ? '/auth/setup' : '/auth/login', {
          method: 'POST',
          body: {
            username: form.get('username'),
            password: form.get('password'),
            ...(setup && needsToken ? { setup_token: form.get('setup_token') } : {}),
          },
        }),
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-corner">{themeButton}</div>
      <main className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">
            <Bot size={18} />
          </span>
          千羽 Superbot
        </div>
        <h1>{setup ? '创建你的工作空间' : '登录管理台'}</h1>
        <p className="auth-lead">
          {setup ? '设置第一个管理员账号，然后连接你的社群。' : '欢迎回来，继续今天的社群工作。'}
        </p>
        <form onSubmit={submit} className="stack-form">
          <label>
            用户名
            <input
              name="username"
              required
              minLength={2}
              maxLength={64}
              autoComplete="username"
              placeholder="管理员用户名"
              autoFocus
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              required
              minLength={setup ? 10 : 1}
              maxLength={256}
              autoComplete={setup ? 'new-password' : 'current-password'}
              placeholder={setup ? '至少 10 个字符' : '输入密码'}
            />
          </label>
          {setup && needsToken && (
            <label>
              初始化凭据
              <input
                type="password"
                name="setup_token"
                required
                autoComplete="off"
                placeholder="服务器配置的 ADMIN_SETUP_TOKEN"
              />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary lg block" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
            {setup ? '创建并进入' : '登录'}
          </button>
        </form>
        <ul className="auth-points" aria-label="管理台能力">
          <li>
            <MessagesSquare size={15} />
            多平台群消息集中收发
          </li>
          <li>
            <ShieldCheck size={15} />
            入群验证与广告治理
          </li>
          <li>
            <Send size={15} />
            图文群发与定时通知
          </li>
        </ul>
      </main>
      <p className="auth-foot">
        <ShieldCheck size={13} />
        凭据加密存储在你自己的服务器上
      </p>
    </div>
  );
}
