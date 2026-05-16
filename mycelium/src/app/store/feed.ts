// Feed Store — Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';
import type { NostrEvent } from '../../nostr/event';
import { Kind } from '../../nostr/event';
import { isRootNote } from '../../nostr/nip10';
import { getPool } from './relay';
import { getFollowingList } from './contacts';
import { getOutboxUrls } from './bootstrap';
import type { PoolSubscription } from '../../nostr/pool';
import { cacheEvent, getCachedFeed } from '../api/cache';

export type FeedSort = 'new' | 'hot' | 'top';
export type FeedMode = 'global' | 'following';

export interface FeedState {
  posts: NostrEvent[];
  reactions: Map<string, NostrEvent[]>;
  replyCounts: Map<string, number>;
  isLoading: boolean;
  sort: FeedSort;
  mode: FeedMode;
  eoseReceived: boolean;
  newPostsBuffer: NostrEvent[];
}

// ─── Signal ───

export const feedState = signal<FeedState>({
  posts: [],
  reactions: new Map(),
  replyCounts: new Map(),
  isLoading: false,
  sort: 'new',
  mode: 'following',
  eoseReceived: false,
  newPostsBuffer: [],
});

let activeSub: PoolSubscription | null = null;
let reactionsSub: PoolSubscription | null = null;
let repliesSub: PoolSubscription | null = null;
let liveSub: PoolSubscription | null = null;
let collectedPostIds: Set<string> = new Set();
let seenReactionIds: Set<string> = new Set();
let seenReplyIds: Set<string> = new Set();

// ─── Actions ───

export function getFeedState(): FeedState {
  return feedState.value;
}

export function setSort(sort: FeedSort) {
  feedState.value = { ...feedState.value, sort, posts: sortPosts(feedState.value.posts, sort) };
}

export function setFeedMode(mode: FeedMode) {
  if (mode === feedState.value.mode) return;
  feedState.value = { ...feedState.value, mode };
  loadFeed();
}

export function flushNewPosts() {
  const s = feedState.value;
  if (s.newPostsBuffer.length === 0) return;
  const merged = [...s.newPostsBuffer, ...s.posts];
  feedState.value = { ...s, posts: sortPosts(merged, s.sort), newPostsBuffer: [] };
}

function sortPosts(posts: NostrEvent[], sort: FeedSort): NostrEvent[] {
  const sorted = [...posts];
  const s = feedState.value;
  switch (sort) {
    case 'new':
      return sorted.sort((a, b) => b.created_at - a.created_at);
    case 'top': {
      return sorted.sort((a, b) => {
        const aR = s.reactions.get(a.id)?.length || 0;
        const bR = s.reactions.get(b.id)?.length || 0;
        return bR - aR;
      });
    }
    case 'hot': {
      const now = Math.floor(Date.now() / 1000);
      return sorted.sort((a, b) => {
        const aR = s.reactions.get(a.id)?.length || 0;
        const bR = s.reactions.get(b.id)?.length || 0;
        const aAge = (now - a.created_at) / 3600 + 2;
        const bAge = (now - b.created_at) / 3600 + 2;
        return (bR / Math.pow(bAge, 1.5)) - (aR / Math.pow(aAge, 1.5));
      });
    }
    default: return sorted;
  }
}

function cleanupSubs() {
  if (activeSub) { activeSub.unsubscribe(); activeSub = null; }
  if (reactionsSub) { reactionsSub.unsubscribe(); reactionsSub = null; }
  if (repliesSub) { repliesSub.unsubscribe(); repliesSub = null; }
  if (liveSub) { liveSub.unsubscribe(); liveSub = null; }
}

export function resetFeed(): void {
  cleanupSubs();
  collectedPostIds = new Set();
  seenReactionIds = new Set();
  seenReplyIds = new Set();
  feedState.value = {
    posts: [], reactions: new Map(), replyCounts: new Map(),
    isLoading: false, sort: 'new', mode: 'following',
    eoseReceived: false, newPostsBuffer: [],
  };
}

export function loadFeed(limit: number = 50) {
  const pool = getPool();
  cleanupSubs();
  collectedPostIds = new Set();
  seenReactionIds = new Set();
  seenReplyIds = new Set();

  feedState.value = { ...feedState.value, isLoading: true, posts: [], reactions: new Map(), replyCounts: new Map(), eoseReceived: false, newPostsBuffer: [] };

  let eoseCount = 0;
  const s = feedState.value;

  const filter: Record<string, any> = { kinds: [Kind.Text], limit };
  const isFollowing = s.mode === 'following';
  let authors: string[] = [];
  if (isFollowing) {
    authors = getFollowingList();
    if (authors.length === 0) {
      feedState.value = { ...feedState.value, isLoading: false, eoseReceived: true };
      return;
    }
    filter.authors = authors;
  }

  // For following mode, hydrate from server cache first
  if (isFollowing && authors.length > 0) {
    getCachedFeed(authors, limit).then((cached) => {
      if (cached.length > 0) {
        for (const event of cached) {
          if (isRootNote(event) && !collectedPostIds.has(event.id)) collectedPostIds.add(event.id);
        }
        const rootNotes = cached.filter((e) => isRootNote(e));
        if (rootNotes.length > 0 && feedState.value.posts.length === 0) {
          feedState.value = { ...feedState.value, posts: sortPosts(rootNotes, feedState.value.sort) };
        }
      }
    }).catch(() => {});
  }

  const outboxUrls = getOutboxUrls();
  const useOutbox = outboxUrls.length > 0;

  const onEvent = (event: NostrEvent) => {
    if (!isRootNote(event)) return;
    if (collectedPostIds.has(event.id)) return;
    collectedPostIds.add(event.id);
    if (isFollowing) cacheEvent(event);

    feedState.value = {
      ...feedState.value,
      posts: sortPosts([...feedState.value.posts, event], feedState.value.sort),
    };
  };

  const onEose = () => {
    eoseCount++;
    if (eoseCount >= 1) {
      feedState.value = { ...feedState.value, isLoading: false, eoseReceived: true };
      if (activeSub) { activeSub.unsubscribe(); activeSub = null; }

      if (collectedPostIds.size > 0) {
        const ids = Array.from(collectedPostIds);
        fetchReactionsBatch(ids);
        fetchReplyCounts(ids);
      }
      startLiveSubscription();
    }
  };

  activeSub = useOutbox
    ? pool.subscribeToUrls(outboxUrls, [filter], onEvent, onEose)
    : pool.subscribe([filter], onEvent, onEose);
}

export function loadMore(count: number = 30) {
  const s = feedState.value;
  if (s.posts.length === 0 || s.isLoading) return;
  const pool = getPool();

  const oldestTimestamp = s.posts[s.posts.length - 1].created_at;
  feedState.value = { ...s, isLoading: true };

  const newIds: string[] = [];
  const outboxUrls = getOutboxUrls();
  const useOutbox = outboxUrls.length > 0;

  const paginationFilter = [{ kinds: [Kind.Text], until: oldestTimestamp - 1, limit: count }];

  const onEvent = (event: NostrEvent) => {
    if (!isRootNote(event)) return;
    if (collectedPostIds.has(event.id)) return;
    collectedPostIds.add(event.id);
    newIds.push(event.id);

    feedState.value = {
      ...feedState.value,
      posts: sortPosts([...feedState.value.posts, event], feedState.value.sort),
    };
  };

  const onEose = () => {
    sub.unsubscribe();
    feedState.value = { ...feedState.value, isLoading: false };
    if (newIds.length > 0) {
      fetchReactionsBatch(newIds);
      fetchReplyCounts(newIds);
    }
  };

  const sub = useOutbox
    ? pool.subscribeToUrls(outboxUrls, paginationFilter, onEvent, onEose)
    : pool.subscribe(paginationFilter, onEvent, onEose);
}

function startLiveSubscription() {
  const pool = getPool();
  const since = Math.floor(Date.now() / 1000);
  const outboxUrls = getOutboxUrls();
  const isFollowing = feedState.value.mode === 'following';

  const liveFilter: Record<string, any>[] = [{ kinds: [Kind.Text], since }];
  if (isFollowing) {
    const authors = getFollowingList();
    if (authors.length > 0) liveFilter[0].authors = authors;
  }

  const onLiveEvent = (event: NostrEvent) => {
    if (!isRootNote(event)) return;
    if (collectedPostIds.has(event.id)) return;
    collectedPostIds.add(event.id);
    if (isFollowing) cacheEvent(event);

    feedState.value = { ...feedState.value, newPostsBuffer: [...feedState.value.newPostsBuffer, event] };
  };

  liveSub = outboxUrls.length > 0
    ? pool.subscribeToUrls(outboxUrls, liveFilter, onLiveEvent)
    : pool.subscribe(liveFilter, onLiveEvent);
}

function fetchReactionsBatch(eventIds: string[]) {
  const pool = getPool();
  if (reactionsSub) reactionsSub.unsubscribe();

  reactionsSub = pool.subscribe(
    [{ kinds: [Kind.Reaction], '#e': eventIds }],
    (reaction) => {
      if (seenReactionIds.has(reaction.id)) return;
      seenReactionIds.add(reaction.id);
      cacheEvent(reaction);

      const eTag = reaction.tags.find((t) => t[0] === 'e');
      if (!eTag) return;
      const targetId = eTag[1];
      if (!eventIds.includes(targetId)) return;

      const s = feedState.value;
      const existing = s.reactions.get(targetId) || [];
      const updated = new Map(s.reactions);
      updated.set(targetId, [...existing, reaction]);
      feedState.value = { ...s, reactions: updated };
    },
    () => {
      if (reactionsSub) { reactionsSub.unsubscribe(); reactionsSub = null; }
      const s = feedState.value;
      if (s.sort !== 'new') {
        feedState.value = { ...s, posts: sortPosts(s.posts, s.sort) };
      }
    },
  );
}

function fetchReplyCounts(eventIds: string[]) {
  const pool = getPool();
  if (repliesSub) repliesSub.unsubscribe();

  repliesSub = pool.subscribe(
    [{ kinds: [Kind.Text], '#e': eventIds }],
    (event) => {
      if (seenReplyIds.has(event.id)) return;
      seenReplyIds.add(event.id);

      const eTags = event.tags.filter((t) => t[0] === 'e');
      if (eTags.length === 0) return;
      const targetId = eTags[eTags.length - 1][1];
      if (!eventIds.includes(targetId)) return;

      const s = feedState.value;
      const counts = new Map(s.replyCounts);
      counts.set(targetId, (counts.get(targetId) || 0) + 1);
      feedState.value = { ...s, replyCounts: counts };
    },
    () => {
      if (repliesSub) { repliesSub.unsubscribe(); repliesSub = null; }
    },
  );
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeFeed(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      feedState.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
