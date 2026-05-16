// ---------------------------------------------------------------------------
// Relay Probe Engine — Bun-native relay health checker
// ---------------------------------------------------------------------------
// Replaces nocapd + nostr-watch's entire probe stack with ~200 lines.
// Uses raw WebSocket for RTT measurement, fetch() for NIP-11.
// Runs as a background interval inside the main Hono server process.

import {
  upsertRelays, saveCheckResults, getAllRelayUrls,
  initMonitorTables,
  type RelayCheck,
} from '../db/monitor';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes between full sweeps
const WS_TIMEOUT = 8000;                   // 8s to complete WS open + read
const NIP11_TIMEOUT = 6000;                // 6s for NIP-11 HTTP fetch
const CONCURRENCY = 30;                    // max parallel probes
const PROBE_REQ = '["REQ","probe",{"limit":1}]';

// Well-known seed relays — expanded on first NIP-66 sweep
const SEED_RELAYS: string[] = [
  'wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nos.lol',
  'wss://relay.snort.social', 'wss://purplepag.es', 'wss://relay.primal.net',
  'wss://nostr.wine', 'wss://relay.nostr.bg', 'wss://nostr.fmt.wiz.biz',
  'wss://relay.nostr.net', 'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub', 'wss://eden.nostr.land', 'wss://nostr.mom',
  'wss://relay.mostr.pub', 'wss://nostr.oxtr.dev',
];

// NIP-66 monitor relays — we query these to discover more relay URLs
const MONITOR_RELAYS = [
  'wss://relay.nostr.watch', 'wss://history.nostr.watch',
];

let checkTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startMonitor() {
  initMonitorTables();
  // Seed the database with well-known relays
  upsertRelays(SEED_RELAYS);
  console.log('🔭 Relay monitor initialized');

  // Run first check after a short delay (let server finish booting)
  setTimeout(() => runCheckCycle(), 5000);
  checkTimer = setInterval(() => runCheckCycle(), CHECK_INTERVAL_MS);
}

export function stopMonitor() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

// ---------------------------------------------------------------------------
// Check cycle — probes all known relays
// ---------------------------------------------------------------------------

async function runCheckCycle() {
  if (isRunning) return;
  isRunning = true;
  const startTime = Date.now();

  try {
    // Discover new relays from NIP-66 monitors first
    await discoverRelaysFromMonitors();

    const urls = getAllRelayUrls();
    if (urls.length === 0) {
      console.log('[monitor] No relays to check');
      isRunning = false;
      return;
    }

    console.log(`[monitor] Starting check cycle — ${urls.length} relays, concurrency ${CONCURRENCY}`);

    // Process in batches of CONCURRENCY
    const results: RelayCheck[] = [];
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(batch.map(probeRelay));
      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value);
      }
    }

    // Batch-write all results
    saveCheckResults(results);

    const online = results.filter((r) => r.online).length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[monitor] Check cycle complete — ${online}/${results.length} online (${elapsed}s)`);
  } catch (err) {
    console.error('[monitor] Check cycle error:', err);
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Probe a single relay — WebSocket RTT + NIP-11
// ---------------------------------------------------------------------------

async function probeRelay(url: string): Promise<RelayCheck> {
  const now = Math.floor(Date.now() / 1000);
  const network = url.includes('.onion') ? 'tor' : url.includes('.i2p') ? 'i2p' : 'clearnet';

  const base: RelayCheck = {
    url, online: false, rtt_open: -1, rtt_read: -1,
    nips: '[]', software: '', version: '', nip11_json: '{}',
    network, checked_at: now,
  };

  // Run WS probe and NIP-11 fetch in parallel
  const [wsResult, nip11Result] = await Promise.allSettled([
    probeWebSocket(url),
    probeNip11(url),
  ]);

  if (wsResult.status === 'fulfilled') {
    base.online = wsResult.value.online;
    base.rtt_open = wsResult.value.rtt_open;
    base.rtt_read = wsResult.value.rtt_read;
  }

  if (nip11Result.status === 'fulfilled' && nip11Result.value) {
    const info = nip11Result.value;
    base.nip11_json = JSON.stringify(info);
    base.software = info.software || '';
    base.version = info.version || '';
    if (Array.isArray(info.supported_nips)) {
      base.nips = JSON.stringify(info.supported_nips);
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// WebSocket probe — measures open RTT and read RTT
// ---------------------------------------------------------------------------

function probeWebSocket(url: string): Promise<{ online: boolean; rtt_open: number; rtt_read: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let rtt_open = -1;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ online: false, rtt_open: -1, rtt_read: -1 }); }
      try { ws.close(); } catch {}
    }, WS_TIMEOUT);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      clearTimeout(timer);
      resolve({ online: false, rtt_open: -1, rtt_read: -1 });
      return;
    }

    ws.onopen = () => {
      rtt_open = Date.now() - t0;
      // Send a minimal REQ to measure read RTT
      const t1 = Date.now();
      try { ws.send(PROBE_REQ); } catch {}

      ws.onmessage = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const rtt_read = Date.now() - t1;
          try { ws.close(); } catch {}
          resolve({ online: true, rtt_open, rtt_read });
        }
      };
    };

    ws.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ online: false, rtt_open: -1, rtt_read: -1 });
      }
    };

    ws.onclose = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        // Opened but closed before we got a message — still counts as online
        resolve({ online: rtt_open > 0, rtt_open, rtt_read: -1 });
      }
    };
  });
}

// ---------------------------------------------------------------------------
// NIP-11 probe — fetches relay info document
// ---------------------------------------------------------------------------

async function probeNip11(url: string): Promise<Record<string, any> | null> {
  // Convert wss:// → https://, ws:// → http://
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NIP11_TIMEOUT);

  try {
    const res = await fetch(httpUrl, {
      headers: { Accept: 'application/nostr+json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Relay discovery — query NIP-66 monitors for relay URLs
// ---------------------------------------------------------------------------

async function discoverRelaysFromMonitors() {
  const discovered: Set<string> = new Set();

  for (const monitorUrl of MONITOR_RELAYS) {
    try {
      const urls = await queryMonitorForRelays(monitorUrl);
      for (const u of urls) discovered.add(u);
    } catch {
      // Monitor unreachable, no-op
    }
  }

  if (discovered.size > 0) {
    const urls = Array.from(discovered);
    upsertRelays(urls);
    console.log(`[monitor] Discovered ${urls.length} relays from NIP-66 monitors`);
  }
}

function queryMonitorForRelays(monitorUrl: string): Promise<string[]> {
  return new Promise((resolve) => {
    const urls: string[] = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(urls);
    }, 10000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(monitorUrl);
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }

    ws.onopen = () => {
      // Query for kind 30166 (relay monitoring events) — d tag contains relay URL
      ws.send(JSON.stringify(['REQ', 'discover', { kinds: [30166], limit: 500 }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (data[0] === 'EVENT' && data[2]) {
          const event = data[2];
          const dTag = event.tags?.find((t: string[]) => t[0] === 'd');
          if (dTag && dTag[1] && dTag[1].startsWith('wss://')) {
            urls.push(dTag[1].replace(/\/+$/, ''));
          }
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(urls);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(urls);
    };
  });
}
