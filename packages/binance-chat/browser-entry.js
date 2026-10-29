(() => {
  if (
    location.origin !== 'https://www.binance.com' ||
    !/\/(?:chatroom|square\/chat|chatWidgetEntrance)\/?$/.test(location.pathname)
  )
    return;
  const client = createBinanceChatClient({
    fetch: (...args) => fetch(...args),
    cookie(name) {
      const value = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(name + '='));
      try {
        return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
      } catch {
        return '';
      }
    },
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'qsb-binance-request') return;
    void client.request(message).then(
      (data) => respond({ ok: true, data }),
      (error) =>
        respond({
          ok: false,
          error: {
            ...(error?.bridgeError ?? {
              code: 'FORMAT',
              stage: ['profile', 'group', 'history', 'send'].includes(message.operation)
                ? message.operation
                : 'validation',
            }),
            ...(message.operation === 'send_image' ? { effect: error?.bridgeError?.effect ?? 'none' } : {}),
          },
        }),
    );
    return true;
  });
  window.addEventListener('pagehide', () => client.close());
})();
