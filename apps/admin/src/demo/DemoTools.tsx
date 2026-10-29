import { useState, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { demo } from './api';
import { clearDemoInbox } from './storage';
import './demo.css';
export default function DemoTools() {
  const location = useLocation();
  const tools = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = tools.current;
    if (!node) return;
    const measure = () =>
      document.documentElement.style.setProperty(
        '--sandbox-height',
        node.getBoundingClientRect().height + 'px',
      );
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--sandbox-height');
    };
  }, []);
  const [notice, setNotice] = useState(''),
    [reset, setReset] = useState(false);
  const run = (fn: () => void) => {
    try {
      fn();
      setNotice('已在当前浏览器模拟新消息，前往实时消息查看。');
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  return (
    <aside ref={tools} className="sandbox-tools" aria-label="纯本地演示工具">
      <div>
        <strong>纯本地演示</strong>
        <span>虚拟数据仅保存在此浏览器，不连接真实账号。请勿输入真实 Token、密码或 Cookie。</span>
        {notice && <small role="status">{notice}</small>}
      </div>
      <div className="sandbox-actions">
        <button onClick={() => run(() => demo.simulate(location.pathname.match(/^\/inbox\/([^/]+)/)?.[1]))}>
          模拟新消息
        </button>
        <button onClick={() => setReset(!reset)}>重置演示</button>
        <a href="https://github.com/qianyubtc/QySuperBot" target="_blank" rel="noreferrer">
          开源代码 ↗
        </a>
      </div>
      {reset && (
        <div className="sandbox-reset" role="group" aria-label="确认重置演示">
          <span>清除本浏览器的演示修改、图片与草稿，恢复初始示例？</span>
          <button onClick={() => setReset(false)}>取消</button>
          <button
            onClick={() => {
              try {
                demo.reset();
                clearDemoInbox(sessionStorage);
                clearDemoInbox(localStorage);
                window.location.assign(location.pathname === '/' ? '/' : '/dashboard');
              } catch (e) {
                setNotice((e as Error).message);
              }
            }}
          >
            确认重置
          </button>
        </div>
      )}
    </aside>
  );
}
