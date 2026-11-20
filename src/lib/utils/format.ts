// ============================================================================
// Number to Words (Indian system) — for invoice "Words in Rupees"
// ============================================================================

const ones = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
]

const tens = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
]

function twoDigits(n: number): string {
  if (n < 20) return ones[n]
  return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '')
}

function threeDigits(n: number): string {
  const hundred = Math.floor(n / 100)
  const rest = n % 100
  let out = ''
  if (hundred) out += ones[hundred] + ' Hundred'
  if (rest) out += (hundred ? ' ' : '') + twoDigits(rest)
  return out
}

export function amountToWords(amount: number): string {
  if (amount === 0) return 'Zero Rupees Only'
  const negative = amount < 0
  amount = Math.abs(amount)
  const rupees = Math.floor(amount)
  const paise = Math.round((amount - rupees) * 100)

  let result = ''
  let n = rupees

  const crore = Math.floor(n / 10000000)
  n %= 10000000
  const lakh = Math.floor(n / 100000)
  n %= 100000
  const thousand = Math.floor(n / 1000)
  n %= 1000
  const hundred = n

  if (crore) result += twoDigits(crore) + ' Crore '
  if (lakh) result += twoDigits(lakh) + ' Lakh '
  if (thousand) result += twoDigits(thousand) + ' Thousand '
  if (hundred) result += threeDigits(hundred)

  result = result.trim() || 'Zero'
  let out = (negative ? 'Minus ' : '') + result + ' Rupees'
  if (paise > 0) out += ' and ' + twoDigits(paise) + ' Paise'
  out += ' Only'
  return out
}

// ----------------------------------------------------------------------------
// Format currency / numbers
// ----------------------------------------------------------------------------

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount || 0)
}

export function formatNumber(amount: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(amount || 0)
}

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

// ----------------------------------------------------------------------------
// Strict date-wise sorting (global — all transaction modules)
// ----------------------------------------------------------------------------

/**
 * Normalize a business date string to a zero-padded `YYYY-MM-DD` key so that
 * plain lexicographic string comparison always matches chronological order.
 *
 * Handles:
 *   - "2026-11-5"  → "2026-11-05"  (single-digit month/day padding)
 *   - "2026-11-05T18:30:00.000Z" → "2026-11-05" (ISO timestamps clipped)
 *   - "" / undefined / garbage → "" (sorts to the oldest position)
 */
export function normalizeDateKey(d: string | undefined | null): string {
  if (!d) return ''
  const s = String(d).slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!m) return s
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

/**
 * Sort transaction rows STRICTLY by their business `date` field, descending
 * (newest first). Backdated entries (e.g. a 01-Nov entry recorded on 20-Nov)
 * automatically sit at their exact date position — never at the top just
 * because they were created last.
 *
 * Tie-breakers (only when two rows share the exact same normalized date):
 *   1. `id` descending (Dexie auto-increment — monotonic with creation order)
 *   2. `created_at` descending (fallback when ids are missing/equal)
 *
 * Non-mutating: returns a new array. Dates are normalized (YYYY-M-D →
 * YYYY-MM-DD) before comparison so unpadded legacy values sort correctly.
 */
export function sortByDateDesc<
  T extends { date?: string; id?: number; created_at?: string },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = normalizeDateKey(a.date)
    const db = normalizeDateKey(b.date)
    if (da !== db) return db.localeCompare(da) // date DESC (newest first)
    // Same date → newest created first (id DESC, then created_at DESC).
    const idDiff = (b.id ?? 0) - (a.id ?? 0)
    if (idDiff !== 0) return idDiff
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  })
}

// ----------------------------------------------------------------------------
// CSV / Excel export utilities
// ----------------------------------------------------------------------------

export function downloadCSV(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? '')
          // Escape quotes & wrap fields that contain comma / quote / newline
          if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return '"' + s.replace(/"/g, '""') + '"'
          }
          return s
        })
        .join(',')
    )
    .join('\n')

  // Prepend BOM so Excel reads UTF-8 correctly
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadJSON(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ----------------------------------------------------------------------------
// Misc helpers
// ----------------------------------------------------------------------------

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
