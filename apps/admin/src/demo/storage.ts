export function clearDemoInbox(storage: Pick<Storage, 'removeItem'>) {
  for (const kind of ['drafts', 'sends', 'quotes']) storage.removeItem(`superbot:inbox-${kind}:demo-admin`);
}
