// ============================================================================
// SyncService — Offline-First Hybrid Sync engine
// ----------------------------------------------------------------------------
// Responsibilities:
//   1. Query all locally-pending (isSynced != true) records across every table.
//   2. Batch them by entity type and POST to /api/sync/push.
//   3. On success, flip each record's isSynced flag to true + set synced_at.
//   4. On failure (network / 5xx), leave isSynced=false — they'll be retried
//      on the next 'online' event or the next periodic timer tick.
//
// Design principles:
//   - Never blocks the local write path. SyncService.scheduleSync() is fire-
//     and-forget; the caller's transaction commits locally before sync starts.
//   - Single-flight: if a sync is already running, additional triggers are
//     coalesced into a single pending flag that re-runs once the current
//     sync completes.
//   - Idempotent: the server upserts by primary key, so re-pushing the same
//     record is safe.
//   - Observable: exposes `getPendingCounts()` and `onSyncStateChange()` so
//     the UI can render a sync badge ("Online · 3 pending" etc).
// ============================================================================

import { db } from '@/lib/db/dexie'

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type EntityName =
  | 'products'
  | 'customers'
  | 'purchases'
  | 'sales'
  | 'sale_items'
  | 'collections'
  | 'distributor_settings'
  | 'damages'
  | 'purchase_returns'
  | 'sales_returns'

export interface SyncState {
  isOnline: boolean
  isSyncing: boolean
  pendingCounts: Record<EntityName, number>
  totalPending: number
  lastSyncAt: string | null
  lastError: string | null
}

type SyncStateListener = (state: SyncState) => void

// ----------------------------------------------------------------------------
// Internal state
// ----------------------------------------------------------------------------

const STATE: SyncState = {
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  isSyncing: false,
  pendingCounts: {
    products: 0,
    customers: 0,
    purchases: 0,
    sales: 0,
    sale_items: 0,
    collections: 0,
    distributor_settings: 0,
    damages: 0,
    purchase_returns: 0,
    sales_returns: 0,
  },
  totalPending: 0,
  lastSyncAt: null,
  lastError: null,
}

const listeners = new Set<SyncStateListener>()
let pendingTrigger = false  // true when a sync was requested but one is already running
let periodicTimer: ReturnType<typeof setInterval> | null = null

// ----------------------------------------------------------------------------
// State management + subscription
// ----------------------------------------------------------------------------

function setState(patch: Partial<SyncState>) {
  Object.assign(STATE, patch)
  // Recompute totalPending whenever pendingCounts changes
  if ('pendingCounts' in patch) {
    STATE.totalPending = Object.values(STATE.pendingCounts).reduce(
      (s, n) => s + n,
      0
    )
  }
  for (const l of listeners) {
    try {
      l({ ...STATE, pendingCounts: { ...STATE.pendingCounts } })
    } catch (e) {
      // Listener errors must not break the sync engine
      console.warn('[SyncService] listener threw:', e)
    }
  }
}

export function getSyncState(): SyncState {
  return { ...STATE, pendingCounts: { ...STATE.pendingCounts } }
}

export function onSyncStateChange(listener: SyncStateListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ----------------------------------------------------------------------------
// Online/offline detection
// ----------------------------------------------------------------------------

function updateOnlineStatus() {
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true
  setState({ isOnline: online })
  if (online) {
    // We're back online — trigger a background sync of all pending records.
    scheduleSyncAll()
  }
}

export function initNetworkListeners(): () => void {
  if (typeof window === 'undefined') return () => {}

  window.addEventListener('online', updateOnlineStatus)
  window.addEventListener('offline', updateOnlineStatus)

  // Also poll navigator.onLine every 30s in case the events don't fire
  // (some browsers / OSes are unreliable with the online event).
  if (!periodicTimer) {
    periodicTimer = setInterval(() => {
      const online = navigator.onLine
      if (online !== STATE.isOnline) {
        updateOnlineStatus()
      }
      // Also re-check for pending records periodically
      if (online && !STATE.isSyncing) {
        scheduleSyncAll()
      }
    }, 30_000)
  }

  // Initial check + initial sync attempt
  updateOnlineStatus()

  return () => {
    window.removeEventListener('online', updateOnlineStatus)
    window.removeEventListener('offline', updateOnlineStatus)
    if (periodicTimer) {
      clearInterval(periodicTimer)
      periodicTimer = null
    }
  }
}

// ----------------------------------------------------------------------------
// Pending record queries
// ----------------------------------------------------------------------------

/**
 * Query all records in a table where isSynced is not true.
 * Handles legacy rows (isSynced === undefined) by treating them as pending.
 */
async function getPending<T>(
  table: typeof db.products | typeof db.customers | typeof db.purchases |
         typeof db.sales | typeof db.sale_items | typeof db.collections |
         typeof db.distributor_settings | typeof db.damages |
         typeof db.purchase_returns | typeof db.sales_returns
): Promise<T[]> {
  // .where('isSynced').notEqual(true) doesn't match undefined values in Dexie,
  // so we use a collection filter that includes both undefined and false.
  const all = await table.toArray()
  return all.filter((r: any) => r.isSynced !== true) as T[]
}

export async function getPendingCounts(): Promise<Record<EntityName, number>> {
  const counts = {
    products: (await getPending(db.products)).length,
    customers: (await getPending(db.customers)).length,
    purchases: (await getPending(db.purchases)).length,
    sales: (await getPending(db.sales)).length,
    sale_items: (await getPending(db.sale_items)).length,
    collections: (await getPending(db.collections)).length,
    distributor_settings: (await getPending(db.distributor_settings)).length,
    damages: (await getPending(db.damages)).length,
    purchase_returns: (await getPending(db.purchase_returns)).length,
    sales_returns: (await getPending(db.sales_returns)).length,
  }
  return counts
}

/**
 * Refresh the public SyncState with current pending counts (does not trigger
 * a sync). Used by UI components to render the badge.
 */
export async function refreshPendingCounts(): Promise<void> {
  const counts = await getPendingCounts()
  setState({ pendingCounts: counts })
}

// ----------------------------------------------------------------------------
// Mark records as synced
// ----------------------------------------------------------------------------

async function markSynced(
  entity: EntityName,
  ids: (number | string)[]
): Promise<void> {
  if (ids.length === 0) return
  const table = (db as any)[entity]
  const now = new Date().toISOString()
  await table.bulkUpdate(
    ids.map((id) => ({
      key: id,
      changes: { isSynced: true, synced_at: now },
    }))
  )
}

// ----------------------------------------------------------------------------
// Core sync engine
// ----------------------------------------------------------------------------

/**
 * Push all pending records to the PostgreSQL backend.
 *
 * Returns the per-entity sync results. Safe to call repeatedly — idempotent
 * upserts on the server side mean re-pushing a synced record is harmless.
 */
export async function syncAllPending(): Promise<{
  syncedCounts: Record<EntityName, number>
  errors: { entity: string; message: string }[]
}> {
  // Single-flight: if already running, set the pending flag and return.
  if (STATE.isSyncing) {
    pendingTrigger = true
    return {
      syncedCounts: emptyCounts(),
      errors: [],
    }
  }

  // Bail out silently if we're offline.
  if (!STATE.isOnline) {
    await refreshPendingCounts()
    return {
      syncedCounts: emptyCounts(),
      errors: [{ entity: '*', message: 'Offline — sync deferred' }],
    }
  }

  setState({ isSyncing: true, lastError: null })

  try {
    const pendingCounts = await getPendingCounts()
    setState({ pendingCounts: pendingCounts })

    // If there's nothing to sync, exit fast.
    const total = Object.values(pendingCounts).reduce((s, n) => s + n, 0)
    if (total === 0) {
      setState({ isSyncing: false, lastSyncAt: new Date().toISOString() })
      return { syncedCounts: emptyCounts(), errors: [] }
    }

    // Build the batch payload
    const batches: Record<EntityName, any[]> = {
      products: await getPending(db.products),
      customers: await getPending(db.customers),
      purchases: await getPending(db.purchases),
      sales: await getPending(db.sales),
      sale_items: await getPending(db.sale_items),
      collections: await getPending(db.collections),
      distributor_settings: await getPending(db.distributor_settings),
      damages: await getPending(db.damages),
      purchase_returns: await getPending(db.purchase_returns),
      sales_returns: await getPending(db.sales_returns),
    }

    // Strip isSynced/synced_at from the payload (server sets its own)
    const cleanBatches: Record<string, any[]> = {}
    for (const k of Object.keys(batches) as EntityName[]) {
      cleanBatches[k] = batches[k].map(({ isSynced, synced_at, ...rest }: any) => rest)
    }

    // POST to /api/sync/push
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batches: cleanBatches }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = `Server responded ${res.status}: ${text.slice(0, 200)}`
      setState({ isSyncing: false, lastError: err })
      return {
        syncedCounts: emptyCounts(),
        errors: [{ entity: '*', message: err }],
      }
    }

    const json = (await res.json()) as {
      success: boolean
      results: Record<string, { count: number; ids: (number | string)[] }>
      errors: { entity: string; id?: number | string; message: string }[]
    }

    // Mark each successfully-synced record as isSynced=true locally.
    const syncedCounts = emptyCounts()
    for (const entityName of Object.keys(json.results) as EntityName[]) {
      const ids = json.results[entityName]?.ids ?? []
      await markSynced(entityName, ids)
      syncedCounts[entityName] = ids.length
    }

    const remainingCounts = await getPendingCounts()
    setState({
      isSyncing: false,
      pendingCounts: remainingCounts,
      lastSyncAt: new Date().toISOString(),
      lastError: json.errors.length > 0 ? `${json.errors.length} errors` : null,
    })

    return { syncedCounts, errors: json.errors }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    setState({ isSyncing: false, lastError: msg })
    return { syncedCounts: emptyCounts(), errors: [{ entity: '*', message: msg }] }
  } finally {
    // If a sync was requested while we were running, kick it off again.
    if (pendingTrigger) {
      pendingTrigger = false
      // Fire-and-forget; do NOT await to avoid stack overflow on rapid triggers.
      setTimeout(() => {
        void syncAllPending()
      }, 100)
    }
  }
}

/**
 * Schedule a background sync. Safe to call after every local write — if a sync
 * is already running, this just sets the pending flag.
 */
export function scheduleSyncAll(): void {
  if (typeof window === 'undefined') return
  if (!STATE.isOnline) {
    void refreshPendingCounts()
    return
  }
  // Don't await — fire and forget. The caller (e.g. SaleService.create)
  // doesn't need to wait for sync to complete.
  void syncAllPending().catch((e) => {
    console.warn('[SyncService] syncAllPending threw:', e)
  })
}

/**
 * Schedule a sync after a specific entity was written. Currently delegates to
 * scheduleSyncAll (we always sync everything in one batch for simplicity).
 * Kept as a separate export so callers can be explicit about intent and so
 * future versions could prioritize specific entity types.
 */
export function scheduleSync(_entity: EntityName): void {
  scheduleSyncAll()
}

// ----------------------------------------------------------------------------
// Manual sync trigger (used by the "Sync Now" button in Settings)
// ----------------------------------------------------------------------------

export async function triggerSyncNow(): Promise<void> {
  // Even if we think we're offline, give it one attempt — the user might
  // have just plugged in ethernet and navigator.onLine hasn't updated yet.
  setState({ isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true })
  await syncAllPending()
}

// ----------------------------------------------------------------------------
// PULL FROM SERVER — fetch all data from CockroachDB and merge into IndexedDB
// ----------------------------------------------------------------------------
// Used on first launch of a new device. Instead of injecting mock seed data,
// the app calls this function to pull real data from the backend.
//
// The server returns all records with their original `localId` (which was the
// creating device's Dexie ID). We store them in the local IndexedDB using that
// same `id`, so future pushes match correctly via `where: { localId }`.
//
// All pulled records are marked `isSynced: true` since they came from the
// server and don't need to be pushed back.
// ----------------------------------------------------------------------------

export interface PullResult {
  ok: boolean
  totalRecords: number
  counts: Record<EntityName, number>
  error?: string
}

export async function pullFromServer(): Promise<PullResult> {
  const counts = emptyCounts()

  if (typeof window === 'undefined') {
    return { ok: false, totalRecords: 0, counts, error: 'Server-side render' }
  }

  if (!navigator.onLine) {
    return { ok: false, totalRecords: 0, counts, error: 'Offline' }
  }

  try {
    const res = await fetch('/api/sync/pull', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return {
        ok: false,
        totalRecords: 0,
        counts,
        error: body?.error ?? `Server responded ${res.status}`,
      }
    }

    const json = (await res.json()) as {
      ok: boolean
      pulledAt: string
      totalRecords: number
      data: {
        products?: any[]
        customers?: any[]
        purchases?: any[]
        sales?: any[]
        sale_items?: any[]
        collections?: any[]
        distributor_settings?: any[]
        damages?: any[]
        purchase_returns?: any[]
        sales_returns?: any[]
      }
    }

    if (!json.ok || !json.data) {
      return { ok: false, totalRecords: 0, counts, error: 'Invalid response' }
    }

    const data = json.data

    // ---- Merge into local IndexedDB ----
    // We use `bulkPut` (not `bulkAdd`) so that if a record with the same `id`
    // already exists (e.g. from a previous partial pull), it gets overwritten
    // with the latest server data.

    if (data.products?.length) {
      await db.products.bulkPut(data.products)
      counts.products = data.products.length
    }
    if (data.customers?.length) {
      await db.customers.bulkPut(data.customers)
      counts.customers = data.customers.length
    }
    if (data.purchases?.length) {
      await db.purchases.bulkPut(data.purchases)
      counts.purchases = data.purchases.length
    }
    if (data.sales?.length) {
      await db.sales.bulkPut(data.sales)
      counts.sales = data.sales.length
    }
    if (data.sale_items?.length) {
      await db.sale_items.bulkPut(data.sale_items)
      counts.sale_items = data.sale_items.length
    }
    if (data.collections?.length) {
      await db.collections.bulkPut(data.collections)
      counts.collections = data.collections.length
    }
    if (data.distributor_settings?.length) {
      await db.distributor_settings.bulkPut(data.distributor_settings)
      counts.distributor_settings = data.distributor_settings.length
    }
    if (data.damages?.length) {
      await db.damages.bulkPut(data.damages)
      counts.damages = data.damages.length
    }
    if (data.purchase_returns?.length) {
      await db.purchase_returns.bulkPut(data.purchase_returns)
      counts.purchase_returns = data.purchase_returns.length
    }
    if (data.sales_returns?.length) {
      await db.sales_returns.bulkPut(data.sales_returns)
      counts.sales_returns = data.sales_returns.length
    }

    // ---- Mark the DB as seeded so seedIfEmpty() never runs ----
    // The pulled data IS the real data — we don't want mock data injected.
    await db.meta.put({ key: 'seeded', value: true })

    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    console.log('[pullFromServer] Pulled', total, 'records from server:', counts)

    // Update the pending counts (pulled records are isSynced=true, so counts
    // should be 0 unless there were pre-existing un-synced local records).
    await refreshPendingCounts()

    return {
      ok: true,
      totalRecords: total,
      counts,
    }
  } catch (e: any) {
    console.error('[pullFromServer] Error:', e?.message ?? e)
    return {
      ok: false,
      totalRecords: 0,
      counts,
      error: e?.message ?? String(e),
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function emptyCounts(): Record<EntityName, number> {
  return {
    products: 0,
    customers: 0,
    purchases: 0,
    sales: 0,
    sale_items: 0,
    collections: 0,
    distributor_settings: 0,
    damages: 0,
    purchase_returns: 0,
    sales_returns: 0,
  }
}
