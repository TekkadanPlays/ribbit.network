// Profile fetching store — resolves kind-0 metadata for any pubkey
// Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';
import type { NostrEvent } from '../../nostr/event';
import { Kind } from '../../nostr/event';
import { getPool } from './relay';
import { getOutboxUrls } from './bootstrap';
import { cacheEvent, getCachedProfiles } from '../api/cache';
import { crawl } from './relay-crawler';

export interface Profile {
  pubkey: string;
  name: string;
  displayName: string;
  about: string;
  picture: string;
  banner: string;
  nip05: string;
  lud16: string;
  lastUpdated: number;
}

// ─── Signal ───

// Bumped every time the profile cache changes
export const profileVersion = signal(0);

const profiles: Map<string, Profile> = new Map();
const pendingFetches: Set<string> = new Set();

function notifyProfileChange() {
  profileVersion.value++;
}

// ─── Reads ───

export function getProfile(pubkey: string): Profile | undefined {
  return profiles.get(pubkey);
}

export function getAllProfiles(): Map<string, Profile> {
  return profiles;
}

export function getDisplayName(pubkey: string): string {
  const profile = profiles.get(pubkey);
  if (profile) return profile.displayName || profile.name || pubkey.slice(0, 8) + '...';
  return pubkey.slice(0, 8) + '...';
}

// ─── Internal ───

function parseProfileEvent(event: NostrEvent): Profile {
  let meta: Record<string, string> = {};
  try { meta = JSON.parse(event.content); } catch {}

  return {
    pubkey: event.pubkey,
    name: meta.name || '', displayName: meta.display_name || meta.displayName || '',
    about: meta.about || '', picture: meta.picture || '', banner: meta.banner || '',
    nip05: meta.nip05 || '', lud16: meta.lud16 || '', lastUpdated: event.created_at,
  };
}

function applyEvent(event: NostrEvent) {
  const existing = profiles.get(event.pubkey);
  if (!existing || event.created_at > existing.lastUpdated) {
    profiles.set(event.pubkey, parseProfileEvent(event));
    cacheEvent(event);
    notifyProfileChange();
  }
}

// ---------------------------------------------------------------------------
// High-performance parallel profile fetcher
// ---------------------------------------------------------------------------

const batchQueue: Set<string> = new Set();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_DELAY = 30;
const CHUNK_SIZE = 50;

export function resetProfiles(): void {
  profiles.clear();
  pendingFetches.clear();
  batchQueue.clear();
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  notifyProfileChange();
}

export function fetchProfile(pubkey: string) {
  if (profiles.has(pubkey) || pendingFetches.has(pubkey)) return;
  batchQueue.add(pubkey);
  scheduleBatchFlush();
}

export function fetchProfiles(pubkeys: string[]) {
  let added = 0;
  for (const pk of pubkeys) {
    if (!profiles.has(pk) && !pendingFetches.has(pk)) {
      batchQueue.add(pk);
      added++;
    }
  }
  if (added > 0) scheduleBatchFlush();
}

function scheduleBatchFlush() {
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flushBatch();
  }, BATCH_DELAY);
}

function flushBatch() {
  const toFetch = Array.from(batchQueue).filter(
    (pk) => !profiles.has(pk) && !pendingFetches.has(pk),
  );
  batchQueue.clear();
  if (toFetch.length === 0) return;

  for (const pk of toFetch) pendingFetches.add(pk);

  getCachedProfiles(toFetch).then((cached) => {
    const remaining: string[] = [];
    for (const pk of toFetch) {
      const hit = cached.get(pk);
      if (hit) {
        const existing = profiles.get(pk);
        if (!existing || hit.created_at > existing.lastUpdated) {
          let meta: Record<string, string> = {};
          try { meta = JSON.parse(hit.raw_content); } catch {}
          profiles.set(pk, {
            pubkey: pk,
            name: meta.name || '', displayName: meta.display_name || meta.displayName || '',
            about: meta.about || '', picture: meta.picture || '', banner: meta.banner || '',
            nip05: meta.nip05 || '', lud16: meta.lud16 || '', lastUpdated: hit.created_at,
          });
        }
        pendingFetches.delete(pk);
      } else {
        remaining.push(pk);
      }
    }
    if (cached.size > 0) notifyProfileChange();

    if (remaining.length === 0) return;
    queryRelays(remaining);
  }).catch(() => {
    queryRelays(toFetch);
  });
}

function queryRelays(toFetch: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    chunks.push(toFetch.slice(i, i + CHUNK_SIZE));
  }

  queryViaPool(chunks, toFetch);
  queryViaCrawler(chunks);
  queryViaOutbox(chunks);
}

function queryViaPool(chunks: string[][], allPubkeys: string[]) {
  const pool = getPool();
  let eoseCount = 0;

  for (const chunk of chunks) {
    const sub = pool.subscribe(
      [{ kinds: [Kind.Metadata], authors: chunk }],
      (event) => applyEvent(event),
      () => {
        sub.unsubscribe();
        eoseCount++;
        if (eoseCount >= chunks.length) {
          for (const pk of allPubkeys) pendingFetches.delete(pk);
        }
      },
    );
  }
}

function queryViaOutbox(chunks: string[][]) {
  const pool = getPool();
  const outboxUrls = getOutboxUrls();
  if (outboxUrls.length === 0) return;

  for (const chunk of chunks) {
    const sub = pool.subscribeToUrls(
      outboxUrls,
      [{ kinds: [Kind.Metadata], authors: chunk }],
      (event) => applyEvent(event),
      () => { sub.unsubscribe(); },
    );
  }
}

function queryViaCrawler(chunks: string[][]) {
  for (const chunk of chunks) {
    crawl(
      [{ kinds: [Kind.Metadata], authors: chunk }],
      (event) => applyEvent(event),
      { maxRelays: 6, timeout: 5000, preferIndexers: true },
    ).catch(() => {});
  }
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeProfiles(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      profileVersion.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
