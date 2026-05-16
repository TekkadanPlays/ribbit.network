import { signal, effect } from '@preact/signals-core';
import type { NostrEvent } from '../../nostr/event';
import { Kind, createEvent } from '../../nostr/event';
import { signWithExtension } from '../../nostr/nip07';
import { getPool } from './relay';
import { authPubkey } from './auth';
import { cacheEvent } from '../api/cache';

export interface ContactsState {
  following: Set<string>;
  isLoaded: boolean;
  contactEvent: NostrEvent | null;
}

// ─── Signal ───

export const contactsState = signal<ContactsState>({
  following: new Set(),
  isLoaded: false,
  contactEvent: null,
});

// ─── Actions ───

export function getContactsState(): ContactsState {
  return contactsState.value;
}

export function isFollowing(pubkey: string): boolean {
  return contactsState.value.following.has(pubkey);
}

export function resetContacts(): void {
  contactsState.value = { following: new Set(), isLoaded: false, contactEvent: null };
}

export function getFollowingList(): string[] {
  return Array.from(contactsState.value.following);
}

// Apply a pre-fetched contacts event (from bootstrap indexer query)
export function applyContactsEvent(event: NostrEvent) {
  const s = contactsState.value;
  if (s.contactEvent && s.contactEvent.created_at >= event.created_at) return;
  const following = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] === 'p' && tag[1]) following.add(tag[1]);
  }
  contactsState.value = { following, isLoaded: true, contactEvent: event };
  cacheEvent(event);
}

export function loadContacts() {
  const pubkey = authPubkey.value;
  if (!pubkey) return;

  const pool = getPool();
  let latest: NostrEvent | null = null;

  const sub = pool.subscribe(
    [{ kinds: [Kind.Contacts], authors: [pubkey] }],
    (event) => {
      if (!latest || event.created_at > latest.created_at) latest = event;
    },
    () => {
      sub.unsubscribe();
      if (latest) {
        applyContactsEvent(latest);
      } else if (!contactsState.value.isLoaded) {
        contactsState.value = { following: new Set(), isLoaded: true, contactEvent: null };
      }
    },
  );
}

export async function followUser(pubkey: string): Promise<void> {
  const myPubkey = authPubkey.value;
  if (!myPubkey) return;
  const s = contactsState.value;
  if (s.following.has(pubkey)) return;

  const tags: string[][] = s.contactEvent
    ? s.contactEvent.tags.filter((t) => t[0] === 'p')
    : [];
  tags.push(['p', pubkey]);

  const content = s.contactEvent?.content || '';
  const unsigned = createEvent(Kind.Contacts, content, tags, myPubkey);
  const signed = await signWithExtension(unsigned);
  const pool = getPool();
  await pool.publish(signed);

  const following = new Set(s.following);
  following.add(pubkey);
  contactsState.value = { following, isLoaded: true, contactEvent: signed };
}

export async function unfollowUser(pubkey: string): Promise<void> {
  const myPubkey = authPubkey.value;
  if (!myPubkey) return;
  const s = contactsState.value;
  if (!s.following.has(pubkey)) return;

  const tags: string[][] = s.contactEvent
    ? s.contactEvent.tags.filter((t) => !(t[0] === 'p' && t[1] === pubkey))
    : [];

  const content = s.contactEvent?.content || '';
  const unsigned = createEvent(Kind.Contacts, content, tags, myPubkey);
  const signed = await signWithExtension(unsigned);
  const pool = getPool();
  await pool.publish(signed);

  const following = new Set(s.following);
  following.delete(pubkey);
  contactsState.value = { following, isLoaded: true, contactEvent: signed };
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeContacts(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      contactsState.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
