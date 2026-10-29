import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Landing from './Landing';

import './styles.css';
import './inbox.css';
import './landing.css';
import './console.css';

const App = React.lazy(() => import('./App'));
const DemoTools =
  import.meta.env.MODE === 'demo' ? React.lazy(() => import('./demo/DemoTools')) : null;

class WorkspaceLoadBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="workspace-entry-state" role="alert">
        <span>千羽 Superbot</span>
        <h1>工作台暂时未能加载</h1>
        <p>网络可能暂时中断，或页面版本已更新。请刷新页面后重试。</p>
        <div>
          <button className="btn primary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
          <a className="btn" href="/">
            返回介绍页
          </a>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {DemoTools && (
        <React.Suspense fallback={null}>
          <DemoTools />
        </React.Suspense>
      )}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="*"
          element={
            <WorkspaceLoadBoundary>
              <React.Suspense
                fallback={
                  <main className="workspace-entry-state" role="status">
                    正在打开工作台…
                  </main>
                }
              >
                <App />
              </React.Suspense>
            </WorkspaceLoadBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
