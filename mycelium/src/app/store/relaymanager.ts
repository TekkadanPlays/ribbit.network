import { signal, effect } from '@preact/signals-core';
import { getPool } from './relay';
import { addRelay, removeRelay } from './relay';

// ---------------------------------------------------------------------------
// Relay Manager Store
// ---------------------------------------------------------------------------

export interface RelayProfile {
  id: string;
  name: string;
  relays: string[];
  builtin?: boolean;
}

export interface RelayManagerState {
  profiles: RelayProfile[];
  activeProfileId: string;
}

const STORAGE_KEY = 'ribbit_relay_profiles';

const DEFAULT_PROFILES: RelayProfile[] = [
  { id: 'outbox', name: 'Outbox', relays: [], builtin: true },
  { id: 'inbox', name: 'Inbox', relays: [], builtin: true },
  { id: 'indexers', name: 'Indexers', relays: [], builtin: true },
];

// ─── Signal ───

export const relayManagerState = signal<RelayManagerState>({
  profiles: [...DEFAULT_PROFILES],
  activeProfileId: 'outbox',
});

function persist() {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(relayManagerState.value));
  }
}

// ─── Actions ───

export function loadRelayManager() {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as RelayManagerState;
      const builtinIds = new Set(DEFAULT_PROFILES.map((p) => p.id));
      const merged: RelayProfile[] = [];
      for (const def of DEFAULT_PROFILES) {
        const saved_profile = saved.profiles.find((p) => p.id === def.id);
        merged.push(saved_profile ? { ...saved_profile, builtin: true } : { ...def });
      }
      for (const p of saved.profiles) {
        if (!builtinIds.has(p.id)) merged.push({ ...p, builtin: false });
      }
      relayManagerState.value = { profiles: merged, activeProfileId: saved.activeProfileId || 'outbox' };
    }
  } catch {}
}

export function getRelayManagerState(): RelayManagerState {
  return relayManagerState.value;
}

export function getActiveProfile(): RelayProfile {
  const s = relayManagerState.value;
  return s.profiles.find((p) => p.id === s.activeProfileId) || s.profiles[0];
}

export function setActiveProfile(profileId: string) {
  relayManagerState.value = { ...relayManagerState.value, activeProfileId: profileId };
  persist();
  syncPoolToActiveProfile();
}

export function addRelayToProfile(profileId: string, url: string) {
  let normalized = url.trim();
  if (!normalized.startsWith('wss://') && !normalized.startsWith('ws://')) normalized = 'wss://' + normalized;
  normalized = normalized.replace(/\/+$/, '');

  const s = relayManagerState.value;
  relayManagerState.value = {
    ...s,
    profiles: s.profiles.map((p) =>
      p.id === profileId && !p.relays.includes(normalized)
        ? { ...p, relays: [...p.relays, normalized] }
        : p,
    ),
  };
  persist();

  if (profileId === relayManagerState.value.activeProfileId) addRelay(normalized);
}

export function removeRelayFromProfile(profileId: string, url: string) {
  const s = relayManagerState.value;
  relayManagerState.value = {
    ...s,
    profiles: s.profiles.map((p) =>
      p.id === profileId ? { ...p, relays: p.relays.filter((r) => r !== url) } : p,
    ),
  };
  persist();

  if (profileId === relayManagerState.value.activeProfileId) removeRelay(url);
}

export function createProfile(name: string): string {
  const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const s = relayManagerState.value;
  relayManagerState.value = {
    ...s,
    profiles: [...s.profiles, { id, name, relays: [], builtin: false }],
  };
  persist();
  return id;
}

export function renameProfile(profileId: string, name: string) {
  const s = relayManagerState.value;
  relayManagerState.value = {
    ...s,
    profiles: s.profiles.map((p) => p.id === profileId && !p.builtin ? { ...p, name } : p),
  };
  persist();
}

export function deleteProfile(profileId: string) {
  const s = relayManagerState.value;
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile || profile.builtin) return;

  relayManagerState.value = {
    ...s,
    profiles: s.profiles.filter((p) => p.id !== profileId),
    activeProfileId: s.activeProfileId === profileId ? 'outbox' : s.activeProfileId,
  };
  persist();
}

// Sync the relay pool to match the active profile's relay list
export function syncPoolToActiveProfile() {
  const pool = getPool();
  const active = getActiveProfile();
  const currentUrls = new Set(Array.from(pool.getStatus().keys()));
  const targetUrls = new Set(active.relays);

  for (const url of currentUrls) {
    if (!targetUrls.has(url)) removeRelay(url);
  }
  for (const url of targetUrls) {
    if (!currentUrls.has(url)) addRelay(url);
  }
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeRelayManager(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      relayManagerState.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
