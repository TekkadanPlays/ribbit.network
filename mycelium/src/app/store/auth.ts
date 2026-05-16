import { signal, batch, effect } from '@preact/signals-core';
import { hasNip07, getNip07PublicKey } from '../../nostr/nip07';
import { isAndroid, requestPublicKey as nip55RequestPubkey, parseNip55Callback, clearNip55Callback } from '../../nostr/nip55';
import { flushAndResetIngest } from '../api/cache';
import { resetProfiles } from './profiles';
import { resetContacts } from './contacts';
import { resetFeed } from './feed';
import { resetNotifications } from './notifications';
import { resetBootstrap } from './bootstrap';
import { resetRelayList } from './relaylist';
import { cleanupCrawler } from './relay-crawler';
import { getPool } from './relay';

// ─── Signals ───

export const authPubkey = signal<string | null>(null);
export const authLoading = signal(false);
export const authError = signal<string | null>(null);

// ─── Actions ───

export async function login(): Promise<void> {
  if (hasNip07()) {
    batch(() => { authLoading.value = true; authError.value = null; });
    try {
      const pubkey = await getNip07PublicKey();
      batch(() => { authPubkey.value = pubkey; authLoading.value = false; authError.value = null; });
      if (typeof localStorage !== 'undefined') localStorage.setItem('ribbit_pubkey', pubkey);
    } catch (err) {
      batch(() => { authLoading.value = false; authError.value = String(err); });
    }
    return;
  }

  if (isAndroid()) {
    batch(() => { authLoading.value = true; authError.value = null; });
    nip55RequestPubkey();
    return;
  }

  authError.value = 'No Nostr signer found. Install a NIP-07 extension (desktop) or Amber (Android).';
}

/**
 * Reset all per-user stores. Called on sign-out and before account switch.
 * Flushes pending cache writes, cancels subscriptions, clears in-memory state.
 */
export function resetAllStores(): void {
  flushAndResetIngest();
  resetFeed();
  resetNotifications();
  resetContacts();
  resetProfiles();
  resetBootstrap();
  resetRelayList();
  cleanupCrawler();
  getPool().clearSeenEvents();
}

export function logout() {
  resetAllStores();
  batch(() => { authPubkey.value = null; authLoading.value = false; authError.value = null; });
  if (typeof localStorage !== 'undefined') localStorage.removeItem('ribbit_pubkey');
}

// Restore session from localStorage, then check for NIP-55 callback
export function restoreSession() {
  if (typeof localStorage === 'undefined') return;

  const nip55 = parseNip55Callback();
  if (nip55 && nip55.action === 'get_public_key' && nip55.result) {
    const pubkey = nip55.result;
    localStorage.setItem('ribbit_pubkey', pubkey);
    batch(() => { authPubkey.value = pubkey; authLoading.value = false; authError.value = null; });
    clearNip55Callback();
    return;
  }

  const saved = localStorage.getItem('ribbit_pubkey');
  if (saved) {
    batch(() => { authPubkey.value = saved; authLoading.value = false; authError.value = null; });
  }
}

// ─── Legacy compat ───

export interface AuthState {
  pubkey: string | null;
  isLoading: boolean;
  error: string | null;
}

export function getAuthState(): AuthState {
  return { pubkey: authPubkey.value, isLoading: authLoading.value, error: authError.value };
}

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeAuth(listener: () => void): () => void {
  _legacyListeners.add(listener);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      authPubkey.value; authLoading.value; authError.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => _legacyListeners.delete(listener);
}
