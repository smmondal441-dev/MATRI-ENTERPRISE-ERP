'use client'

import { useEffect } from 'react'
import { initNetworkListeners, refreshPendingCounts } from '@/lib/services/sync'

/**
 * SyncProvider — invisible component that initializes the offline/online
 * network listeners and triggers background sync of pending records.
 *
 * Mounted once at the root layout level so sync runs even before the
 * SyncStatusBadge component mounts (e.g. on /api routes or error pages).
 */
export function SyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Set up window.addEventListener('online', ...) + periodic 30s timer
    const cleanupNetworkListeners = initNetworkListeners()

    // Refresh pending counts on mount (so the badge renders correctly)
    void refreshPendingCounts()

    // Listen for page visibility changes — when the user returns to the tab,
    // refresh pending counts + try a background sync (cheap if nothing pending).
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshPendingCounts()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cleanupNetworkListeners()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return <>{children}</>
}
