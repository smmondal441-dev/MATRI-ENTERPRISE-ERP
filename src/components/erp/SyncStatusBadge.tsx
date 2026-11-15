'use client'

import { useEffect, useState } from 'react'
import {
  initNetworkListeners,
  onSyncStateChange,
  refreshPendingCounts,
  triggerSyncNow,
  getSyncState,
  getLastPullAt,
  type SyncState,
} from '@/lib/services/sync'
import { cn } from '@/lib/utils'
import {
  Cloud,
  CloudOff,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Download,
  Upload,
} from 'lucide-react'

/**
 * SyncStatusBadge — shows real-time online/offline + 2-way sync state.
 *
 * States:
 *  - Offline                          → red dot + "Offline"
 *  - Online, pushing                  → upload icon + "Pushing..."
 *  - Online, pulling                  → download icon + "Pulling..."
 *  - Online, all synced               → green check + "Synced"
 *  - Online, N pending                → amber icon + "N pending"
 *  - Online, last sync failed         → red alert + error tooltip
 *
 * The "Sync Now" button is ALWAYS visible (even when 0 pending) so the user
 * can manually trigger a 2-way sync (push + pull) to get the latest cloud
 * data from other devices.
 *
 * Tooltip shows lastPullAt so the user knows how fresh their data is.
 */
export function SyncStatusBadge() {
  const [state, setState] = useState<SyncState>(() => getSyncState())
  const [lastPullAt, setLastPullAt] = useState<string | null>(null)
  const [justSynced, setJustSynced] = useState(false)

  useEffect(() => {
    // Subscribe to sync state changes
    const unsubscribe = onSyncStateChange((newState) => {
      setState(newState)
      // Show a brief "Synced ✓" confirmation when a sync cycle completes
      if (newState.lastSyncAt && !newState.isSyncing) {
        setJustSynced(true)
        const timer = setTimeout(() => setJustSynced(false), 3000)
        return () => clearTimeout(timer)
      }
    })

    // Initialize network listeners (online/offline events + periodic timer)
    const cleanup = initNetworkListeners()

    // Refresh pending counts on mount
    void refreshPendingCounts()

    // Load lastPullAt from the meta table
    void getLastPullAt().then((ts) => setLastPullAt(ts))

    return () => {
      unsubscribe()
      cleanup()
    }
  }, [])

  const handleSyncNow = async () => {
    await triggerSyncNow()
    // Refresh lastPullAt after the sync completes
    void getLastPullAt().then((ts) => setLastPullAt(ts))
  }

  // ---- Format the "last pulled" tooltip ----
  const pullTooltip = lastPullAt
    ? `Last pulled: ${new Date(lastPullAt).toLocaleString()}`
    : 'Never pulled from server'

  const syncTooltip = state.lastSyncAt
    ? `Last sync: ${new Date(state.lastSyncAt).toLocaleString()}`
    : 'Never synced'

  // ---- Offline ----
  if (!state.isOnline) {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
        title="You are offline. All transactions are saved locally and will sync automatically when internet returns."
      >
        <CloudOff className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Offline</span>
        {state.totalPending > 0 && (
          <span className="rounded-full bg-red-200 px-1.5 text-[10px] font-semibold text-red-900">
            {state.totalPending}
          </span>
        )}
      </div>
    )
  }

  // ---- Pushing phase (2-way sync: phase 1) ----
  if (state.isSyncing && state.isPushing) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
        <Upload className="h-3.5 w-3.5 animate-pulse" />
        <span className="hidden sm:inline">Pushing...</span>
      </div>
    )
  }

  // ---- Pulling phase (2-way sync: phase 2) ----
  if (state.isSyncing && state.isPulling) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
        <Download className="h-3.5 w-3.5 animate-pulse" />
        <span className="hidden sm:inline">Pulling...</span>
      </div>
    )
  }

  // ---- Generic syncing (fallback, shouldn't normally hit) ----
  if (state.isSyncing) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        <span className="hidden sm:inline">Syncing...</span>
      </div>
    )
  }

  // ---- Error with pending ----
  if (state.lastError && state.totalPending > 0) {
    return (
      <div className="flex items-center gap-1.5">
        <div
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 cursor-pointer hover:bg-amber-100"
          title={`Last sync error: ${state.lastError}. Click to retry.`}
          onClick={handleSyncNow}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{state.totalPending} pending</span>
          <span className="text-[10px] underline">Retry</span>
        </div>
        <SyncButton onClick={handleSyncNow} title={pullTooltip} compact />
      </div>
    )
  }

  // ---- Pending records (synced but local edits exist) ----
  if (state.totalPending > 0) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleSyncNow}
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
          title={`${state.totalPending} pending local changes. Click to sync (push + pull). ${pullTooltip}`}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{state.totalPending} pending</span>
        </button>
      </div>
    )
  }

  // ---- All synced + just synced flash ----
  if (justSynced) {
    return (
      <div className="flex items-center gap-1.5">
        <div
          className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
          title={`${syncTooltip} · ${pullTooltip}`}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Synced ✓</span>
        </div>
        <SyncButton onClick={handleSyncNow} title={pullTooltip} compact />
      </div>
    )
  }

  // ---- All synced (default) — Sync button always visible ----
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
        title={`All records synced. ${syncTooltip} · ${pullTooltip}`}
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Synced</span>
      </div>
      <SyncButton onClick={handleSyncNow} title={`Click to sync (push + pull). ${pullTooltip}`} compact />
    </div>
  )
}

// ----------------------------------------------------------------------------
// SyncButton — a compact, always-visible button that triggers the 2-way
// sync cycle. Renders as a small icon button with a RefreshCw icon.
// ----------------------------------------------------------------------------
function SyncButton({
  onClick,
  title,
  compact,
}: {
  onClick: () => void
  title: string
  compact?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
        compact ? 'h-6 w-6' : 'h-7 w-7'
      )}
    >
      <RefreshCw className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </button>
  )
}
