import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, Copy, ExternalLink, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Data = Record<string, any>;
const platforms: Record<string, string> = {
  telegram: 'Telegram',
  qq: 'QQ',
  binance: '币安',
  custom: '自有聊天',
};

export function CopyButton({ value, label = '复制 ID' }: { value: string; label?: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(''), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <span className="copy-control">
      <button
        type="button"
        className="icon-btn copy-id"
        title={status === 'copied' ? '已复制' : label}
        aria-label={status === 'copied' ? '已复制' : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus('copied');
          } catch {
            setStatus('failed');
          }
        }}
      >
        {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {status && <small role="status">{status === 'copied' ? '已复制' : '复制失败，请手动选择 ID'}</small>}
    </span>
  );
}

export function QuickNavigate({
  groups,
  pages,
  close,
}: {
  groups: Data[];
  pages: { path: string; label: string; icon: LucideIcon }[];
  close: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const resultList = useRef<HTMLDivElement>(null);
  const queryText = query.trim().toLocaleLowerCase();
  const results = [
    ...pages.map((p) => ({ id: p.path, title: p.label, note: '工作台页面', path: p.path })),
    ...groups.map((g) => ({
      id: g.id,
      title: g.name,
      note: `${platforms[g.platform] ?? g.platform} · ${g.external_id}${g.sync_enabled === false ? ' · 未同步' : ''}`,
      path: g.sync_enabled === false ? `/groups/${g.id}` : `/inbox/${g.id}`,
    })),
  ]
    .filter((item) => `${item.title} ${item.note}`.toLocaleLowerCase().includes(queryText))
    .slice(0, 12);
  const selected = Math.min(index, Math.max(0, results.length - 1));
  useEffect(() => {
    resultList.current
      ?.querySelector<HTMLElement>(`#quick-result-${selected}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected, query]);
  const open = (path: string) => {
    close();
    navigate(path);
  };
  return (
    <div className="quick-navigate">
      <div className="quick-search">
        <Search size={20} />
        <input
          data-autofocus
          role="combobox"
          aria-label="搜索页面或社群"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="quick-results"
          aria-activedescendant={results[selected] ? `quick-result-${selected}` : undefined}
          autoComplete="off"
          placeholder="搜索页面、群名称或群 ID…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
              e.preventDefault();
              setIndex(
                (i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1),
              );
            }
            if (e.key === 'Enter' && results[selected]) {
              e.preventDefault();
              open(results[selected]!.path);
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <p className="quick-caption">{query ? `${results.length} 个匹配结果` : '快速打开页面或社群'}</p>
      <div id="quick-results" ref={resultList} role="listbox" aria-label="搜索结果" className="quick-results">
        {results.map((item, i) => (
          <button
            key={item.id}
            id={`quick-result-${i}`}
            role="option"
            aria-selected={selected === i}
            className={selected === i ? 'selected' : ''}
            onMouseMove={() => setIndex(i)}
            onClick={() => open(item.path)}
          >
            <span>
              <strong>{item.title}</strong>
              <small>{item.note}</small>
            </span>
            <ArrowUpRight size={17} />
          </button>
        ))}
        {!results.length && <p className="quick-no-results">没有找到匹配结果，试试群 ID 或平台名称。</p>}
      </div>
      <div className="quick-help">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> 选择
        </span>
        <span>
          <kbd>Enter</kbd> 打开
        </span>
      </div>
    </div>
  );
}

export function ImageViewer({ src, close }: { src: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="image-viewer-dialog"
      aria-label="查看聊天图片"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <header>
        <strong>图片预览</strong>
        <span>Esc 关闭</span>
        <a href={src} target="_blank" rel="noreferrer">
          <ExternalLink size={16} /> 打开原图
        </a>
        <button type="button" className="icon-btn" onClick={close} aria-label="关闭图片预览">
          <X size={22} />
        </button>
      </header>
      <div className="image-viewer-content">
        {failed ? (
          <p>图片暂时无法加载，请关闭后重试。</p>
        ) : (
          <img src={src} alt="聊天图片大图" onError={() => setFailed(true)} referrerPolicy="no-referrer" />
        )}
      </div>
    </dialog>
  );
}
