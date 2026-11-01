'use client'

import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Printer, X } from 'lucide-react'
import { formatINR, formatNumber, formatDate } from '@/lib/utils/format'
import type { Sale, Customer } from '@/lib/db/dexie'

// ----------------------------------------------------------------------------
// Printable Daily Sales Report (DSR)
// ----------------------------------------------------------------------------
// A minimal, A4-friendly printable sheet for daily FMCG market operations.
// Shows all sales for a given date with a blank "Cash Received / Notes"
// column for manual pen writing during delivery rounds.
//
// Uses the same print-modal-root + #printable-dsr isolation pattern as
// the PrintableInvoice in SalesBill.tsx.
// ----------------------------------------------------------------------------

interface PrintableDSRProps {
  sales: Sale[]
  customers: Customer[] | undefined
  date: string
  onClose: () => void
}

export function PrintableDSR({ sales, customers, date, onClose }: PrintableDSRProps) {
  // ---- O(1) customer name lookup map ----
  // Keyed by String(c.id) so it works whether the IndexedDB id is a number
  // (Dexie auto-increment) or a BigInt-stringified value pulled from Turso.
  const customerMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of customers ?? []) {
      if (c.id != null) map.set(String(c.id), c.name)
    }
    return map
  }, [customers])

  // ---- Sort sales by invoice number for consistent DSR ordering ----
  const sortedSales = useMemo(() => {
    return [...sales].sort((a, b) =>
      a.invoice_no.localeCompare(b.invoice_no, undefined, { numeric: true })
    )
  }, [sales])

  // ---- Total bill value ----
  const totalBillValue = useMemo(() => {
    return sortedSales.reduce((sum, s) => sum + s.total_amount, 0)
  }, [sortedSales])

  const billCount = sortedSales.length

  return (
    <div className="print-modal-root no-print-bg fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-4 w-full max-w-3xl">
        {/* Action bar */}
        <div className="no-print mb-2 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="mr-1 h-4 w-4" /> Print
          </Button>
          <Button variant="ghost" onClick={onClose}>
            <X className="mr-1 h-4 w-4" /> Close
          </Button>
        </div>

        {/* ============ PRINTABLE AREA — DSR SHEET ============ */}
        <div
          id="printable-dsr"
          className="print-area memo-slip rounded-lg bg-white font-sans text-black"
          style={{ maxWidth: '190mm', padding: '8mm 10mm' }}
        >
          {/* ---------- HEADER ---------- */}
          <div className="border-b-2 border-black pb-3 text-center">
            <div className="text-2xl font-extrabold uppercase tracking-wide">
              MATRI ENTERPRISE
            </div>
            <div className="mt-0.5 text-[11px] font-semibold italic">
              Distributor Of: Too Yumm / Trsna Water
            </div>
            <div className="mt-1 text-[11px]">
              51, ELACHI CHAKRABORTYPARA ROAD, KOLKATA-700 151
            </div>
            <div className="mt-2 text-base font-bold uppercase tracking-wide underline">
              Daily Sales Report
            </div>
            <div className="mt-1 text-[12px] font-semibold">
              Date: {formatDate(date)}
            </div>
          </div>

          {/* ---------- SUMMARY STRIP ---------- */}
          <div className="mt-2 flex justify-between text-[11px] font-semibold">
            <span>Total Bills: {billCount}</span>
            <span>Total Bill Value: {formatINR(totalBillValue)}</span>
          </div>

          {/* ---------- DSR TABLE ---------- */}
          {billCount === 0 ? (
            <div className="mt-4 rounded-md border border-black p-6 text-center text-[12px] text-gray-600">
              No sales recorded for this date.
            </div>
          ) : (
            <table className="memo-table mt-2 w-full border-collapse text-[11px]">
              <thead>
                <tr className="border border-black bg-gray-100 font-bold uppercase">
                  <th className="border border-black px-2 py-1.5 text-center" style={{ width: '8%' }}>
                    Sl No
                  </th>
                  <th className="border border-black px-2 py-1.5 text-left" style={{ width: '20%' }}>
                    Bill Number
                  </th>
                  <th className="border border-black px-2 py-1.5 text-left" style={{ width: '30%' }}>
                    Customer / Shop Name
                  </th>
                  <th className="border border-black px-2 py-1.5 text-right" style={{ width: '17%' }}>
                    Bill Value (₹)
                  </th>
                  <th className="border border-black px-2 py-1.5 text-left" style={{ width: '25%' }}>
                    Cash Received / Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedSales.map((sale, idx) => {
                  // O(1) lookup — falls back to snapshot, then em-dash
                  const shopName =
                    customerMap.get(String(sale.customer_id)) ??
                    sale.customer_name ??
                    '—'
                  return (
                    <tr key={sale.id ?? idx} className="border border-black">
                      <td className="border border-black px-2 py-1 text-center font-mono">
                        {idx + 1}
                      </td>
                      <td className="border border-black px-2 py-1 font-mono font-semibold">
                        {sale.invoice_no}
                      </td>
                      <td className="border border-black px-2 py-1 font-medium">
                        {shopName}
                      </td>
                      <td className="border border-black px-2 py-1 text-right font-semibold">
                        {formatINR(sale.total_amount)}
                      </td>
                      <td className="border border-black px-2 py-1">
                        {/* Intentionally blank — for manual pen writing */}
                        &nbsp;
                      </td>
                    </tr>
                  )
                })}
                {/* Fill empty rows to fill the page for a professional look */}
                {billCount < 15 &&
                  Array.from({ length: 15 - billCount }).map((_, i) => (
                    <tr key={`empty-${i}`} className="border border-black">
                      <td className="border border-black px-2 py-1">&nbsp;</td>
                      <td className="border border-black px-2 py-1">&nbsp;</td>
                      <td className="border border-black px-2 py-1">&nbsp;</td>
                      <td className="border border-black px-2 py-1">&nbsp;</td>
                      <td className="border border-black px-2 py-1">&nbsp;</td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr className="border border-black bg-gray-100 font-extrabold">
                  <td colSpan={3} className="border border-black px-2 py-1.5 text-right">
                    TOTAL BILL VALUE
                  </td>
                  <td className="border border-black px-2 py-1.5 text-right text-[13px]">
                    {formatINR(totalBillValue)}
                  </td>
                  <td className="border border-black px-2 py-1.5">&nbsp;</td>
                </tr>
              </tfoot>
            </table>
          )}

          {/* ---------- SIGNATURE FOOTER ---------- */}
          <div className="mt-8 grid grid-cols-2 gap-8 text-[11px]">
            <div className="text-center">
              <div className="border-t border-black pt-1 font-semibold">
                Delivery Executive Signature
              </div>
            </div>
            <div className="text-center">
              <div className="border-t border-black pt-1 font-semibold">
                Distributor Signature
              </div>
            </div>
          </div>

          {/* ---------- TERMS ---------- */}
          <div className="mt-3 text-[9px] text-gray-600">
            * This is a system-generated Daily Sales Report for internal use only.
          </div>
        </div>
        {/* ============ END PRINTABLE AREA ============ */}
      </div>
    </div>
  )
}
