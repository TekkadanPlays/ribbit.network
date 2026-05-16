import { Hono } from 'hono';
import {
  getRelays, getRelayState, getRelayHistory,
  getRelaysBySoftware, getRelaysByNip, getRelaysByNetwork,
  getMonitorStats, getOnlineRelayUrls,
  type RelayRow,
} from '../db/monitor';

// ---------------------------------------------------------------------------
// Relay discovery API — native, powered by local SQLite monitor
// ---------------------------------------------------------------------------
// Replaces the rstate proxy. Same endpoint shapes so the frontend
// Nip66Client works unchanged.

export const relaysRoute = new Hono();

// Helper: transform a RelayRow into the rstate-compatible JSON shape
// that Nip66Client / the frontend expects
function toRelayState(r: RelayRow) {
  let nips: number[] = [];
  try { nips = JSON.parse(r.nips || '[]'); } catch {}
  let nip11: Record<string, any> = {};
  try { nip11 = JSON.parse(r.nip11_json || '{}'); } catch {}

  const uptime = r.check_count > 0 ? r.online_count / r.check_count : 0;

  return {
    relayUrl: r.url,
    network: { value: r.network || 'clearnet' },
    software: {
      family: { value: r.software || 'unknown' },
      version: { value: r.version || '' },
    },
    rtt: {
      open: { value: r.rtt_open > 0 ? r.rtt_open : null },
      read: { value: r.rtt_read > 0 ? r.rtt_read : null },
    },
    nips: { list: nips },
    info: nip11,
    online: !!r.online,
    uptime: Math.round(uptime * 10000) / 100, // percentage with 2 decimals
    updated_at: r.checked_at || 0,
    firstSeenAt: r.first_seen || 0,
    lastSeenAt: r.last_online || 0,
    lastOpenAt: r.online ? r.checked_at : (r.last_online || 0),
    checkCount: r.check_count || 0,
  };
}

// GET /relays/health — monitor health
relaysRoute.get('/relays/health', (c) => {
  const stats = getMonitorStats();
  return c.json({
    status: 'ok',
    monitor: 'mycelium-native',
    ...stats,
  });
});

// GET /relays — list relays with pagination and sorting
relaysRoute.get('/relays', (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 500);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const sortBy = c.req.query('sortBy') || 'rtt_open';
  const sortOrder = (c.req.query('sortOrder') || 'asc') as 'asc' | 'desc';
  const format = c.req.query('format');

  const { relays: rows, total } = getRelays({ limit, offset, sortBy, sortOrder });

  const relays = rows.map(toRelayState);

  return c.json({ relays, total, limit, offset });
});

// GET /relays/state — single relay detail
relaysRoute.get('/relays/state', (c) => {
  const relayUrl = c.req.query('relayUrl');
  if (!relayUrl) return c.json({ error: 'relayUrl query parameter required' }, 400);

  const row = getRelayState(relayUrl);
  if (!row) return c.json({ error: 'Relay not found' }, 404);

  const state = toRelayState(row);
  const history = getRelayHistory(relayUrl);

  return c.json({ ...state, history });
});

// POST /relays/search — search by NIPs, software, latency
relaysRoute.post('/relays/search', async (c) => {
  const body = await c.req.json() as {
    filter?: { nips?: number[]; network?: string[]; software?: string; maxLatency?: number };
    limit?: number; offset?: number;
  };

  const limit = Math.min(body.limit || 100, 500);
  const offset = body.offset || 0;

  // Get all relays sorted by RTT, then filter in-memory
  // (SQLite JSON filtering is clunky, and we're dealing with <5000 relays max)
  const { relays: rows } = getRelays({ limit: 5000, sortBy: 'rtt_open', sortOrder: 'asc' });

  let filtered = rows;
  const f = body.filter;

  if (f) {
    if (f.network && f.network.length > 0) {
      filtered = filtered.filter((r) => f.network!.includes(r.network || 'clearnet'));
    }
    if (f.software) {
      const sw = f.software.toLowerCase();
      filtered = filtered.filter((r) => (r.software || '').toLowerCase().includes(sw));
    }
    if (f.maxLatency && f.maxLatency > 0) {
      filtered = filtered.filter((r) => r.online && r.rtt_open > 0 && r.rtt_open <= f.maxLatency!);
    }
    if (f.nips && f.nips.length > 0) {
      filtered = filtered.filter((r) => {
        try {
          const relayNips: number[] = JSON.parse(r.nips || '[]');
          return f.nips!.every((n) => relayNips.includes(n));
        } catch { return false; }
      });
    }
  }

  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  return c.json({ relays: paged.map(toRelayState), total, limit, offset });
});

// POST /relays/online — find online relays
relaysRoute.post('/relays/online', (c) => {
  const relays = getOnlineRelayUrls();
  return c.json({ relays });
});

// GET /relays/by/software — group by software
relaysRoute.get('/relays/by/software', (c) => {
  return c.json(getRelaysBySoftware());
});

// GET /relays/by/nip — group by NIP support
relaysRoute.get('/relays/by/nip', (c) => {
  return c.json(getRelaysByNip());
});

// GET /relays/by/network — group by network type
relaysRoute.get('/relays/by/network', (c) => {
  return c.json(getRelaysByNetwork());
});

// POST /relays/compare — compare multiple relays
relaysRoute.post('/relays/compare', async (c) => {
  const body = await c.req.json() as { urls: string[] };
  if (!body.urls || !Array.isArray(body.urls)) {
    return c.json({ error: 'urls array required' }, 400);
  }

  const relays = body.urls.map((url) => {
    const row = getRelayState(url);
    return row ? toRelayState(row) : null;
  });

  return c.json({ relays });
});

// GET /relays/history — RTT history for sparklines
relaysRoute.get('/relays/history', (c) => {
  const relayUrl = c.req.query('relayUrl');
  if (!relayUrl) return c.json({ error: 'relayUrl required' }, 400);
  const hours = parseInt(c.req.query('hours') || '24', 10);
  return c.json(getRelayHistory(relayUrl, hours));
});

// GET /monitors — stub for compatibility (we are the only monitor)
relaysRoute.get('/monitors', (c) => {
  const stats = getMonitorStats();
  return c.json({
    monitors: [{
      name: 'mycelium-native',
      pubkey: null,
      totalRelays: stats.totalRelays,
      onlineRelays: stats.onlineRelays,
      lastCheckAt: stats.lastCheckAt,
    }],
  });
});

// GET /monitors/:pubkey — stub
relaysRoute.get('/monitors/:pubkey', (c) => {
  return c.json({ error: 'Not implemented — this is a single-instance monitor' }, 404);
});
