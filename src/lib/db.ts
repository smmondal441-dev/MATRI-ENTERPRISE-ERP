// ============================================================================
// Prisma client (Turso / libSQL backend) — Foolproof Lazy Initialization
// ----------------------------------------------------------------------------
// This version is designed to be completely immune to:
//   1. Next.js Turbopack inlining "undefined" as a literal string
//   2. Stale globalThis cache from previous builds
//   3. Missing .env / .env.local files
//   4. Prisma's internal engine reading env("DATABASE_URL") from schema.prisma
//
// How it works:
//   - schema.prisma uses a hardcoded "file:./prisma-dummy.db" URL (NOT env())
//   - db.ts reads process.env at CALL TIME (not import time)
//   - Validates the URL is a real libsql:// URL before creating the adapter
//   - Uses a Proxy so existing `import { db } from '@/lib/db'` works as-is
//   - Never caches a broken client on globalThis
// ============================================================================

import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const globalForPrisma = globalThis as unknown as {
  __prismaClient: PrismaClient | undefined
}

/**
 * Extract and validate the Turso URL from environment variables.
 * Checks ALL possible sources: DATABASE_URL, TURSO_DATABASE_URL.
 * Throws a clear error if the URL is missing, is the literal string "undefined",
 * or doesn't start with libsql://, http://, or https://.
 */
function getTursoUrl(): string {
  // Check all possible env var names
  const raw = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || ''

  // Guard against Turbopack injecting the literal string "undefined"
  if (!raw || raw === 'undefined' || raw.trim() === '') {
    throw new Error(
      '[db.ts] DATABASE_URL is not set. ' +
      'Create a .env.local file with: DATABASE_URL=libsql://your-db.turso.io\n' +
      `Current process.env.DATABASE_URL = ${JSON.stringify(process.env.DATABASE_URL)}\n` +
      `Current process.env.TURSO_DATABASE_URL = ${JSON.stringify(process.env.TURSO_DATABASE_URL)}`
    )
  }

  // Validate URL format — must be a libSQL/HTTP URL, not a file: path
  if (!raw.startsWith('libsql://') && !raw.startsWith('http://') && !raw.startsWith('https://')) {
    throw new Error(
      `[db.ts] DATABASE_URL "${raw.slice(0, 80)}" is not a valid Turso URL.\n` +
      'Expected format: libsql://your-db.turso.io\n' +
      'If you see "file:..." here, your .env still has the old SQLite path. ' +
      'Update .env.local with your Turso URL.'
    )
  }

  return raw
}

/**
 * Create a PrismaClient connected to Turso via the libSQL adapter.
 * Called lazily — only when the first database query is made.
 */
function createPrismaClient(): PrismaClient {
  const url = getTursoUrl()
  const authToken = process.env.TURSO_AUTH_TOKEN

  // Guard against "undefined" string for auth token too
  const cleanAuthToken =
    authToken && authToken !== 'undefined' && authToken.trim() !== ''
      ? authToken
      : undefined

  console.log('[db.ts] ✓ Connecting to Turso:', url.replace(/:\/\/.*@/, '://***@'))

  // Create the Prisma adapter — pass the Config object directly.
  // The adapter creates the libSQL client internally with intMode: 'bigint'.
  const adapter = new PrismaLibSql({
    url,
    authToken: cleanAuthToken,
    intMode: 'bigint',
  })

  // Create PrismaClient with the adapter.
  // When using a driver adapter, Prisma does NOT allow custom datasources
  // in the constructor — the adapter handles the connection entirely.
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

  return client
}

/**
 * Get the shared PrismaClient singleton.
 * Creates it lazily on first call. Never caches a broken client.
 */
export function getDb(): PrismaClient {
  if (!globalForPrisma.__prismaClient) {
    globalForPrisma.__prismaClient = createPrismaClient()
  }
  return globalForPrisma.__prismaClient
}

/**
 * Proxy-based lazy export for backward compatibility.
 * Usage: `import { db } from '@/lib/db'` → `db.product.findMany()`
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getDb()
    const value = (client as any)[prop]
    return typeof value === 'function' ? value.bind(client) : value
  },
})
