// ============================================================================
// Prisma client (PostgreSQL backend)
// ----------------------------------------------------------------------------
// Used by API routes under /api/sync/* to receive pushed records from the
// offline-first SyncService. The client-side ERP code NEVER imports this —
// it talks only to Dexie.js. Sync happens via HTTP POST to /api/sync/*.
//
// Resilient singleton: in development the same client is reused across
// hot-reloads to avoid exhausting DB connections.
// ============================================================================

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Get the shared PrismaClient singleton. If DATABASE_URL is not set or the
 * connection fails, callers should catch the error and return a 5xx response
 * — the offline ERP itself is unaffected because it uses Dexie.js locally.
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
