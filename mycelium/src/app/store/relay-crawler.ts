// Relay Crawler — Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';
import { Relay } from '../../nostr/relay';
import type { NostrEvent } from '../../nostr/event';
import type { NostrFilter } from '../../nostr/filter';
import { getPool } from './relay';
import { getIndexerUrls } from './indexers';

const BASE = '/api/cache';

export interface PopularRelay { url: string; count: number; }
export interface CrawlerRelay {
  relay: Relay; url: string; rtt: number;
  source: 'popular' | 'indexer' | 'pool';
  lastUsed: number; connectAttempts: number;
}
export interface CrawlOptions {
  maxRelays?: number; timeout?: number;
  preferIndexers?: boolean;
  sources?: ('popular' | 'indexer' | 'pool')[];
}

interface CrawlerState {
  popularRelays: PopularRelay[];
  crawlerRelays: Map<string, CrawlerRelay>;
  isLoadingPopular: boolean;
  lastPopularFetch: number;
}

export const crawlerState = signal<CrawlerState>({
  popularRelays: [], crawlerRelays: new Map(),
  isLoadingPopular: false, lastPopularFetch: 0,
});

let idleTimer: ReturnType<typeof setInterval> | null = null;
const IDLE_TIMEOUT = 60_000;
const POPULAR_REFRESH_MS = 30 * 60 * 1000;
const seenEvents = new Set<string>();
const MAX_SEEN = 20000;

export function getCrawlerState() { return crawlerState.value; }

export function getDiscoveryRelayUrls(): string[] {
  const pool = getPool();
  const poolUrls = new Set(pool.allRelays.map((r) => r.url));
  const ixUrls = new Set(getIndexerUrls());
  const popUrls = crawlerState.value.popularRelays.map((r) => r.url);
  const result: string[] = [];
  for (const u of ixUrls) result.push(u);
  for (const u of popUrls) { if (!ixUrls.has(u) && !poolUrls.has(u)) result.push(u); }
  return result;
}

export async function loadPopularRelays(limit = 25): Promise<void> {
  const s = crawlerState.value;
  const now = Date.now();
  if (s.isLoadingPopular) return;
  if (now - s.lastPopularFetch < POPULAR_REFRESH_MS && s.popularRelays.length > 0) return;
  crawlerState.value = { ...s, isLoadingPopular: true };
  try {
    const resp = await fetch(`${BASE}/popular-relays?limit=${limit}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { relays: PopularRelay[] };
    crawlerState.value = { ...crawlerState.value, popularRelays: data.relays || [], isLoadingPopular: false, lastPopularFetch: now };
  } catch (err) {
    crawlerState.value = { ...crawlerState.value, isLoadingPopular: false };
    console.warn('[crawler] Failed to load popular relays:', err);
  }
}

export async function crawl(filters: NostrFilter[], onEvent: (e: NostrEvent) => void, options: CrawlOptions = {}): Promise<void> {
  const { maxRelays = 8, timeout = 6000, preferIndexers = true, sources = ['indexer', 'popular', 'pool'] } = options;
  const urls = buildRelayList(sources, preferIndexers, maxRelays);
  if (urls.length === 0) return;
  await Promise.allSettled(urls.map((u) => crawlRelay(u, filters, onEvent, timeout)));
}

function buildRelayList(sources: ('popular'|'indexer'|'pool')[], preferIndexers: boolean, max: number): string[] {
  const pool = getPool();
  const pUrls = pool.allRelays.filter((r) => r.status === 'connected').map((r) => r.url);
  const iUrls = getIndexerUrls();
  const popUrls = crawlerState.value.popularRelays.map((r) => r.url);
  const added = new Set<string>(); const result: string[] = [];
  const add = (u: string) => { if (!added.has(u) && result.length < max) { added.add(u); result.push(u); } };
  if (preferIndexers) { if (sources.includes('indexer')) iUrls.forEach(add); if (sources.includes('popular')) popUrls.forEach(add); if (sources.includes('pool')) pUrls.forEach(add); }
  else { if (sources.includes('pool')) pUrls.forEach(add); if (sources.includes('popular')) popUrls.forEach(add); if (sources.includes('indexer')) iUrls.forEach(add); }
  return result;
}

async function crawlRelay(url: string, filters: NostrFilter[], onEvent: (e: NostrEvent) => void, timeout: number): Promise<void> {
  const s = crawlerState.value;
  let cr = s.crawlerRelays.get(url);
  const pool = getPool();
  const poolRelay = pool.getRelay(url);
  if (poolRelay && poolRelay.status === 'connected') return queryRelay(poolRelay, filters, onEvent, timeout);
  if (cr && cr.relay.status === 'connected') { cr.lastUsed = Date.now(); return queryRelay(cr.relay, filters, onEvent, timeout); }
  const relay = new Relay(url);
  const source = getIndexerUrls().includes(url) ? 'indexer' as const : 'popular' as const;
  cr = { relay, url, rtt: 0, source, lastUsed: Date.now(), connectAttempts: (cr?.connectAttempts || 0) + 1 };
  const updated = new Map(s.crawlerRelays); updated.set(url, cr);
  crawlerState.value = { ...crawlerState.value, crawlerRelays: updated };
  const t0 = Date.now();
  try {
    await relay.connect();
    if (relay.status !== 'connected') { relay.disconnect(); return; }
    cr.rtt = Date.now() - t0; cr.lastUsed = Date.now();
    ensureIdleCleanup();
    return queryRelay(relay, filters, onEvent, timeout);
  } catch { relay.disconnect(); }
}

function queryRelay(relay: Relay, filters: NostrFilter[], onEvent: (e: NostrEvent) => void, timeout: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { relay.unsubscribe(subId); resolve(); }, timeout);
    const subId = relay.subscribe(filters, (event: NostrEvent) => {
      if (seenEvents.has(event.id)) return;
      trackSeen(event.id); onEvent(event);
    }, () => { clearTimeout(timer); relay.unsubscribe(subId); resolve(); });
  });
}

function trackSeen(id: string) {
  seenEvents.add(id);
  if (seenEvents.size > MAX_SEEN) { const n = Math.floor(MAX_SEEN * 0.4); const it = seenEvents.values(); for (let i = 0; i < n; i++) { const v = it.next().value; if (v) seenEvents.delete(v); } }
}

function ensureIdleCleanup() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const s = crawlerState.value; const now = Date.now(); let changed = false;
    const m = new Map(s.crawlerRelays);
    for (const [u, cr] of m) { if (now - cr.lastUsed > IDLE_TIMEOUT && cr.source !== 'pool') { cr.relay.disconnect(); m.delete(u); changed = true; } }
    if (changed) crawlerState.value = { ...crawlerState.value, crawlerRelays: m };
    if (m.size === 0 && idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }, 15_000);
}

export function cleanupCrawler(): void {
  const s = crawlerState.value;
  for (const [, cr] of s.crawlerRelays) { if (cr.source !== 'pool') cr.relay.disconnect(); }
  crawlerState.value = { ...s, crawlerRelays: new Map() };
  seenEvents.clear();
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

const _ll: Set<() => void> = new Set(); let _ba = false;
export function subscribeCrawler(listener: () => void): () => void {
  _ll.add(listener);
  if (!_ba) { _ba = true; effect(() => { crawlerState.value; for (const fn of _ll) fn(); }); }
  return () => _ll.delete(listener);
}
