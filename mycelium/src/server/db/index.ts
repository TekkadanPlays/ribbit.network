// ---------------------------------------------------------------------------
// Database barrel export
// ---------------------------------------------------------------------------
export { getDb, closeDb } from './schema';
export { TTLCache } from './cache';

// Event store
export {
  storeEvent,
  storeEvents,
  getEvent,
  getLatestEvent,
  getEventsByKind,
  getEventsByKindAndPubkey,
  getEventsByKindAndPubkeyUntil,
  getEventsByKindAndAuthors,
  getEventsByTag,
  getProfiles as getProfileEvents,
  getEventCount,
  deleteEvent,
} from './events';
export type { StoredEvent } from './events';

// Materialized views
export { upsertProfile, getProfile, getProfilesBatch, searchProfiles } from './profiles';
export type { ProfileRow } from './profiles';

export { upsertRelayList, getRelayList, getRelayListsBatch, getPopularWriteRelays } from './relay-lists';
export type { RelayEntry } from './relay-lists';

export { upsertContactList, getContactList, getFollowingSet } from './contacts';
export type { ContactEntry } from './contacts';

// Relay monitor
export {
  initMonitorTables, upsertRelays, saveCheckResult, saveCheckResults,
  getRelays, getRelayState, getRelayHistory,
  getRelaysBySoftware, getRelaysByNip, getRelaysByNetwork,
  getMonitorStats, getAllRelayUrls, getOnlineRelayUrls,
} from './monitor';
export type { RelayCheck, RelayRow } from './monitor';
