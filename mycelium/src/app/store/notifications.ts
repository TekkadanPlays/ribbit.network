// Notifications Store — Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';
import type { NostrEvent } from '../../nostr/event';
import { Kind } from '../../nostr/event';
import { getPool } from './relay';
import { authPubkey } from './auth';
import { fetchProfile } from './profiles';
import { cacheEvent } from '../api/cache';
import type { PoolSubscription } from '../../nostr/pool';

export type NotifType = 'reaction' | 'reply' | 'mention' | 'repost';

export interface Notification {
  id: string;
  type: NotifType;
  event: NostrEvent;
  targetId: string | null;
}

export interface NotificationsState {
  notifications: Notification[];
  isLoading: boolean;
  lastSeenTimestamp: number;
  unseenCount: number;
}

const STORAGE_KEY = 'ribbit_notif_last_seen';

// ─── Signal ───

export const notificationsState = signal<NotificationsState>({
  notifications: [],
  isLoading: false,
  lastSeenTimestamp: 0,
  unseenCount: 0,
});

let liveSub: PoolSubscription | null = null;
let initialSub: PoolSubscription | null = null;
const seen = new Set<string>();

// ─── Actions ───

export function getNotificationsState(): NotificationsState {
  return notificationsState.value;
}

export function markAllSeen(): void {
  const now = Math.floor(Date.now() / 1000);
  notificationsState.value = { ...notificationsState.value, lastSeenTimestamp: now, unseenCount: 0 };
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(now));
}

export function getUnseenCount(): number {
  return notificationsState.value.unseenCount;
}

function loadLastSeen(): number {
  if (typeof localStorage === 'undefined') return 0;
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? parseInt(saved, 10) || 0 : 0;
}

function classifyEvent(event: NostrEvent, myPubkey: string): Notification | null {
  if (event.pubkey === myPubkey) return null;
  const eTag = event.tags.find((t: string[]) => t[0] === 'e');
  const targetId = eTag && eTag[1] ? eTag[1] : null;

  let type: NotifType = 'mention';
  if (event.kind === Kind.Reaction) type = 'reaction';
  else if (event.kind === 6) type = 'repost';
  else if (event.kind === Kind.Text && targetId) type = 'reply';

  return { id: event.id, type, event, targetId };
}

function recalcUnseen() {
  const s = notificationsState.value;
  const unseen = s.notifications.filter((n) => n.event.created_at > s.lastSeenTimestamp).length;
  notificationsState.value = { ...s, unseenCount: unseen };
}

function addNotification(notif: Notification) {
  const s = notificationsState.value;
  if (s.notifications.some((n) => n.id === notif.id)) return;
  const updated = {
    ...s,
    notifications: [notif, ...s.notifications].sort(
      (a, b) => b.event.created_at - a.event.created_at,
    ),
  };
  notificationsState.value = updated;
  recalcUnseen();
}

// ─── Load & Subscribe ───

export function loadNotifications(): void {
  const pubkey = authPubkey.value;
  if (!pubkey) return;

  cleanupSubs();
  seen.clear();

  notificationsState.value = {
    notifications: [],
    isLoading: true,
    lastSeenTimestamp: loadLastSeen(),
    unseenCount: 0,
  };

  const pool = getPool();
  const myPubkey = pubkey;

  initialSub = pool.subscribe(
    [
      { kinds: [Kind.Reaction], '#p': [myPubkey], limit: 100 },
      { kinds: [Kind.Text], '#p': [myPubkey], limit: 100 },
      { kinds: [6], '#p': [myPubkey], limit: 50 },
    ],
    (event: NostrEvent) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      fetchProfile(event.pubkey);
      cacheEvent(event);
      const notif = classifyEvent(event, myPubkey);
      if (notif) addNotification(notif);
    },
    () => {
      if (initialSub) { initialSub.unsubscribe(); initialSub = null; }
      notificationsState.value = { ...notificationsState.value, isLoading: false };
      recalcUnseen();
      startLiveNotifications(myPubkey);
    },
  );
}

function startLiveNotifications(myPubkey: string): void {
  const pool = getPool();
  const since = Math.floor(Date.now() / 1000);

  liveSub = pool.subscribe(
    [
      { kinds: [Kind.Reaction], '#p': [myPubkey], since },
      { kinds: [Kind.Text], '#p': [myPubkey], since },
      { kinds: [6], '#p': [myPubkey], since },
    ],
    (event: NostrEvent) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      fetchProfile(event.pubkey);
      cacheEvent(event);
      const notif = classifyEvent(event, myPubkey);
      if (notif) addNotification(notif);
    },
  );
}

export function cleanupSubs(): void {
  if (initialSub) { initialSub.unsubscribe(); initialSub = null; }
  if (liveSub) { liveSub.unsubscribe(); liveSub = null; }
}

export function resetNotifications(): void {
  cleanupSubs();
  seen.clear();
  notificationsState.value = {
    notifications: [], isLoading: false, lastSeenTimestamp: 0, unseenCount: 0,
  };
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeNotifications(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      notificationsState.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
