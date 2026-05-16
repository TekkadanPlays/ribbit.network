import { Component } from 'inferno';
import { createElement } from 'inferno-create-element';
import { Link } from 'inferno-router';
import { Relay } from '../../nostr/relay';
import type { NostrEvent } from '../../nostr/event';
import {
  getRelayManagerState,
  subscribeRelayManager,
  addRelayToProfile,
} from '../store/relaymanager';
import type { RelayProfile } from '../store/relaymanager';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';

// ---------------------------------------------------------------------------
// Relay Discovery — native monitor with NIP-66 WebSocket fallback
// ---------------------------------------------------------------------------
// Primary: mycelium's built-in probe engine serves /relays/* from SQLite.
// Fallback: If the API is unavailable, query NIP-66 monitor relays
// directly via WebSocket for kind 30166 relay metadata events.

const MONITOR_RELAYS = [
  'wss://relay.nostr.watch',
  'wss://history.nostr.watch',
];

function parseNip66Event(event: NostrEvent): RelayInfo | null {
  const dTag = event.tags.find((t: string[]) => t[0] === 'd');
  if (!dTag || !dTag[1]) return null;
  const url = dTag[1];
  let name = '';
  let description = '';
  let software = '';
  let version = '';
  let contact = '';
  const supportedNips: number[] = [];
  for (const tag of event.tags) {
    if (tag[0] === 'N' && tag[1]) { const n = parseInt(tag[1], 10); if (!isNaN(n)) supportedNips.push(n); }
    if (tag[0] === 'R' && tag[1] === 'name' && tag[2]) name = tag[2];
    if (tag[0] === 'R' && tag[1] === 'desc' && tag[2]) description = tag[2];
    if (tag[0] === 'R' && tag[1] === 'software' && tag[2]) software = tag[2];
    if (tag[0] === 'R' && tag[1] === 'version' && tag[2]) version = tag[2];
    if (tag[0] === 'R' && tag[1] === 'contact' && tag[2]) contact = tag[2];
  }
  if (event.content) {
    try {
      const info = JSON.parse(event.content);
      if (!name && info.name) name = info.name;
      if (!description && info.description) description = info.description;
      if (!software && info.software) software = info.software;
      if (!version && info.version) version = info.version;
      if (!contact && info.contact) contact = info.contact;
      if (supportedNips.length === 0 && Array.isArray(info.supported_nips)) {
        for (const n of info.supported_nips) { if (typeof n === 'number') supportedNips.push(n); }
      }
    } catch { /* content isn't JSON */ }
  }
  const sw = software ? (software.split('/').pop() || software) : '';
  return {
    url,
    name: name || url.replace('wss://', '').replace('ws://', ''),
    description,
    software: sw,
    version,
    supportedNips: supportedNips.sort((a, b) => a - b),
    contact,
    pubkey: event.pubkey,
    countryCode: '',
    countryName: '',
    city: '',
    isOnline: true,
    uptimePct: null,
    rttRead: null,
    rttWrite: null,
    lastSeen: event.created_at,
  };
}

interface RelayInfo {
  url: string;
  name: string;
  description: string;
  software: string;
  version: string;
  supportedNips: number[];
  contact: string;
  pubkey: string;
  countryCode: string;
  countryName: string;
  city: string;
  isOnline: boolean;
  uptimePct: number | null;
  rttRead: number | null;
  rttWrite: number | null;
  lastSeen: number;
}

type SortMode = 'recent' | 'name' | 'nips' | 'rtt' | 'uptime';
type CountryFilter = '' | 'NA' | 'US' | 'CA' | string;

interface DiscoveryState {
  relays: RelayInfo[];
  isLoading: boolean;
  error: string | null;
  search: string;
  profiles: RelayProfile[];
  addMenuOpen: string | null;
  filterSoftware: string;
  filterNip: number | null;
  filterCountry: CountryFilter;
  sortBy: SortMode;
  showFilters: boolean;
  rstateAvailable: boolean;
}

const NA_COUNTRIES = new Set(['US', 'CA']);

// Parse rstate/native monitor relay object into our RelayInfo
function parseRstateRelay(raw: any): RelayInfo {
  const url = raw.relayUrl || raw.url || raw.relay_url || raw.d || '';
  const info = raw.info || raw.nip11 || {};
  const geo = raw.geo || raw.location || {};
  const nips: number[] = [];
  // Native monitor: nips.list
  if (raw.nips && Array.isArray(raw.nips.list)) {
    for (const n of raw.nips.list) { if (typeof n === 'number') nips.push(n); }
  }
  if (nips.length === 0 && Array.isArray(info.supported_nips)) {
    for (const n of info.supported_nips) { if (typeof n === 'number') nips.push(n); }
  }
  if (nips.length === 0 && Array.isArray(raw.supported_nips)) {
    for (const n of raw.supported_nips) { if (typeof n === 'number' && !nips.includes(n)) nips.push(n); }
  }

  // Software from native or NIP-11
  const swRaw = raw.software?.family?.value || info.software || raw.software || '';
  const sw = swRaw ? (swRaw.split('/').pop() || swRaw) : '';
  const ver = raw.software?.version?.value || info.version || raw.version || '';

  // RTT from native monitor
  const rttOpen = raw.rtt?.open?.value ?? null;
  const rttRead = raw.rtt?.read?.value ?? raw.rtt_read ?? raw.avg_rtt_read ?? null;

  return {
    url,
    name: info.name || raw.name || url.replace('wss://', '').replace('ws://', ''),
    description: info.description || raw.description || '',
    software: sw,
    version: ver,
    supportedNips: nips.sort((a, b) => a - b),
    contact: info.contact || raw.contact || '',
    pubkey: info.pubkey || raw.pubkey || '',
    countryCode: geo.country_code || geo.countryCode || raw.country_code || '',
    countryName: geo.country || geo.countryName || raw.country || '',
    city: geo.city || raw.city || '',
    isOnline: raw.online ?? raw.is_online ?? true,
    uptimePct: raw.uptime ?? raw.uptime_pct ?? null,
    rttRead: rttOpen ?? rttRead,
    rttWrite: raw.rtt?.write?.value ?? raw.rtt_write ?? raw.avg_rtt_write ?? null,
    lastSeen: raw.lastSeenAt ?? raw.last_seen ?? raw.created_at ?? 0,
  };
}

function collectSoftwareOptions(relays: RelayInfo[]): string[] {
  const set = new Set<string>();
  for (const r of relays) if (r.software) set.add(r.software);
  return Array.from(set).sort();
}

function collectNipOptions(relays: RelayInfo[]): number[] {
  const set = new Set<number>();
  for (const r of relays) for (const n of r.supportedNips) set.add(n);
  return Array.from(set).sort((a, b) => a - b);
}

function collectCountryOptions(relays: RelayInfo[]): { code: string; name: string }[] {
  const map = new Map<string, string>();
  for (const r of relays) {
    if (r.countryCode && !map.has(r.countryCode)) {
      map.set(r.countryCode, r.countryName || r.countryCode);
    }
  }
  return Array.from(map.entries())
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sortRelays(relays: RelayInfo[], mode: SortMode): RelayInfo[] {
  const copy = [...relays];
  switch (mode) {
    case 'name': return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'nips': return copy.sort((a, b) => b.supportedNips.length - a.supportedNips.length);
    case 'rtt': return copy.sort((a, b) => (a.rttRead ?? 9999) - (b.rttRead ?? 9999));
    case 'uptime': return copy.sort((a, b) => (b.uptimePct ?? 0) - (a.uptimePct ?? 0));
    case 'recent':
    default: return copy.sort((a, b) => b.lastSeen - a.lastSeen);
  }
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

export class RelayDiscovery extends Component<{}, DiscoveryState> {
  private unsubManager: (() => void) | null = null;
  private monitorRelay: Relay | null = null;
  declare state: DiscoveryState;

  constructor(props: {}) {
    super(props);
    this.state = {
      relays: [],
      isLoading: false,
      error: null,
      search: '',
      profiles: getRelayManagerState().profiles,
      addMenuOpen: null,
      filterSoftware: '',
      filterNip: null,
      filterCountry: '',
      sortBy: 'recent',
      showFilters: false,
      rstateAvailable: true,
    };
  }

  componentDidMount() {
    this.unsubManager = subscribeRelayManager(() => {
      this.setState({ ...this.state, profiles: getRelayManagerState().profiles });
    });
    this.fetchRelays();
  }

  componentWillUnmount() {
    this.unsubManager?.();
    if (this.monitorRelay) {
      this.monitorRelay.disconnect();
      this.monitorRelay = null;
    }
  }

  async fetchRelays() {
    this.setState({ ...this.state, isLoading: true, error: null });

    try {
      const res = await fetch('/relays?limit=1000');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const rawList = Array.isArray(data) ? data : (data.relays || data.data || []);
      const relays: RelayInfo[] = rawList.map(parseRstateRelay).filter((r: RelayInfo) => r.url);

      if (relays.length === 0) throw new Error('rstate returned empty list');
      this.setState({ ...this.state, relays, isLoading: false, rstateAvailable: true });
    } catch {
      // rstate unavailable — fall back to NIP-66 WebSocket
      this.fallbackToNip66();
    }
  }

  fallbackToNip66() {
    this.setState({ ...this.state, isLoading: true, error: null, rstateAvailable: false });

    const seen = new Map<string, RelayInfo>();
    const tryRelay = (url: string) => {
      const relay = new Relay(url);
      this.monitorRelay = relay;

      relay.connect().then(() => {
        relay.subscribe(
          [{ kinds: [30166], limit: 500 }],
          (event: NostrEvent) => {
            const info = parseNip66Event(event);
            if (info && !seen.has(info.url)) {
              seen.set(info.url, info);
              this.setState({ ...this.state, relays: Array.from(seen.values()), isLoading: false });
            }
          },
          () => {
            this.setState({ ...this.state, isLoading: false });
            relay.disconnect();
          },
        );
      }).catch(() => {
        // Try next monitor relay
        const nextIdx = MONITOR_RELAYS.indexOf(url) + 1;
        if (nextIdx < MONITOR_RELAYS.length) {
          tryRelay(MONITOR_RELAYS[nextIdx]);
        } else {
          this.setState({
            ...this.state,
            isLoading: false,
            error: 'Could not connect to any relay monitors. Check your network connection.',
          });
        }
      });
    };

    tryRelay(MONITOR_RELAYS[0]);
  }

  isRelayInAnyProfile(url: string): boolean {
    return this.state.profiles.some((p) => p.relays.includes(url));
  }

  getFiltered(): RelayInfo[] {
    const { relays, search, filterSoftware, filterNip, filterCountry, sortBy } = this.state;
    let result = relays;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) =>
        r.url.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.software.toLowerCase().includes(q) ||
        r.city.toLowerCase().includes(q) ||
        r.countryName.toLowerCase().includes(q)
      );
    }

    if (filterSoftware) {
      result = result.filter((r) => r.software === filterSoftware);
    }

    if (filterNip !== null) {
      result = result.filter((r) => r.supportedNips.includes(filterNip));
    }

    if (filterCountry) {
      if (filterCountry === 'NA') {
        result = result.filter((r) => NA_COUNTRIES.has(r.countryCode));
      } else {
        result = result.filter((r) => r.countryCode === filterCountry);
      }
    }

    return sortRelays(result, sortBy);
  }

  get activeFilterCount(): number {
    let count = 0;
    if (this.state.filterSoftware) count++;
    if (this.state.filterNip !== null) count++;
    if (this.state.filterCountry) count++;
    if (this.state.sortBy !== 'recent') count++;
    return count;
  }

  render() {
    const { relays, isLoading, error, search, profiles, addMenuOpen, filterSoftware, filterNip, filterCountry, sortBy, showFilters } = this.state;
    const filtered = this.getFiltered();
    const softwareOptions = collectSoftwareOptions(relays);
    const nipOptions = collectNipOptions(relays);
    const countryOptions = collectCountryOptions(relays);
    const filterCount = this.activeFilterCount;

    return createElement('div', { className: 'mx-auto max-w-3xl px-4 sm:px-6 py-6 space-y-4' },
      // Header
      createElement('div', { className: 'flex items-center justify-between' },
        createElement('div', null,
          createElement('h1', { className: 'text-xl font-bold tracking-tight' }, 'Discover Relays'),
          createElement('p', { className: 'text-sm text-muted-foreground mt-1' },
            'Browse relays monitored by mycelium. Filter by country, software, NIPs, or search.',
          ),
        ),
        createElement(Link, { to: '/settings/relays' },
          createElement(Button, { variant: 'outline', size: 'sm' }, '\u{1F4E1} Manager'),
        ),
      ),

      // Search + filter toggle
      createElement('div', { className: 'flex gap-2' },
        createElement(Input, {
          type: 'text',
          value: search,
          onInput: (e: Event) => this.setState({ ...this.state, search: (e.target as HTMLInputElement).value }),
          placeholder: 'Search by name, URL, software, city, country...',
          className: 'flex-1',
        }),
        createElement(Button, {
          variant: showFilters ? 'default' : 'outline',
          size: 'sm',
          onClick: () => this.setState({ ...this.state, showFilters: !showFilters }),
          className: 'shrink-0',
        },
          '\u{1F50D} Filters',
          filterCount > 0
            ? createElement('span', { className: 'ml-1 text-[10px] bg-primary-foreground/20 rounded-full px-1.5' }, String(filterCount))
            : null,
        ),
      ),

      // Filter panel
      showFilters
        ? createElement('div', { className: 'rounded-xl border border-border p-4 space-y-3 bg-muted/20' },
            createElement('div', { className: 'flex items-center justify-between' },
              createElement('p', { className: 'text-xs font-semibold uppercase tracking-wider text-muted-foreground' }, 'Filters'),
              filterCount > 0
                ? createElement('button', {
                    onClick: () => this.setState({ ...this.state, filterSoftware: '', filterNip: null, filterCountry: '', sortBy: 'recent' }),
                    className: 'text-xs text-primary hover:underline',
                  }, 'Clear all')
                : null,
            ),

            // Country filter
            createElement('div', null,
              createElement('label', { className: 'text-xs text-muted-foreground mb-1 block' }, 'Country / Region'),
              createElement('div', { className: 'flex flex-wrap gap-1.5' },
                ...([
                  { code: '', label: 'All' },
                  { code: 'NA', label: '\u{1F1FA}\u{1F1F8}\u{1F1E8}\u{1F1E6} North America' },
                  { code: 'US', label: '\u{1F1FA}\u{1F1F8} US' },
                  { code: 'CA', label: '\u{1F1E8}\u{1F1E6} Canada' },
                ] as { code: CountryFilter; label: string }[]).map((opt) =>
                  createElement('button', {
                    key: opt.code || 'all',
                    onClick: () => this.setState({ ...this.state, filterCountry: filterCountry === opt.code ? '' : opt.code }),
                    className: `text-xs px-2 py-1 rounded-md transition-colors ${
                      filterCountry === opt.code ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`,
                  }, opt.label),
                ),
              ),
            ),

            // Software filter
            createElement('div', null,
              createElement('label', { className: 'text-xs text-muted-foreground mb-1 block' }, 'Software'),
              createElement('div', { className: 'flex flex-wrap gap-1.5' },
                createElement('button', {
                  onClick: () => this.setState({ ...this.state, filterSoftware: '' }),
                  className: `text-xs px-2 py-1 rounded-md transition-colors ${
                    !filterSoftware ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`,
                }, 'All'),
                ...softwareOptions.map((sw) =>
                  createElement('button', {
                    key: sw,
                    onClick: () => this.setState({ ...this.state, filterSoftware: filterSoftware === sw ? '' : sw }),
                    className: `text-xs px-2 py-1 rounded-md transition-colors ${
                      filterSoftware === sw ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`,
                  }, sw),
                ),
              ),
            ),

            // NIP filter
            createElement('div', null,
              createElement('label', { className: 'text-xs text-muted-foreground mb-1 block' }, 'Supports NIP'),
              createElement('div', { className: 'flex flex-wrap gap-1' },
                createElement('button', {
                  onClick: () => this.setState({ ...this.state, filterNip: null }),
                  className: `text-[10px] px-1.5 py-0.5 rounded transition-colors font-mono ${
                    filterNip === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`,
                }, 'Any'),
                ...nipOptions.slice(0, 40).map((n) =>
                  createElement('button', {
                    key: String(n),
                    onClick: () => this.setState({ ...this.state, filterNip: filterNip === n ? null : n }),
                    className: `text-[10px] px-1.5 py-0.5 rounded transition-colors font-mono ${
                      filterNip === n ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`,
                  }, String(n).padStart(2, '0')),
                ),
              ),
            ),

            // Sort
            createElement('div', null,
              createElement('label', { className: 'text-xs text-muted-foreground mb-1 block' }, 'Sort by'),
              createElement('div', { className: 'flex gap-1.5' },
                ...([
                  { key: 'recent' as SortMode, label: 'Recent' },
                  { key: 'name' as SortMode, label: 'Name' },
                  { key: 'nips' as SortMode, label: 'Most NIPs' },
                  { key: 'rtt' as SortMode, label: 'Fastest RTT' },
                  { key: 'uptime' as SortMode, label: 'Best Uptime' },
                ]).map((opt) =>
                  createElement('button', {
                    key: opt.key,
                    onClick: () => this.setState({ ...this.state, sortBy: opt.key }),
                    className: `text-xs px-2 py-1 rounded-md transition-colors ${
                      sortBy === opt.key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`,
                  }, opt.label),
                ),
              ),
            ),
          )
        : null,

      // Stats
      createElement('div', { className: 'flex items-center gap-3 text-xs text-muted-foreground' },
        isLoading
          ? createElement('span', { className: 'animate-pulse' },
              this.state.rstateAvailable ? 'Loading relays...' : 'Loading relays via NIP-66 monitors...',
            )
          : createElement('span', null,
              filtered.length + ' relay' + (filtered.length !== 1 ? 's' : ''),
              relays.length !== filtered.length ? ` (of ${relays.length} total)` : '',
            ),
        !isLoading && relays.length > 0
          ? createElement('span', { className: 'text-muted-foreground/50' },
              this.state.rstateAvailable ? 'native monitor' : 'via NIP-66',
            )
          : null,
        error ? createElement('span', { className: 'text-destructive' }, error) : null,
      ),

      // Relay list
      filtered.length > 0
        ? createElement('div', { className: 'space-y-2' },
            ...filtered.slice(0, 100).map((relay) => {
              const inProfile = this.isRelayInAnyProfile(relay.url);
              const menuOpen = addMenuOpen === relay.url;
              const flag = countryFlag(relay.countryCode);

              return createElement('div', {
                key: relay.url,
                className: 'rounded-xl border border-border p-4 hover:border-primary/20 transition-colors',
              },
                createElement('div', { className: 'flex items-start justify-between gap-3' },
                  createElement('div', { className: 'flex-1 min-w-0' },
                    // Name row
                    createElement('div', { className: 'flex items-center gap-2 mb-1' },
                      flag ? createElement('span', { className: 'text-sm shrink-0' }, flag) : null,
                      createElement(Link, {
                        to: '/relay/' + encodeURIComponent(relay.url),
                        className: 'text-sm font-semibold truncate hover:text-primary transition-colors',
                      }, relay.name),
                      relay.software
                        ? createElement(Badge, { variant: 'secondary', className: 'text-[10px] shrink-0' },
                            relay.software + (relay.version ? ' ' + relay.version : ''),
                          )
                        : null,
                      inProfile
                        ? createElement(Badge, { variant: 'outline', className: 'text-[10px] shrink-0 text-emerald-600' }, 'Added')
                        : null,
                    ),
                    createElement('p', { className: 'text-xs font-mono text-muted-foreground truncate' }, relay.url),

                    // Geo + metrics row
                    createElement('div', { className: 'flex flex-wrap items-center gap-3 mt-1.5 text-[11px] text-muted-foreground' },
                      relay.city || relay.countryName
                        ? createElement('span', null,
                            (relay.city ? relay.city + ', ' : '') + relay.countryName,
                          )
                        : null,
                      relay.rttRead !== null
                        ? createElement('span', { className: relay.rttRead < 200 ? 'text-emerald-600' : relay.rttRead < 500 ? 'text-amber-500' : 'text-destructive' },
                            relay.rttRead + 'ms RTT',
                          )
                        : null,
                      relay.uptimePct !== null
                        ? createElement('span', { className: relay.uptimePct > 95 ? 'text-emerald-600' : relay.uptimePct > 80 ? 'text-amber-500' : 'text-destructive' },
                            relay.uptimePct.toFixed(1) + '% uptime',
                          )
                        : null,
                      relay.isOnline
                        ? createElement('span', { className: 'text-emerald-600' }, '\u25CF online')
                        : createElement('span', { className: 'text-destructive' }, '\u25CF offline'),
                    ),

                    relay.description
                      ? createElement('p', { className: 'text-xs text-muted-foreground mt-1 line-clamp-2' }, relay.description)
                      : null,
                    relay.supportedNips.length > 0
                      ? createElement('div', { className: 'flex flex-wrap gap-1 mt-2' },
                          ...relay.supportedNips.slice(0, 15).map((n) =>
                            createElement('button', {
                              key: String(n),
                              onClick: () => this.setState({ ...this.state, filterNip: n, showFilters: true }),
                              className: `text-[10px] px-1.5 py-0.5 rounded font-mono transition-colors ${
                                filterNip === n
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-accent'
                              }`,
                            }, 'NIP-' + String(n).padStart(2, '0')),
                          ),
                          relay.supportedNips.length > 15
                            ? createElement('span', { className: 'text-[10px] text-muted-foreground/50' },
                                '+' + (relay.supportedNips.length - 15) + ' more',
                              )
                            : null,
                        )
                      : null,
                  ),

                  // Add to profile button
                  createElement('div', { className: 'relative shrink-0' },
                    createElement(Button, {
                      variant: inProfile ? 'outline' : 'default',
                      size: 'sm',
                      onClick: (e: Event) => {
                        e.stopPropagation();
                        this.setState({ ...this.state, addMenuOpen: menuOpen ? null : relay.url });
                      },
                    }, inProfile ? 'Add to...' : '+ Add'),

                    // Profile selector dropdown
                    menuOpen
                      ? createElement('div', {
                          className: 'absolute right-0 top-full mt-1 w-48 bg-popover border border-border rounded-lg shadow-lg py-1 z-50',
                        },
                          ...profiles.map((profile) => {
                            const alreadyIn = profile.relays.includes(relay.url);
                            return createElement('button', {
                              key: profile.id,
                              disabled: alreadyIn,
                              onClick: () => {
                                addRelayToProfile(profile.id, relay.url);
                                this.setState({ ...this.state, addMenuOpen: null });
                              },
                              className: `flex items-center justify-between w-full px-3 py-2 text-sm transition-colors ${
                                alreadyIn
                                  ? 'text-muted-foreground/40 cursor-not-allowed'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                              }`,
                            },
                              profile.name,
                              alreadyIn
                                ? createElement('span', { className: 'text-[10px] text-emerald-600' }, '\u2713')
                                : null,
                            );
                          }),
                        )
                      : null,
                  ),
                ),
              );
            }),
          )
        : !isLoading
          ? createElement('div', { className: 'text-center py-16' },
              createElement('div', { className: 'text-3xl mb-3' }, '\u{1F4E1}'),
              createElement('p', { className: 'text-sm text-muted-foreground' },
                filterCount > 0 ? 'No relays match your filters.' : 'No relays found.',
              ),
              filterCount > 0
                ? createElement('button', {
                    onClick: () => this.setState({ ...this.state, filterSoftware: '', filterNip: null, filterCountry: '', sortBy: 'recent', search: '' }),
                    className: 'text-xs text-primary hover:underline mt-2 inline-block',
                  }, 'Clear filters')
                : null,
            )
          : null,
    );
  }
}
