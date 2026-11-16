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
  isPushing: boolean
  isPulling: boolean
  pendingCounts: Record<EntityName, number>
  totalPending: number
  lastSyncAt: string | null
  lastPullAt: string | null
  lastError: string | null
  // Detailed per-record error messages from the last push attempt — so the
  // Settings UI can show exactly WHICH records failed and WHY, instead of
  // just "2 errors". Each entry: { entity, id?, message }.
  lastSyncErrors: { entity: string; id?: number | string; message: string }[]
}

type SyncStateListener = (state: SyncState) => void

// ----------------------------------------------------------------------------
// Internal state
// ----------------------------------------------------------------------------

const STATE: SyncState = {
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  isSyncing: false,
  isPushing: false,
  isPulling: false,
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
  lastPullAt: null,
  lastError: null,
  lastSyncErrors: [],
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
    // AND normalize all date fields defensively before pushing (Change 2):
    //   - Business dates (date, mfg_date, expiry_date) → YYYY-MM-DD via slice(0,10)
    //     so a stray ISO timestamp doesn't shift the calendar day in IST.
    //   - created_at → re-stamped via new Date(...).toISOString() so the
    //     server's Prisma layer always receives a UTC 'Z' string.
    const cleanBatches: Record<string, any[]> = {}
    for (const k of Object.keys(batches) as EntityName[]) {
      cleanBatches[k] = batches[k].map(
        ({ isSynced, synced_at, ...rest }: any) => {
          // Business dates — slice to YYYY-MM-DD
          if (rest.date !== undefined && rest.date !== null && rest.date !== '') {
            rest.date = String(rest.date).slice(0, 10)
          }
          if (
            rest.mfg_date !== undefined &&
            rest.mfg_date !== null &&
            rest.mfg_date !== ''
          ) {
            rest.mfg_date = String(rest.mfg_date).slice(0, 10)
          }
          if (
            rest.expiry_date !== undefined &&
            rest.expiry_date !== null &&
            rest.expiry_date !== ''
          ) {
            rest.expiry_date = String(rest.expiry_date).slice(0, 10)
          }
          // created_at — enforce ISO-8601 UTC 'Z'
          if (
            rest.created_at !== undefined &&
            rest.created_at !== null &&
            rest.created_at !== ''
          ) {
            const d = new Date(rest.created_at)
            if (!isNaN(d.getTime())) {
              rest.created_at = d.toISOString()
            }
          }
          return rest
        }
      )
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
    // Store detailed error messages (not just a count) so the Settings UI
    // can show exactly WHICH records failed and WHY. This makes the "stuck
    // record" problem self-diagnosing — the user sees "products[123]:
    // column 'is_deleted' does not exist" instead of just "1 errors".
    const errorMessages = json.errors.map((e) => ({
      entity: e.entity,
      id: e.id,
      message: (e.message ?? 'unknown error').slice(0, 200),
    }))
    const errorSummary =
      errorMessages.length > 0
        ? errorMessages
            .map((e) => `${e.entity}[${e.id ?? '?'}]: ${e.message.slice(0, 80)}`)
            .join('; ')
        : null
    setState({
      isSyncing: false,
      pendingCounts: remainingCounts,
      lastSyncAt: new Date().toISOString(),
      lastError: errorSummary,
      lastSyncErrors: errorMessages,
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

  // ---- 2-Way Sync cycle: PUSH first, then PULL ----
  // 1. Push: upload all local isSynced=false rows to Turso.
  // 2. Pull: download all Turso rows, filtering out local-unsynced rows
  //    so we don't overwrite edits that haven't been pushed yet.
  // 3. Refresh pending counts.
  //
  // Order matters: push FIRST so that when we pull, the server has our
  // latest changes. If we pulled first, we might overwrite a local unsynced
  // edit with an older server version (the conflict-protection filter
  // handles this, but pushing first is still the cleaner sequence).

  // Phase 1: PUSH
  setState({ isSyncing: true, isPushing: true, lastError: null })
  try {
    await syncAllPending()
  } catch (e: any) {
    console.warn('[triggerSyncNow] Push phase failed:', e?.message ?? e)
    // Don't return — still try to pull so the user gets fresh data even if
    // their local edits couldn't be pushed (e.g. server 500 on one record).
  }

  // Phase 2: PULL
  setState({ isPushing: false, isPulling: true })
  try {
    const pullResult = await pullFromServer()
    if (pullResult.ok) {
      // Store lastPullAt in the meta table so it survives page refresh.
      const now = new Date().toISOString()
      try {
        await db.meta.put({ key: 'lastPullAt', value: now })
      } catch {
        // meta table write failed — non-fatal, the in-memory state still updates
      }
      setState({ lastPullAt: now })
      console.log(
        `[triggerSyncNow] Pull complete: ${pullResult.totalRecords} records`,
      )
    } else if (pullResult.error) {
      console.warn('[triggerSyncNow] Pull phase failed:', pullResult.error)
    }
  } catch (e: any) {
    console.warn('[triggerSyncNow] Pull phase error:', e?.message ?? e)
  }

  // Phase 3: refresh + done
  await refreshPendingCounts()
  setState({
    isSyncing: false,
    isPushing: false,
    isPulling: false,
    lastSyncAt: new Date().toISOString(),
  })
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
  // Upgrade: surface schema-sync warnings so the boot sequence / Settings
  // page can tell the user "your Turso DB is missing columns — run
  // `npm run db:push-turso`" instead of silently showing partial data.
  needsSchemaSync?: boolean
  failedTables?: { table: string; error?: string }[]
  // Tables that Prisma couldn't query but the raw-SQL fallback recovered.
  // The user should still run `db:push-turso --cleanup-only` to fix the
  // underlying legacy rows so Prisma succeeds next time.
  recoveredTables?: string[]
  tableCounts?: Record<string, number>
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
      // New diagnostic fields from the upgraded pull route:
      tableCounts?: Record<string, number>
      failedTables?: { table: string; error?: string }[]
      recoveredTables?: string[]
      needsSchemaSync?: boolean
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

    // ---- Conflict protection: don't overwrite unsynced local edits ----
    // Before bulkPut, load local rows that have isSynced !== true (i.e. they
    // have local edits that haven't been pushed yet). Build a Set of their IDs
    // so we can EXCLUDE them from the pulled data. This implements the
    // "last-write-wins with local-unsynced-protection" strategy:
    //   - Server rows that are NEW (not in local DB) → inserted (safe).
    //   - Server rows that match a local SYNCED row → overwritten (safe — already pushed).
    //   - Server rows that match a local UNSYNCED row → SKIPPED (local edit wins).
    //
    // After the pull, the user's unsynced edits remain intact and will be
    // pushed on the next sync cycle, at which point the server gets the latest.

    // Build the unsynced-ID set for each table.
    const localProducts = await db.products.toArray()
    const unsyncedProductIds = new Set(
      localProducts
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localCustomers = await db.customers.toArray()
    const unsyncedCustomerIds = new Set(
      localCustomers
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localPurchases = await db.purchases.toArray()
    const unsyncedPurchaseIds = new Set(
      localPurchases
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localSales = await db.sales.toArray()
    const unsyncedSaleIds = new Set(
      localSales
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localSaleItems = await db.sale_items.toArray()
    const unsyncedSaleItemIds = new Set(
      localSaleItems
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localCollections = await db.collections.toArray()
    const unsyncedCollectionIds = new Set(
      localCollections
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localSettings = await db.distributor_settings.toArray()
    const unsyncedSettingIds = new Set(
      localSettings
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localDamages = await db.damages.toArray()
    const unsyncedDamageIds = new Set(
      localDamages
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localPurchaseReturns = await db.purchase_returns.toArray()
    const unsyncedPurchaseReturnIds = new Set(
      localPurchaseReturns
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )
    const localSalesReturns = await db.sales_returns.toArray()
    const unsyncedSalesReturnIds = new Set(
      localSalesReturns
        .filter((r) => r.isSynced !== true && r.id != null)
        .map((r) => String(r.id))
    )

    // Helper: filter out rows whose id is in the unsynced set.
    // Also logs how many rows were skipped so the user knows.
    function filterProtected(
      rows: any[] | undefined,
      unsyncedIds: Set<string>,
      tableName: string
    ): any[] {
      if (!rows || rows.length === 0) return []
      const safe = rows.filter((r) => {
        const rid = String(r.id ?? '')
        return !unsyncedIds.has(rid)
      })
      const skipped = rows.length - safe.length
      if (skipped > 0) {
        console.log(
          `[pullFromServer] ${tableName}: skipped ${skipped} row(s) with unsynced local edits (protected from overwrite)`
        )
      }
      return safe
    }

    // ---- Merge into local IndexedDB (filtered) ----
    // We use `bulkPut` (not `bulkAdd`) so that if a record with the same `id`
    // already exists (e.g. from a previous partial pull), it gets overwritten
    // with the latest server data — but ONLY if it's not in the unsynced set.

    const safeProducts = filterProtected(data.products, unsyncedProductIds, 'products')
    const safeCustomers = filterProtected(data.customers, unsyncedCustomerIds, 'customers')
    const safePurchases = filterProtected(data.purchases, unsyncedPurchaseIds, 'purchases')
    const safeSales = filterProtected(data.sales, unsyncedSaleIds, 'sales')
    const safeSaleItems = filterProtected(data.sale_items, unsyncedSaleItemIds, 'sale_items')
    const safeCollections = filterProtected(data.collections, unsyncedCollectionIds, 'collections')
    const safeSettings = filterProtected(data.distributor_settings, unsyncedSettingIds, 'distributor_settings')
    const safeDamages = filterProtected(data.damages, unsyncedDamageIds, 'damages')
    const safePurchaseReturns = filterProtected(data.purchase_returns, unsyncedPurchaseReturnIds, 'purchase_returns')
    const safeSalesReturns = filterProtected(data.sales_returns, unsyncedSalesReturnIds, 'sales_returns')

    if (safeProducts.length) {
      await db.products.bulkPut(safeProducts)
      counts.products = safeProducts.length
    }
    if (safeCustomers.length) {
      await db.customers.bulkPut(safeCustomers)
      counts.customers = safeCustomers.length
    }
    if (safePurchases.length) {
      await db.purchases.bulkPut(safePurchases)
      counts.purchases = safePurchases.length
    }
    if (safeSales.length) {
      await db.sales.bulkPut(safeSales)
      counts.sales = safeSales.length
    }
    if (safeSaleItems.length) {
      await db.sale_items.bulkPut(safeSaleItems)
      counts.sale_items = safeSaleItems.length
    }
    if (safeCollections.length) {
      await db.collections.bulkPut(safeCollections)
      counts.collections = safeCollections.length
    }
    if (safeSettings.length) {
      await db.distributor_settings.bulkPut(safeSettings)
      counts.distributor_settings = safeSettings.length
    }
    if (safeDamages.length) {
      await db.damages.bulkPut(safeDamages)
      counts.damages = safeDamages.length
    }
    if (safePurchaseReturns.length) {
      await db.purchase_returns.bulkPut(safePurchaseReturns)
      counts.purchase_returns = safePurchaseReturns.length
    }
    if (safeSalesReturns.length) {
      await db.sales_returns.bulkPut(safeSalesReturns)
      counts.sales_returns = safeSalesReturns.length
    }

    // ---- Mark the DB as seeded so seedIfEmpty() never runs ----
    // The pulled data IS the real data — we don't want mock data injected.
    await db.meta.put({ key: 'seeded', value: true })

    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    console.log('[pullFromServer] Pulled', total, 'records from server:', counts)

    // ---- Surface schema-sync warnings ----
    // If the server reported any failed tables (P2022 / missing columns),
    // log a clear, actionable warning so the user knows the partial pull is
    // NOT because the server is empty — it's because the schema is out of sync.
    if (json.needsSchemaSync && json.failedTables && json.failedTables.length > 0) {
      console.error(
        '[pullFromServer] ⚠️  PARTIAL PULL — ' +
          json.failedTables.length +
          ' table(s) failed due to schema mismatch:'
      )
      for (const f of json.failedTables) {
        console.error(
          `[pullFromServer]   ✗ ${f.table}: ${f.error?.slice(0, 120) ?? 'unknown error'}`
        )
      }
      console.error(
        '[pullFromServer] 🔧 FIX: Run `npm run db:push-turso` on the server ' +
          'to sync the Turso schema, then refresh this page to pull again.'
      )
      console.error(
        '[pullFromServer] Per-table counts:',
        json.tableCounts
      )
    }
    // ---- Surface raw-SQL recovery warnings ----
    // Even if needsSchemaSync is false, some tables may have been recovered
    // via the raw-SQL fallback (Prisma choked on legacy rows but raw SELECT *
    // got them). The user should run `db:push-turso --cleanup-only` to fix
    // the underlying rows so Prisma succeeds next time.
    if (json.recoveredTables && json.recoveredTables.length > 0) {
      console.warn(
        '[pullFromServer] ⚠️  ' +
          json.recoveredTables.length +
          ' table(s) recovered via raw SQL fallback (Prisma findMany() failed ' +
          'on legacy rows but raw SELECT * succeeded): '
      )
      for (const t of json.recoveredTables) {
        console.warn(`[pullFromServer]   ⚠️  ${t}`)
      }
      console.warn(
        '[pullFromServer] 🔧 FIX: Run `npm run db:cleanup-turso` on the server ' +
          'to normalize timestamps + fill NULLs so Prisma succeeds next time.'
      )
    }

    // Update the pending counts (pulled records are isSynced=true, so counts
    // should be 0 unless there were pre-existing un-synced local records).
    await refreshPendingCounts()

    return {
      ok: true,
      totalRecords: total,
      counts,
      // Carry the diagnostic fields up to the caller (boot sequence /
      // Settings page) so they can surface a user-facing warning.
      needsSchemaSync: json.needsSchemaSync,
      failedTables: json.failedTables,
      recoveredTables: json.recoveredTables,
      tableCounts: json.tableCounts,
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

/**
 * Read the lastPullAt timestamp from the meta table. Used by the boot
 * sequence to decide whether to re-pull on reopen (if stale > 5 min).
 * Returns null if never pulled.
 */
export async function getLastPullAt(): Promise<string | null> {
  try {
    const row = await db.meta.get('lastPullAt')
    return (row?.value as string) ?? null
  } catch {
    return null
  }
}

/**
 * Check if the local data is "stale" — i.e. the last pull was more than
 * `maxAgeMs` ago (default 5 minutes). Used by the boot sequence to decide
 * whether to trigger a background pull when the app reopens.
 */
export async function isDataStale(maxAgeMs: number = 5 * 60 * 1000): Promise<boolean> {
  const lastPull = await getLastPullAt()
  if (!lastPull) return true // never pulled → stale
  const age = Date.now() - new Date(lastPull).getTime()
  return age > maxAgeMs
}

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
