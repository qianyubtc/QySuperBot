type DirectoryGroup = {
  id: string;
  name: string;
  member_count?: number | null;
  messages_24h?: number;
  last_at?: string | null;
};

export function sortDirectory<T extends DirectoryGroup>(groups: T[], order: string): T[] {
  return [...groups].sort((a, b) => {
    const difference =
      order === 'members'
        ? Number(b.member_count ?? -1) - Number(a.member_count ?? -1)
        : order === 'activity'
          ? Number(b.messages_24h ?? 0) - Number(a.messages_24h ?? 0)
          : 0;
    return difference || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
  });
}

export function filterChatScope<T extends { id: string }>(
  groups: T[],
  scope: string,
  unread: Set<string>,
  drafts: Record<string, string>,
): T[] {
  return groups.filter((group) =>
    scope === 'unread' ? unread.has(group.id) : scope === 'drafts' ? !!drafts[group.id]?.trim() : true,
  );
}

export function selectedAvailableIds(ids: string[], groups: { id: string; sync_enabled?: boolean }[]) {
  const available = new Set(groups.filter((group) => group.sync_enabled !== false).map((group) => group.id));
  return [...new Set(ids)].filter((id) => available.has(id));
}
