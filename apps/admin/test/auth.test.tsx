import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Auth from '../src/pages/Auth';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api', () => ({ api }));

const fill = (values: Record<string, string>) => {
  for (const [label, value] of Object.entries(values))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const submit = () => fireEvent.submit(document.querySelector('form')!);

beforeEach(() => api.mockReset());

describe('administrator sign-in', () => {
  it('logs in with the credentials and hands the session to the console', async () => {
    api.mockResolvedValue({ id: 'admin', csrf: 'token' });
    const done = vi.fn();
    render(<Auth setup={false} needsToken={false} done={done} />);
    expect(screen.getByRole('heading').textContent).toBe('登录管理台');
    expect(screen.queryByLabelText('初始化凭据')).toBeNull();
    fill({ 用户名: 'qianyu', 密码: 'secret-password' });
    submit();
    await waitFor(() => expect(done).toHaveBeenCalledWith({ id: 'admin', csrf: 'token' }));
    expect(api).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { username: 'qianyu', password: 'secret-password' },
    });
  });

  it('asks for the setup token during first-run setup and posts it', async () => {
    api.mockResolvedValue({ id: 'admin', csrf: 'token' });
    const done = vi.fn();
    render(<Auth setup needsToken done={done} />);
    expect(screen.getByRole('heading').textContent).toBe('创建你的工作空间');
    fill({ 用户名: 'qianyu', 密码: 'a-long-enough-password', 初始化凭据: 'setup-token' });
    submit();
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/auth/setup', {
      method: 'POST',
      body: {
        username: 'qianyu',
        password: 'a-long-enough-password',
        setup_token: 'setup-token',
      },
    });
  });

  it('shows the server error and lets the administrator retry', async () => {
    api.mockRejectedValueOnce(new Error('用户名或密码不正确')).mockResolvedValueOnce({ id: 'admin' });
    const done = vi.fn();
    render(<Auth setup={false} needsToken={false} done={done} />);
    fill({ 用户名: 'qianyu', 密码: 'wrong-password' });
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('用户名或密码不正确');
    expect(done).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fill({ 密码: 'right-password' });
    submit();
    await waitFor(() => expect(done).toHaveBeenCalledWith({ id: 'admin' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
