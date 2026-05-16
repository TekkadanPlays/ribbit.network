// Indexer Discovery Store — Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';
import { Relay } from '../../nostr/relay';
import type { NostrEvent } from '../../nostr/event';

export interface IndexerState {
  urls: string[];
  source: 'rstate' | 'nip66' | 'fallback' | 'none';
  isLoading: boolean;
  error: string | null;
}

// ─── Signal ───

export const indexerState = signal<IndexerState>({
  urls: [],
  source: 'none',
  isLoading: false,
  error: null,
});

let activeDiscovery: Promise<void> | null = null;

// ─── Reads ───

export function getIndexerState(): IndexerState {
  return indexerState.value;
}

export function getIndexerUrls(): string[] {
  return indexerState.value.urls;
}

// Well-known relays that are reliable indexers
const FALLBACK_INDEXERS: string[] = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://purplepag.es',
  'wss://relay.primal.net',
];

const MONITOR_RELAYS: string[] = [
  'wss://relay.nostr.watch',
  'wss://history.nostr.watch',
];

// ─── Actions ───

export function discoverIndexers(count: number = 10): Promise<void> {
  if (indexerState.value.urls.length > 0 && !indexerState.value.isLoading) return Promise.resolve();
  if (activeDiscovery) return activeDiscovery;

  activeDiscovery = doDiscover(count).finally(() => { activeDiscovery = null; });
  return activeDiscovery;
}

async function doDiscover(count: number): Promise<void> {
  indexerState.value = { ...indexerState.value, isLoading: true, error: null };

  // 1. Try rstate API
  try {
    const urls = await fetchFromRstate(count);
    if (urls.length > 0) {
      console.log('[indexers] Discovered', urls.length, 'relays via rstate');
      indexerState.value = { urls, source: 'rstate', isLoading: false, error: null };
      return;
    }
  } catch (err) {
    console.warn('[indexers] rstate unavailable:', err);
  }

  // 2. Instant fallback
  console.log('[indexers] Using fallback indexers');
  indexerState.value = {
    urls: FALLBACK_INDEXERS.slice(0, count),
    source: 'fallback',
    isLoading: false,
    error: null,
  };

  // 3. Background NIP-66 upgrade
  upgradeViaNip66(count);
}

async function fetchFromRstate(count: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const params = new URLSearchParams({
      limit: String(count * 3), offset: '0',
      sortBy: 'lastSeen', sortOrder: 'desc', format: 'detailed',
    });
    const res = await fetch(`/relays?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`rstate ${res.status}`);

    const data = await res.json();
    const relays: any[] = data.relays || [];

    const scored = relays
      .filter((r: any) => {
        if (!r.relayUrl || !r.relayUrl.startsWith('wss://')) return false;
        if (r.network?.value && r.network.value !== 'clearnet') return false;
        return true;
      })
      .map((r: any) => ({
        url: r.relayUrl.replace(/\/+$/, ''),
        rtt: r.rtt?.open?.value ?? 9999,
        lastSeen: r.lastSeenAt ?? 0,
      }))
      .sort((a, b) => {
        if (a.rtt !== b.rtt) return a.rtt - b.rtt;
        return b.lastSeen - a.lastSeen;
      });

    const seen = new Set<string>();
    const result: string[] = [];
    for (const r of scored) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      result.push(r.url);
      if (result.length >= count) break;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function upgradeViaNip66(count: number) {
  const relayUrls: Map<string, { rtt: number }> = new Map();
  let completed = 0;
  const timeout = setTimeout(() => finish(), 8000);

  function finish() {
    clearTimeout(timeout);
    if (relayUrls.size === 0) return;

    const sorted = Array.from(relayUrls.entries())
      .sort((a, b) => a[1].rtt - b[1].rtt)
      .map(([url]) => url)
      .slice(0, count);

    if (sorted.length > 0) {
      console.log('[indexers] Upgraded to', sorted.length, 'relays via NIP-66');
      indexerState.value = { urls: sorted, source: 'nip66', isLoading: false, error: null };
    }
  }

  for (const monitorUrl of MONITOR_RELAYS) {
    const relay = new Relay(monitorUrl);
    relay.connect()
      .then(() => {
        const subId = relay.subscribe(
          [{ kinds: [30166], limit: count * 3 }],
          (event: NostrEvent) => {
            const dTag = event.tags.find((t) => t[0] === 'd');
            if (!dTag || !dTag[1]) return;
            const url = dTag[1].replace(/\/+$/, '');
            if (!url.startsWith('wss://')) return;

            let rtt = 9999;
            const rttTag = event.tags.find((t) => t[0] === 'rtt' && t[1] === 'open');
            if (rttTag && rttTag[2]) rtt = parseInt(rttTag[2], 10) || 9999;

            const existing = relayUrls.get(url);
            if (!existing || rtt < existing.rtt) relayUrls.set(url, { rtt });
          },
          () => {
            relay.unsubscribe(subId);
            relay.disconnect();
            completed++;
            if (completed >= MONITOR_RELAYS.length) finish();
          },
        );
      })
      .catch(() => {
        completed++;
        if (completed >= MONITOR_RELAYS.length) finish();
      });
  }
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeIndexers(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      indexerState.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
