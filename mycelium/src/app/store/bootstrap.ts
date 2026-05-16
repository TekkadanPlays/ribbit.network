// Bootstrap Store — Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';
import { Relay } from '../../nostr/relay';
import { Kind } from '../../nostr/event';
import type { NostrEvent } from '../../nostr/event';
import { getIndexerUrls, discoverIndexers, indexerState, subscribeIndexers } from './indexers';
import { getPool, addRelay } from './relay';
import { addRelayToProfile, removeRelayFromProfile, getRelayManagerState } from './relaymanager';
import { signWithExtension } from '../../nostr/nip07';
import { authPubkey } from './auth';
import { cacheEvent, getCachedProfile, getCachedRelayList, getCachedContacts } from '../api/cache';

export interface BootstrapProfile { name: string; displayName: string; picture: string; banner: string; about: string; nip05: string; lud16: string; }
export interface RelayListEntry { url: string; read: boolean; write: boolean; }
export type BootstrapPhase = 'idle' | 'discovering_indexers' | 'querying_indexers' | 'connecting_relays' | 'ready' | 'error';

export interface BootstrapState {
  phase: BootstrapPhase; profile: BootstrapProfile | null; profileEvent: NostrEvent | null;
  relayList: RelayListEntry[]; relayListEvent: NostrEvent | null;
  contactsEvent: NostrEvent | null; followingCount: number;
  indexersQueried: number; indexersResponded: number;
  outboxConnected: number; inboxConnected: number; error: string | null;
}

const INITIAL: BootstrapState = {
  phase: 'idle', profile: null, profileEvent: null, relayList: [], relayListEvent: null,
  contactsEvent: null, followingCount: 0, indexersQueried: 0, indexersResponded: 0,
  outboxConnected: 0, inboxConnected: 0, error: null,
};

// ─── Signal ───
export const bootstrapState = signal<BootstrapState>({ ...INITIAL });

let ephemeralRelays: Relay[] = [];
let bootstrappedPubkey: string | null = null;
let activeBootstrap: Promise<void> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function getBootstrapState(): BootstrapState { return bootstrapState.value; }

export function resetBootstrap(): void {
  stopPeriodicRefresh(); cleanupEphemeral();
  bootstrappedPubkey = null; activeBootstrap = null;
  bootstrapState.value = { ...INITIAL };
}

export async function bootstrapUser(pubkey: string): Promise<void> {
  if (bootstrappedPubkey === pubkey && bootstrapState.value.phase === 'ready') return;
  if (bootstrappedPubkey === pubkey && activeBootstrap) return activeBootstrap;
  bootstrappedPubkey = pubkey;
  activeBootstrap = doBootstrap(pubkey).finally(() => { activeBootstrap = null; });
  return activeBootstrap;
}

async function doBootstrap(pubkey: string): Promise<void> {
  bootstrapState.value = { ...INITIAL, phase: 'discovering_indexers' };

  const is = indexerState.value;
  if (is.urls.length === 0) await discoverIndexers(10);
  const indexerUrls = getIndexerUrls();
  if (indexerUrls.length === 0) {
    bootstrapState.value = { ...bootstrapState.value, phase: 'error', error: 'No indexer relays found' };
    return;
  }

  syncIndexersToManager(indexerUrls);
  subscribeIndexers(() => { const u = getIndexerUrls(); if (u.length > 0) syncIndexersToManager(u); });

  // 1.5 Server cache hydration
  try {
    const [cp, cr, cc] = await Promise.all([getCachedProfile(pubkey), getCachedRelayList(pubkey), getCachedContacts(pubkey)]);
    if (cp) {
      let m: Record<string,string> = {}; try { m = JSON.parse(cp.raw_content); } catch {}
      bootstrapState.value = { ...bootstrapState.value, profile: { name: m.name||'', displayName: m.display_name||m.displayName||'', about: m.about||'', picture: m.picture||'', banner: m.banner||'', nip05: m.nip05||'', lud16: m.lud16||'' } };
    }
    if (cr && cr.length > 0) {
      bootstrapState.value = { ...bootstrapState.value, relayList: cr.map((r: any) => ({ url: r.url, read: r.read, write: r.write })) };
    }
    if (cc && cc.length > 0) {
      bootstrapState.value = { ...bootstrapState.value, followingCount: cc.length };
    }
  } catch {}

  bootstrapState.value = { ...bootstrapState.value, phase: 'querying_indexers', indexersQueried: indexerUrls.length };
  await queryIndexers(pubkey, indexerUrls);

  if (bootstrapState.value.relayList.length > 0) {
    bootstrapState.value = { ...bootstrapState.value, phase: 'connecting_relays' };
    await connectUserRelays(bootstrapState.value.relayList);
  }

  bootstrapState.value = { ...bootstrapState.value, phase: 'ready' };
  cleanupEphemeral();
}

function queryIndexers(pubkey: string, indexerUrls: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    let responded = 0; const total = indexerUrls.length;
    const timeout = setTimeout(() => finish(), 8000);
    function finish() { clearTimeout(timeout); resolve(); }
    function onDone() { responded++; bootstrapState.value = { ...bootstrapState.value, indexersResponded: responded }; if (responded >= total) finish(); }

    for (const url of indexerUrls) {
      const relay = new Relay(url); ephemeralRelays.push(relay);
      relay.connect().then(() => {
        if (relay.status !== 'connected') { onDone(); return; }
        const subId = relay.subscribe(
          [{ kinds: [Kind.Metadata], authors: [pubkey], limit: 1 }, { kinds: [Kind.RelayList], authors: [pubkey], limit: 1 }, { kinds: [Kind.Contacts], authors: [pubkey], limit: 1 }],
          (event: NostrEvent) => {
            cacheEvent(event);
            const s = bootstrapState.value;
            if (event.kind === Kind.Metadata && (!s.profileEvent || event.created_at > s.profileEvent.created_at)) {
              bootstrapState.value = { ...s, profileEvent: event, profile: parseProfile(event) };
            } else if (event.kind === Kind.RelayList && (!s.relayListEvent || event.created_at > s.relayListEvent.created_at)) {
              bootstrapState.value = { ...s, relayListEvent: event, relayList: parseRelayList(event) };
            } else if (event.kind === Kind.Contacts && (!s.contactsEvent || event.created_at > s.contactsEvent.created_at)) {
              const count = event.tags.filter((t) => t[0] === 'p' && t[1]).length;
              bootstrapState.value = { ...s, contactsEvent: event, followingCount: count };
            }
          },
          () => { relay.unsubscribe(subId); onDone(); },
        );
      }).catch(() => onDone());
    }
  });
}

async function connectUserRelays(relayList: RelayListEntry[]): Promise<void> {
  const pool = getPool(); const mgr = getRelayManagerState();
  const wr = relayList.filter((r) => r.write).map((r) => r.url);
  const rr = relayList.filter((r) => r.read).map((r) => r.url);
  const outbox = mgr.profiles.find((p) => p.id === 'outbox');
  const inbox = mgr.profiles.find((p) => p.id === 'inbox');
  for (const u of wr) { if (outbox && !outbox.relays.includes(u)) addRelayToProfile('outbox', u); }
  for (const u of rr) { if (inbox && !inbox.relays.includes(u)) addRelayToProfile('inbox', u); }
  const allUrls = new Set([...wr, ...rr]);
  const proms: Promise<void>[] = [];
  for (const url of allUrls) {
    if (!pool.getRelay(url)) {
      const relay = pool.addRelayWithAuth(url);
      proms.push(relay.connect().then(() => {
        const s = bootstrapState.value;
        if (wr.includes(url)) bootstrapState.value = { ...s, outboxConnected: s.outboxConnected + 1 };
        if (rr.includes(url)) bootstrapState.value = { ...bootstrapState.value, inboxConnected: bootstrapState.value.inboxConnected + 1 };
      }).catch((err) => console.warn(`[bootstrap] Failed to connect to ${url}:`, err)));
    }
  }
  await Promise.allSettled(proms);
}

function syncIndexersToManager(urls: string[]) {
  const mgr = getRelayManagerState();
  const ix = mgr.profiles.find((p) => p.id === 'indexers');
  if (!ix) return;
  for (const u of ix.relays) { if (!urls.includes(u)) removeRelayFromProfile('indexers', u); }
  for (const u of urls) { if (!ix.relays.includes(u)) addRelayToProfile('indexers', u); }
}

function cleanupEphemeral() {
  for (const r of ephemeralRelays) { if (!getPool().getRelay(r.url)) r.disconnect(); }
  ephemeralRelays = [];
}

function parseProfile(event: NostrEvent): BootstrapProfile {
  let m: Record<string,string> = {}; try { m = JSON.parse(event.content); } catch {}
  return { name: m.name||'', displayName: m.display_name||m.displayName||'', picture: m.picture||'', banner: m.banner||'', about: m.about||'', nip05: m.nip05||'', lud16: m.lud16||'' };
}

function parseRelayList(event: NostrEvent): RelayListEntry[] {
  const relays: RelayListEntry[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || !tag[1]) continue;
    const url = tag[1].replace(/\/+$/, ''); const marker = tag[2];
    relays.push({ url, read: !marker || marker === 'read', write: !marker || marker === 'write' });
  }
  return relays;
}

export function startPeriodicRefresh(): void {
  if (refreshInterval) return;
  refreshInterval = setInterval(() => refreshFromIndexers().catch((e) => console.warn('[bootstrap] Periodic refresh error:', e)), REFRESH_INTERVAL_MS);
}

export function stopPeriodicRefresh(): void {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

async function refreshFromIndexers(): Promise<void> {
  const pubkey = bootstrappedPubkey;
  if (!pubkey || bootstrapState.value.phase !== 'ready') return;
  const urls = getIndexerUrls().slice(0, 3);
  if (urls.length === 0) return;
  for (const url of urls) {
    const relay = new Relay(url);
    try {
      await relay.connect();
      if (relay.status !== 'connected') { relay.disconnect(); continue; }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { relay.disconnect(); resolve(); }, 5000);
        const subId = relay.subscribe(
          [{ kinds: [Kind.Metadata], authors: [pubkey], limit: 1 }, { kinds: [Kind.RelayList], authors: [pubkey], limit: 1 }, { kinds: [Kind.Contacts], authors: [pubkey], limit: 1 }],
          (event: NostrEvent) => {
            cacheEvent(event); const s = bootstrapState.value;
            if (event.kind === Kind.Metadata && (!s.profileEvent || event.created_at > s.profileEvent.created_at)) bootstrapState.value = { ...s, profileEvent: event, profile: parseProfile(event) };
            else if (event.kind === Kind.RelayList && (!s.relayListEvent || event.created_at > s.relayListEvent.created_at)) bootstrapState.value = { ...s, relayListEvent: event, relayList: parseRelayList(event) };
            else if (event.kind === Kind.Contacts && (!s.contactsEvent || event.created_at > s.contactsEvent.created_at)) { const c = event.tags.filter((t) => t[0] === 'p' && t[1]).length; bootstrapState.value = { ...s, contactsEvent: event, followingCount: c }; }
          },
          () => { clearTimeout(t); relay.unsubscribe(subId); relay.disconnect(); resolve(); },
        );
      });
    } catch { relay.disconnect(); }
  }
}

export function getOutboxUrls(): string[] { return bootstrapState.value.relayList.filter((r) => r.write).map((r) => r.url); }
export function getInboxUrls(): string[] { return bootstrapState.value.relayList.filter((r) => r.read).map((r) => r.url); }

// ─── Legacy compat ───
const _ll: Set<() => void> = new Set(); let _ba = false;
export function subscribeBootstrap(listener: () => void): () => void {
  _ll.add(listener);
  if (!_ba) { _ba = true; effect(() => { bootstrapState.value; for (const fn of _ll) fn(); }); }
  return () => _ll.delete(listener);
}
