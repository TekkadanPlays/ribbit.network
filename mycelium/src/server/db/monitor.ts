// ---------------------------------------------------------------------------
// Relay Monitor Database — SQLite tables for relay health tracking
// ---------------------------------------------------------------------------
import { getDb } from './schema';

export interface RelayCheck {
  url: string;
  online: boolean;
  rtt_open: number;      // ms, -1 if failed
  rtt_read: number;      // ms, -1 if failed
  nips: string;          // JSON array of supported NIP numbers
  software: string;      // e.g. "strfry", "nostr-rs-relay"
  version: string;       // software version from NIP-11
  nip11_json: string;    // full NIP-11 info document
  network: string;       // 'clearnet' | 'tor' | 'i2p'
  checked_at: number;    // unix timestamp
}

export function initMonitorTables() {
  const db = getDb();

  // Relay catalog — one row per known relay URL
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_relays (
      url           TEXT PRIMARY KEY,
      first_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_online   INTEGER DEFAULT NULL,
      last_checked  INTEGER DEFAULT NULL,
      check_count   INTEGER NOT NULL DEFAULT 0,
      online_count  INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Check results — latest check per relay (replaced on each cycle)
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_checks (
      url           TEXT PRIMARY KEY,
      online        INTEGER NOT NULL DEFAULT 0,
      rtt_open      INTEGER NOT NULL DEFAULT -1,
      rtt_read      INTEGER NOT NULL DEFAULT -1,
      nips          TEXT NOT NULL DEFAULT '[]',
      software      TEXT NOT NULL DEFAULT '',
      version       TEXT NOT NULL DEFAULT '',
      nip11_json    TEXT NOT NULL DEFAULT '{}',
      network       TEXT NOT NULL DEFAULT 'clearnet',
      checked_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Historical RTT samples — keep last 24 hours for sparklines
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_history (
      url           TEXT NOT NULL,
      rtt_open      INTEGER NOT NULL DEFAULT -1,
      online        INTEGER NOT NULL DEFAULT 0,
      checked_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (url, checked_at)
    )
  `);

  // Indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_monitor_checks_online ON monitor_checks(online)');
  db.run('CREATE INDEX IF NOT EXISTS idx_monitor_checks_rtt ON monitor_checks(rtt_open)');
  db.run('CREATE INDEX IF NOT EXISTS idx_monitor_checks_software ON monitor_checks(software)');
  db.run('CREATE INDEX IF NOT EXISTS idx_monitor_history_url ON monitor_history(url, checked_at DESC)');

  // Prune history older than 24 hours on each startup
  db.run(`DELETE FROM monitor_history WHERE checked_at < unixepoch() - 86400`);
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export function upsertRelay(url: string) {
  const db = getDb();
  db.run(
    `INSERT INTO monitor_relays (url) VALUES (?) ON CONFLICT(url) DO NOTHING`,
    [url],
  );
}

export function upsertRelays(urls: string[]) {
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO monitor_relays (url) VALUES (?) ON CONFLICT(url) DO NOTHING`);
  const tx = db.transaction(() => { for (const url of urls) stmt.run(url); });
  tx();
}

export function saveCheckResult(check: RelayCheck) {
  const db = getDb();
  const now = check.checked_at;

  // Upsert latest check
  db.run(
    `INSERT INTO monitor_checks (url, online, rtt_open, rtt_read, nips, software, version, nip11_json, network, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       online=excluded.online, rtt_open=excluded.rtt_open, rtt_read=excluded.rtt_read,
       nips=excluded.nips, software=excluded.software, version=excluded.version,
       nip11_json=excluded.nip11_json, network=excluded.network, checked_at=excluded.checked_at`,
    [check.url, check.online ? 1 : 0, check.rtt_open, check.rtt_read,
     check.nips, check.software, check.version, check.nip11_json, check.network, now],
  );

  // Update relay catalog
  db.run(
    `UPDATE monitor_relays SET
       last_checked = ?,
       check_count = check_count + 1,
       online_count = online_count + ?
       ${check.online ? ', last_online = ?' : ''}
     WHERE url = ?`,
    check.online ? [now, 1, now, check.url] : [now, 0, check.url],
  );

  // Append history sample
  db.run(
    `INSERT INTO monitor_history (url, rtt_open, online, checked_at) VALUES (?, ?, ?, ?)`,
    [check.url, check.rtt_open, check.online ? 1 : 0, now],
  );
}

export function saveCheckResults(checks: RelayCheck[]) {
  const db = getDb();
  const tx = db.transaction(() => { for (const c of checks) saveCheckResult(c); });
  tx();
}

// ---------------------------------------------------------------------------
// Read operations — used by Hono routes
// ---------------------------------------------------------------------------

export interface RelayRow {
  url: string; online: number; rtt_open: number; rtt_read: number;
  nips: string; software: string; version: string; nip11_json: string;
  network: string; checked_at: number;
  first_seen: number; last_online: number | null;
  check_count: number; online_count: number;
}

export function getRelays(opts: {
  limit?: number; offset?: number;
  sortBy?: string; sortOrder?: 'asc' | 'desc';
  onlineOnly?: boolean;
}): { relays: RelayRow[]; total: number } {
  const db = getDb();
  const where = opts.onlineOnly ? 'WHERE c.online = 1' : '';

  // Whitelist sort columns to prevent injection
  const validSorts: Record<string, string> = {
    rtt_open: 'c.rtt_open', rtt_read: 'c.rtt_read',
    lastSeen: 'r.last_online', checked_at: 'c.checked_at',
    url: 'r.url', software: 'c.software', first_seen: 'r.first_seen',
    uptime: '(CAST(r.online_count AS REAL) / MAX(r.check_count, 1))',
  };
  const sortCol = validSorts[opts.sortBy || 'rtt_open'] || 'c.rtt_open';
  const sortDir = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(opts.limit || 50, 500);
  const offset = opts.offset || 0;

  const total = db.query(
    `SELECT COUNT(*) as cnt FROM monitor_relays r LEFT JOIN monitor_checks c ON r.url = c.url ${where}`,
  ).get() as { cnt: number };

  const rows = db.query(`
    SELECT r.url, r.first_seen, r.last_online, r.check_count, r.online_count,
           c.online, c.rtt_open, c.rtt_read, c.nips, c.software, c.version,
           c.nip11_json, c.network, c.checked_at
    FROM monitor_relays r
    LEFT JOIN monitor_checks c ON r.url = c.url
    ${where}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(limit, offset) as RelayRow[];

  return { relays: rows, total: total.cnt };
}

export function getRelayState(url: string): RelayRow | null {
  const db = getDb();
  return db.query(`
    SELECT r.url, r.first_seen, r.last_online, r.check_count, r.online_count,
           c.online, c.rtt_open, c.rtt_read, c.nips, c.software, c.version,
           c.nip11_json, c.network, c.checked_at
    FROM monitor_relays r
    LEFT JOIN monitor_checks c ON r.url = c.url
    WHERE r.url = ?
  `).get(url) as RelayRow | null;
}

export function getRelayHistory(url: string, hours: number = 24): Array<{ rtt_open: number; online: number; checked_at: number }> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - (hours * 3600);
  return db.query(
    `SELECT rtt_open, online, checked_at FROM monitor_history WHERE url = ? AND checked_at > ? ORDER BY checked_at ASC`,
  ).all(url, since) as any[];
}

export function getRelaysBySoftware(): Record<string, string[]> {
  const db = getDb();
  const rows = db.query(
    `SELECT url, software FROM monitor_checks WHERE software != '' ORDER BY software`,
  ).all() as { url: string; software: string }[];

  const result: Record<string, string[]> = {};
  for (const r of rows) {
    if (!result[r.software]) result[r.software] = [];
    result[r.software].push(r.url);
  }
  return result;
}

export function getRelaysByNip(): Record<number, { relays: string[]; supportRatio: number }> {
  const db = getDb();
  const rows = db.query(
    `SELECT url, nips FROM monitor_checks WHERE nips != '[]'`,
  ).all() as { url: string; nips: string }[];

  const total = rows.length || 1;
  const nipMap: Record<number, Set<string>> = {};
  for (const r of rows) {
    try {
      const nips: number[] = JSON.parse(r.nips);
      for (const n of nips) {
        if (!nipMap[n]) nipMap[n] = new Set();
        nipMap[n].add(r.url);
      }
    } catch {}
  }

  const result: Record<number, { relays: string[]; supportRatio: number }> = {};
  for (const [nip, urls] of Object.entries(nipMap)) {
    const arr = Array.from(urls);
    result[Number(nip)] = { relays: arr, supportRatio: arr.length / total };
  }
  return result;
}

export function getRelaysByNetwork(): Record<string, string[]> {
  const db = getDb();
  const rows = db.query(
    `SELECT url, network FROM monitor_checks ORDER BY network`,
  ).all() as { url: string; network: string }[];

  const result: Record<string, string[]> = {};
  for (const r of rows) {
    const net = r.network || 'clearnet';
    if (!result[net]) result[net] = [];
    result[net].push(r.url);
  }
  return result;
}

export function getMonitorStats(): {
  totalRelays: number; onlineRelays: number;
  avgRttOpen: number; lastCheckAt: number;
} {
  const db = getDb();
  const stats = db.query(`
    SELECT
      COUNT(*) as totalRelays,
      SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as onlineRelays,
      AVG(CASE WHEN online = 1 AND rtt_open > 0 THEN rtt_open END) as avgRttOpen,
      MAX(checked_at) as lastCheckAt
    FROM monitor_checks
  `).get() as any;
  return {
    totalRelays: stats.totalRelays || 0,
    onlineRelays: stats.onlineRelays || 0,
    avgRttOpen: Math.round(stats.avgRttOpen || 0),
    lastCheckAt: stats.lastCheckAt || 0,
  };
}

export function getAllRelayUrls(): string[] {
  const db = getDb();
  return (db.query('SELECT url FROM monitor_relays').all() as { url: string }[]).map((r) => r.url);
}

export function getOnlineRelayUrls(): string[] {
  const db = getDb();
  return (db.query('SELECT url FROM monitor_checks WHERE online = 1').all() as { url: string }[]).map((r) => r.url);
}
