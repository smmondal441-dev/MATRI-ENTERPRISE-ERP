'use client'

import { useEffect, useState } from 'react'
import {
  initNetworkListeners,
  onSyncStateChange,
  refreshPendingCounts,
  triggerSyncNow,
  getSyncState,
  type SyncState,
} from '@/lib/services/sync'
import { cn } from '@/lib/utils'
import { Cloud, CloudOff, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'

/**
 * SyncStatusBadge — shows real-time online/offline + sync state.
 *
 * States:
 *  - Offline                          → red dot + "Offline"
 *  - Online, syncing                  → spinning icon + "Syncing..."
 *  - Online, all synced               → green check + "Synced"
 *  - Online, N pending                → amber icon + "N pending"
 *  - Online, last sync failed         → red alert + error tooltip
 *
 * Also renders a small "Sync Now" button when there are pending records.
 */
export function SyncStatusBadge() {
  const [state, setState] = useState<SyncState>(() => getSyncState())

  useEffect(() => {
    // Subscribe to sync state changes
    const unsubscribe = onSyncStateChange((newState) => {
      setState(newState)
    })

    // Initialize network listeners (online/offline events + periodic timer)
    const cleanup = initNetworkListeners()

    // Refresh pending counts on mount (in case some writes happened before
    // the component mounted)
    void refreshPendingCounts()

    return () => {
      unsubscribe()
      cleanup()
    }
  }, [])

  const handleSyncNow = async () => {
    await triggerSyncNow()
  }

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

  if (state.isSyncing) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        <span className="hidden sm:inline">Syncing...</span>
      </div>
    )
  }

  if (state.lastError && state.totalPending > 0) {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 cursor-pointer hover:bg-amber-100"
        title={`Last sync error: ${state.lastError}. Click to retry.`}
        onClick={handleSyncNow}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{state.totalPending} pending</span>
        <span className="text-[10px] underline">Retry</span>
      </div>
    )
  }

  if (state.totalPending > 0) {
    return (
      <button
        onClick={handleSyncNow}
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
        title="Click to sync now"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{state.totalPending} pending</span>
      </button>
    )
  }

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
      title={`All records synced to PostgreSQL${state.lastSyncAt ? ` · Last: ${new Date(state.lastSyncAt).toLocaleTimeString()}` : ''}`}
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Synced</span>
    </div>
  )
}
