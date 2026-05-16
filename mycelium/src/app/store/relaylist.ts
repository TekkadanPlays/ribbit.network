import { signal, effect } from '@preact/signals-core';
import type { NostrEvent } from '../../nostr/event';
import { Kind } from '../../nostr/event';
import { getPool } from './relay';
import { authPubkey } from './auth';
import { addRelayToProfile, getRelayManagerState } from './relaymanager';

// NIP-65: Relay List Metadata (kind 10002)

export interface RelayListEntry {
  url: string;
  read: boolean;
  write: boolean;
}

export interface RelayListState {
  relays: RelayListEntry[];
  isLoaded: boolean;
  event: NostrEvent | null;
}

// ─── Signal ───

export const relayListState = signal<RelayListState>({
  relays: [],
  isLoaded: false,
  event: null,
});

// ─── Actions ───

export function getRelayListState(): RelayListState {
  return relayListState.value;
}

export function getReadRelays(): string[] {
  return relayListState.value.relays.filter((r) => r.read).map((r) => r.url);
}

export function getWriteRelays(): string[] {
  return relayListState.value.relays.filter((r) => r.write).map((r) => r.url);
}

function parseRelayListEvent(event: NostrEvent): RelayListEntry[] {
  const relays: RelayListEntry[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || !tag[1]) continue;
    const url = tag[1].replace(/\/$/, '');
    const marker = tag[2];
    relays.push({
      url,
      read: !marker || marker === 'read',
      write: !marker || marker === 'write',
    });
  }
  return relays;
}

export function loadRelayList() {
  const pubkey = authPubkey.value;
  if (!pubkey) return;

  const pool = getPool();
  let latest: NostrEvent | null = null;

  const sub = pool.subscribe(
    [{ kinds: [Kind.RelayList], authors: [pubkey] }],
    (event) => {
      if (!latest || event.created_at > latest.created_at) latest = event;
    },
    () => {
      sub.unsubscribe();
      if (latest) {
        const relays = parseRelayListEvent(latest);
        relayListState.value = { relays, isLoaded: true, event: latest };
        syncRelayListToManager(relays);
      } else {
        relayListState.value = { relays: [], isLoaded: true, event: null };
      }
    },
  );
}

function syncRelayListToManager(relays: RelayListEntry[]) {
  const mgr = getRelayManagerState();
  const outbox = mgr.profiles.find((p) => p.id === 'outbox');
  const inbox = mgr.profiles.find((p) => p.id === 'inbox');

  for (const entry of relays) {
    if (entry.write && outbox && !outbox.relays.includes(entry.url)) {
      addRelayToProfile('outbox', entry.url);
    }
    if (entry.read && inbox && !inbox.relays.includes(entry.url)) {
      addRelayToProfile('inbox', entry.url);
    }
  }
}

// Fetch relay list for any pubkey (for outbox model)
export function fetchRelayListForPubkey(
  pubkey: string,
  callback: (relays: RelayListEntry[]) => void,
) {
  const pool = getPool();
  let latest: NostrEvent | null = null;

  const sub = pool.subscribe(
    [{ kinds: [Kind.RelayList], authors: [pubkey] }],
    (event) => {
      if (!latest || event.created_at > latest.created_at) latest = event;
    },
    () => {
      sub.unsubscribe();
      callback(latest ? parseRelayListEvent(latest) : []);
    },
  );
}

export function resetRelayList() {
  relayListState.value = { relays: [], isLoaded: false, event: null };
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeRelayList(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      relayListState.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
