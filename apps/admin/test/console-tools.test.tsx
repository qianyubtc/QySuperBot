import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { QuickNavigate } from '../src/ConsoleTools';

const pages = [
  { path: '/groups', label: '群组', icon: Bell },
  { path: '/inbox', label: '工作台', icon: Bell },
];
const groups = [
  { id: 'g-tg', name: '千羽宗', platform: 'telegram', external_id: '-100123', sync_enabled: true },
  { id: 'g-qq', name: 'QQ 测试群', platform: 'qq', external_id: '778899', sync_enabled: true },
  { id: 'g-off', name: '已下线群', platform: 'binance', external_id: '30001', sync_enabled: false },
];

function Location() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}
function mount() {
  let closed = 0;
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QuickNavigate groups={groups} pages={pages} close={() => (closed += 1)} />
      <Location />
    </MemoryRouter>,
  );
  return {
    input: () => screen.getByRole('combobox', { name: '搜索页面或社群' }),
    path: () => screen.getByTestId('path').textContent,
    closed: () => closed,
    titles: () => screen.queryAllByRole('option').map((o) => o.querySelector('strong')?.textContent),
  };
}

describe('quick switcher', () => {
  it('filters pages and groups by name, platform and id', () => {
    const palette = mount();
    expect(palette.titles()).toHaveLength(5);
    fireEvent.change(palette.input(), { target: { value: 'qq' } });
    expect(palette.titles()).toEqual(['QQ 测试群']);
    fireEvent.change(palette.input(), { target: { value: 'TELEGRAM' } });
    expect(palette.titles()).toEqual(['千羽宗']);
    fireEvent.change(palette.input(), { target: { value: '30001' } });
    expect(palette.titles()).toEqual(['已下线群']);
    // A page row must match its own name; the generic note used to make every page match "工作台".
    fireEvent.change(palette.input(), { target: { value: '工作台' } });
    expect(palette.titles()).toEqual(['工作台']);
    fireEvent.change(palette.input(), { target: { value: '不存在的群' } });
    expect(palette.titles()).toEqual([]);
    expect(screen.getByText(/没有找到匹配结果/)).toBeTruthy();
  });

  it('cycles the highlight with the arrow keys and opens the selection with Enter', () => {
    const palette = mount();
    fireEvent.change(palette.input(), { target: { value: '群' } });
    // A fresh query always restarts at the first row.
    expect(palette.input().getAttribute('aria-activedescendant')).toBe('quick-result-0');
    for (const expected of ['quick-result-1', 'quick-result-2', 'quick-result-0']) {
      fireEvent.keyDown(palette.input(), { key: 'ArrowDown' });
      expect(palette.input().getAttribute('aria-activedescendant')).toBe(expected);
    }
    fireEvent.keyDown(palette.input(), { key: 'ArrowUp' });
    expect(palette.input().getAttribute('aria-activedescendant')).toBe('quick-result-2');
    fireEvent.keyDown(palette.input(), { key: 'ArrowDown' });
    fireEvent.keyDown(palette.input(), { key: 'Enter' });
    expect(palette.path()).toBe('/groups');
    expect(palette.closed()).toBe(1);
  });

  it('opens an unsynced group settings page, and a synced group opens the workbench', () => {
    const palette = mount();
    fireEvent.change(palette.input(), { target: { value: '已下线' } });
    fireEvent.click(screen.getByRole('option'));
    expect(palette.path()).toBe('/groups/g-off');
    expect(palette.closed()).toBe(1);
    fireEvent.change(palette.input(), { target: { value: 'qq' } });
    fireEvent.keyDown(palette.input(), { key: 'Enter' });
    expect(palette.path()).toBe('/inbox/g-qq');
    expect(palette.closed()).toBe(2);
  });

  it('keeps the palette open when nothing matches', () => {
    const palette = mount();
    fireEvent.change(palette.input(), { target: { value: 'zzz' } });
    fireEvent.keyDown(palette.input(), { key: 'Enter' });
    expect(palette.path()).toBe('/dashboard');
    expect(palette.closed()).toBe(0);
  });
});
