/**
 * Binance is reachable through more than one web origin. `www.binance.com` is the primary site;
 * some networks and regions get HTTP 403 from it while the login host still works, so a second
 * site is listed: an alternate origin that operators must check with Binance Verify themselves
 * before enabling it.
 *
 * Everything that carries the signed-in session — the chat page, its `/bapi` calls, the IM socket
 * and the cookies — belongs to one site. Credentials are never reused across sites.
 */
export const binanceSiteIds = ['official', 'backup'] as const;
export type BinanceSiteId = (typeof binanceSiteIds)[number];

export interface BinanceSite {
  id: BinanceSiteId;
  name: string;
  /** Origin that serves the chat page and the chat API. */
  host: string;
  login: string;
  chat: string;
  square: string;
  /** Root domains whose hosts may belong to this site, including subdomains. */
  domains: string[];
}

export const binanceSites: Record<BinanceSiteId, BinanceSite> = {
  official: {
    id: 'official',
    name: '币安官网',
    host: 'www.binance.com',
    login: 'https://accounts.binance.com/zh-CN/login',
    chat: 'https://www.binance.com/zh-CN/square/chat',
    square: 'https://www.binance.com/zh-CN/square',
    domains: ['binance.com'],
  },
  backup: {
    id: 'backup',
    name: '已核实备用站 www.qorscuxtbd.com',
    host: 'www.qorscuxtbd.com',
    login: 'https://www.qorscuxtbd.com/zh-CN/login',
    // The backup entry serves the Square rather than the newer /square/chat path. Check the
    // domain with Binance Verify before enabling it.
    chat: 'https://www.qorscuxtbd.com/zh-CN/square',
    square: 'https://www.qorscuxtbd.com/zh-CN/square',
    domains: ['qorscuxtbd.com'],
  },
};

export function binanceSite(id: string): BinanceSite {
  if (!Object.hasOwn(binanceSites, id)) throw new Error(`Unknown Binance site: ${id}`);
  return binanceSites[id as BinanceSiteId];
}

/** A host belongs to a site when it is the root domain or one of its subdomains. */
export function siteHostMatches(site: BinanceSite, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return site.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The site a page URL belongs to, or undefined for anything that is not a plain HTTPS page. */
export function binanceSiteOf(value: unknown): BinanceSite | undefined {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    return undefined;
  return Object.values(binanceSites).find((site) => siteHostMatches(site, url.hostname));
}

/** True when a URL is a page of this exact site (not just any Binance host). */
export function isSiteUrl(site: BinanceSite, value: unknown): boolean {
  return binanceSiteOf(value)?.id === site.id;
}

const deniedPage = /access denied|403 forbidden|the request could not be satisfied|请求被拒绝/i;
const challengePage =
  /安全验证|人机验证|security verification|verify you are human|just a moment|cf-mitigated/i;

/**
 * A page that answers with a browser-level refusal instead of Binance. `challenge` is something
 * the operator can finish in the window; `denied` means this network cannot use this site.
 */
export function pageRefusalKind(title: string, body = ''): 'challenge' | 'denied' | null {
  const text = `${title}\n${body.slice(0, 600)}`;
  if (challengePage.test(text)) return 'challenge';
  if (deniedPage.test(text)) return 'denied';
  return null;
}
