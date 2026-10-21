'use client'

import { useState, useMemo, useEffect } from 'react'
import { useProducts, useCustomers, useSettings } from '@/lib/hooks/use-erp'
import {
  SaleService,
  getPurchaseRatePerPiece,
  getSellingRatePerPiece,
  getProfitPerPiece,
  type SaleDraft,
  type SaleDraftItem,
} from '@/lib/services/repository'
import {
  formatINR,
  formatNumber,
  amountToWords,
  todayISO,
  formatDate,
} from '@/lib/utils/format'
import { PageHeader } from '@/components/erp/EmptyState'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import {
  Plus,
  Trash2,
  Printer,
  Receipt,
  Save,
  RotateCcw,
  X,
  Percent,
} from 'lucide-react'
import type { Product, Sale, Customer } from '@/lib/db/dexie'

interface CartLine {
  uid: string
  product: Product
  qtyPcs: number
}

export function SalesBill() {
  const products = useProducts()
  const customers = useCustomers()
  const settings = useSettings()
  const { toast } = useToast()

  const [invoiceNo, setInvoiceNo] = useState('')
  const [date, setDate] = useState(todayISO())
  const [customerId, setCustomerId] = useState<string>('')
  const [paymentMode, setPaymentMode] = useState<'Cash' | 'Credit'>('Cash')
  const [cart, setCart] = useState<CartLine[]>([])
  const [lastSavedSale, setLastSavedSale] = useState<
    | { sale: Sale; items: SaleDraftItem[] }
    | null
  >(null)
  const [printOpen, setPrintOpen] = useState(false)

  // v6 — Manual GST control.
  // applyGst=false → CGST & SGST = 0, Grand Total = Subtotal.
  // When true, the per-item gst_percent from the Product Master is used by
  // default; the user can override it with `customGstPercent` (applies to all
  // items uniformly). Leave `customGstPercent` empty to use per-product rates.
  const [applyGst, setApplyGst] = useState(true)
  const [useCustomGstPercent, setUseCustomGstPercent] = useState(false)
  const [customGstPercent, setCustomGstPercent] = useState<number>(5)

  // Generate next invoice number on load
  useEffect(() => {
    ;(async () => {
      if (!invoiceNo) {
        const next = await SaleService.nextInvoiceNo(settings?.invoice_prefix || 'INV')
        setInvoiceNo(next)
      }
    })()
  }, [settings, invoiceNo])

  const customer = (customers ?? []).find((c) => String(c.id) === customerId)

  // Per-item live computation — v4 per-piece pricing model + v6 manual GST.
  const computedItems: SaleDraftItem[] = useMemo(() => {
    return cart.map((line) => {
      const p = line.product
      const sellingRatePerPiece = getSellingRatePerPiece(p)
      const purchaseRatePerPiece = getPurchaseRatePerPiece(p)
      const profitPerPiece = sellingRatePerPiece - purchaseRatePerPiece
      const taxable = sellingRatePerPiece * line.qtyPcs

      // v6 — GST resolution per line item:
      //   - If applyGst is false → gst_percent = 0, CGST = 0, SGST = 0
      //   - Else if useCustomGstPercent is true → use the global override
      //   - Else → use the product's own gst_percent
      let lineGstPercent = 0
      if (applyGst) {
        lineGstPercent = useCustomGstPercent
          ? Number(customGstPercent) || 0
          : p.gst_percent
      }
      const cgst = (taxable * (lineGstPercent / 2)) / 100
      const sgst = (taxable * (lineGstPercent / 2)) / 100
      const total = taxable + cgst + sgst

      const itemProfit = profitPerPiece * line.qtyPcs
      const margin = total > 0 ? (itemProfit / total) * 100 : 0
      return {
        product_id: p.id!,
        product_name: p.name,
        product_sku: p.sku,
        hsn_code: p.hsn_code,
        quantity_pcs: line.qtyPcs,
        rate: sellingRatePerPiece,
        gst_percent: lineGstPercent,
        taxable_amount: taxable,
        cgst,
        sgst,
        total,
        purchase_rate: purchaseRatePerPiece,
        item_profit: itemProfit,
        item_margin_percent: margin,
      }
    })
  }, [cart, applyGst, useCustomGstPercent, customGstPercent])

  const totals = useMemo(() => {
    const subtotal = computedItems.reduce((s, i) => s + i.taxable_amount, 0)
    const cgst = computedItems.reduce((s, i) => s + i.cgst, 0)
    const sgst = computedItems.reduce((s, i) => s + i.sgst, 0)
    const total = computedItems.reduce((s, i) => s + i.total, 0)
    const profit = computedItems.reduce((s, i) => s + i.item_profit, 0)
    const qty = computedItems.reduce((s, i) => s + i.quantity_pcs, 0)
    const margin = total > 0 ? (profit / total) * 100 : 0
    return { subtotal, cgst, sgst, total, profit, margin, qty }
  }, [computedItems])

  const addProductToCart = (productId: string) => {
    const prod = (products ?? []).find((p) => String(p.id) === productId)
    if (!prod) return
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === prod.id)
      if (existing) {
        return prev.map((l) =>
          l.product.id === prod.id ? { ...l, qtyPcs: l.qtyPcs + 1 } : l
        )
      }
      return [
        ...prev,
        { uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), product: prod, qtyPcs: 1 },
      ]
    })
  }

  const updateQty = (uid: string, qty: number) => {
    setCart((prev) =>
      prev.map((l) => (l.uid === uid ? { ...l, qtyPcs: Math.max(0, qty) } : l))
    )
  }

  const removeLine = (uid: string) => {
    setCart((prev) => prev.filter((l) => l.uid !== uid))
  }

  const resetForm = async () => {
    setCart([])
    setCustomerId('')
    setPaymentMode('Cash')
    setDate(todayISO())
    setApplyGst(true)
    setUseCustomGstPercent(false)
    setCustomGstPercent(5)
    const next = await SaleService.nextInvoiceNo(settings?.invoice_prefix || 'INV')
    setInvoiceNo(next)
  }

  const saveAndPrint = async () => {
    if (!customer) {
      toast({
        title: 'Customer required',
        description: 'Select a customer before saving the bill.',
        variant: 'destructive',
      })
      return
    }
    if (cart.length === 0) {
      toast({
        title: 'Empty cart',
        description: 'Add at least one product.',
        variant: 'destructive',
      })
      return
    }
    try {
      const draft: SaleDraft = {
        invoice_no: invoiceNo,
        date,
        customer_id: customer.id!,
        customer_name: customer.name,
        payment_mode: paymentMode,
        subtotal: totals.subtotal,
        cgst: totals.cgst,
        sgst: totals.sgst,
        total_amount: totals.total,
        total_profit: totals.profit,
        total_margin_percent: totals.margin,
        items: computedItems,
      }
      const saleId = await SaleService.create(draft)
      const saved = await SaleService.get(saleId)
      if (saved) {
        setLastSavedSale({
          sale: saved.sale,
          items: draft.items,
        })
        setPrintOpen(true)
        toast({
          title: 'Bill saved & printed',
          description: `${invoiceNo} · ${formatINR(totals.total)}`,
        })
        // Reset & prep next invoice
        await resetForm()
      }
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sales Bill (POS / Billing)"
        description="Add products to cart, see live profit & GST, then save & print invoice."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: form + items */}
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Invoice No">
                  <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="font-mono text-xs" />
                </Field>
                <Field label="Date">
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Field label="Customer *" className="sm:col-span-2">
                  <Select value={customerId} onValueChange={setCustomerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {(customers ?? []).map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.customer_id} · {c.name} ({c.route_area})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="mt-3">
                <Field label="Add Product to Cart">
                  <Select value="" onValueChange={addProductToCart}>
                    <SelectTrigger>
                      <SelectValue placeholder="Search & select product to add to bill" />
                    </SelectTrigger>
                    <SelectContent>
                      {(products ?? []).map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.sku} · {p.name} — Sell {formatINR(getSellingRatePerPiece(p))}/Pcs · Margin {formatINR(getProfitPerPiece(p))}/Pcs
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Bill Items</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {cart.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  <Receipt className="mx-auto mb-2 h-8 w-8 opacity-40" />
                  Cart is empty. Add products above to start billing.
                </div>
              ) : (
                <div className="scrollbar-thin overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Qty (Pcs)</TableHead>
                        <TableHead className="text-right">Sell/Pcs</TableHead>
                        <TableHead className="text-right">Buy/Pcs</TableHead>
                        <TableHead className="text-right">Profit/Pcs</TableHead>
                        <TableHead className="text-right">GST%</TableHead>
                        <TableHead className="text-right">Taxable</TableHead>
                        <TableHead className="text-right">CGST</TableHead>
                        <TableHead className="text-right">SGST</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Line Profit</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {computedItems.map((item, idx) => {
                        const line = cart[idx]
                        const profitPerPcs = item.rate - item.purchase_rate
                        return (
                          <TableRow key={line.uid}>
                            <TableCell>
                              <div className="text-sm font-medium">{item.product_name}</div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {item.product_sku} · HSN {item.hsn_code}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                value={line.qtyPcs}
                                onChange={(e) => updateQty(line.uid, Number(e.target.value))}
                                className="h-8 w-20 text-right text-xs"
                              />
                            </TableCell>
                            <TableCell className="text-right text-xs font-medium">
                              {formatINR(item.rate)}
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              {formatINR(item.purchase_rate)}
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              <span className={profitPerPcs >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>
                                {formatINR(profitPerPcs)}
                              </span>
                              <div className="text-[10px] text-muted-foreground">
                                × {line.qtyPcs} Pcs
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              {item.gst_percent > 0 ? `${item.gst_percent}%` : '—'}
                            </TableCell>
                            <TableCell className="text-right text-xs">{formatINR(item.taxable_amount)}</TableCell>
                            <TableCell className="text-right text-xs">{item.cgst > 0 ? formatINR(item.cgst) : '—'}</TableCell>
                            <TableCell className="text-right text-xs">{item.sgst > 0 ? formatINR(item.sgst) : '—'}</TableCell>
                            <TableCell className="text-right text-xs font-semibold">{formatINR(item.total)}</TableCell>
                            <TableCell className="text-right text-xs">
                              <span className={item.item_profit >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                {formatINR(item.item_profit)}
                              </span>
                              <div className="text-[10px] text-muted-foreground">
                                {formatNumber(item.item_margin_percent, 1)}%
                              </div>
                            </TableCell>
                            <TableCell>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(line.uid)}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: summary */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Payment Mode</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={paymentMode} onValueChange={(v: 'Cash' | 'Credit') => setPaymentMode(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="Credit">Credit (Due)</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* v6 — Manual GST Control */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Percent className="h-4 w-4" /> GST Control
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">Apply GST</div>
                  <div className="text-[11px] text-muted-foreground">
                    {applyGst
                      ? 'GST enabled — CGST + SGST calculated per item.'
                      : 'GST disabled — Grand Total = Subtotal, CGST/SGST = ₹0.'}
                  </div>
                </div>
                <Switch checked={applyGst} onCheckedChange={setApplyGst} />
              </div>

              {applyGst && (
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        Custom GST % (all items)
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Override per-product GST with one rate for the whole bill.
                      </div>
                    </div>
                    <Switch
                      checked={useCustomGstPercent}
                      onCheckedChange={setUseCustomGstPercent}
                    />
                  </div>
                  {useCustomGstPercent && (
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step="0.5"
                        value={customGstPercent}
                        onChange={(e) => setCustomGstPercent(Number(e.target.value))}
                        className="h-8 w-24 text-right text-xs"
                      />
                      <span className="text-xs text-muted-foreground">% GST</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        Splits as CGST {formatNumber(customGstPercent / 2, 2)}% + SGST{' '}
                        {formatNumber(customGstPercent / 2, 2)}%
                      </span>
                    </div>
                  )}
                  {!useCustomGstPercent && (
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Using per-product GST rates from the Product Master.
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Bill Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Subtotal (Taxable)" value={formatINR(totals.subtotal)} />
              <Row
                label="CGST"
                value={applyGst ? formatINR(totals.cgst) : '₹0.00 (GST off)'}
              />
              <Row
                label="SGST"
                value={applyGst ? formatINR(totals.sgst) : '₹0.00 (GST off)'}
              />
              <div className="border-t border-border pt-2" />
              <Row label="Grand Total" value={formatINR(totals.total)} bold />
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">In Words:</span>{' '}
                {amountToWords(totals.total)}
              </div>
              <div className="border-t border-border pt-2" />
              <Row
                label="Total Profit"
                value={
                  <span className={totals.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                    {formatINR(totals.profit)}
                  </span>
                }
              />
              <Row
                label="Avg Profit / Pcs"
                value={
                  <span className={totals.qty > 0 ? 'text-emerald-700' : 'text-muted-foreground'}>
                    {formatINR(totals.qty > 0 ? totals.profit / totals.qty : 0)}
                  </span>
                }
              />
              <Row label="Overall Margin" value={`${formatNumber(totals.margin, 2)}%`} />
              <Row label="Items" value={String(cart.length)} />
              <Row label="Total Pcs" value={String(totals.qty)} />
            </CardContent>
          </Card>

          <div className="flex flex-col gap-2">
            <Button onClick={saveAndPrint} size="lg" className="w-full">
              <Save className="mr-2 h-4 w-4" /> Save &amp; Print Invoice
            </Button>
            <Button variant="outline" onClick={resetForm}>
              <RotateCcw className="mr-1 h-4 w-4" /> Reset Form
            </Button>
          </div>

          {lastSavedSale && (
            <Button variant="secondary" className="w-full" onClick={() => setPrintOpen(true)}>
              <Printer className="mr-1 h-4 w-4" /> Reprint {lastSavedSale.sale.invoice_no}
            </Button>
          )}
        </div>
      </div>

      {printOpen && lastSavedSale && (
        <PrintableInvoice
          sale={lastSavedSale.sale}
          items={lastSavedSale.items}
          store={settings}
          customer={customer}
          onClose={() => setPrintOpen(false)}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Printable Invoice — Compact A5 Memo / Tax Invoice Slip
// ----------------------------------------------------------------------------
// Hardcoded for MATRI ENTERPRISE distributor bills.
// Prints cleanly on A5 portrait (148 × 210 mm), 80mm thermal roll, or
// two-up side-by-side on a single A4 sheet.
//
// Layout (compact, fits ~12-15 line items per slip):
//   1. Header  → Bold "TAX INVOICE" + large centered store name (hardcoded)
//                + subtitle (hardcoded) + address + GSTIN + Mobile
//   2. Bill Info → Party Name & Address, Party GST, Invoice No, Date
//   3. Items Table → DESCRIPTION OF GOODS | HSN | Qnty | Rate | AMOUNT
//   4. Bottom Calc → Total Amount, Add CGST %, Add SGST %, Grand Total,
//                    "Rupees in words".
//   5. Footer  → Bank Details (bottom-left, hardcoded with A/c Name)
//                + "For, MATRI ENTERPRISE - Authorised Signatory" (bottom-right)
//
// All store branding is HARDCODED — does not depend on Settings (so the
// printed bill is always consistent regardless of DB state).
// ----------------------------------------------------------------------------

interface PrintableProps {
  sale: Sale
  items: SaleDraftItem[]
  store: ReturnType<typeof useSettings>
  customer: Customer | undefined
  onClose: () => void
}

// Hardcoded store branding — the printed memo always shows these exact values.
const STORE_NAME = 'MATRI ENTERPRISE'
const STORE_SUBTITLE = 'Distributor Of: Too Yumm / Trsna Water'
const STORE_ADDRESS = '51, ELACHI CHAKRABORTYPARA ROAD, KOLKATA-700 151'
const STORE_GSTIN = '19DSFPM8845F1Z8'
const STORE_MOBILE = '8777746395 / 9874532121'
const BANK_DETAILS =
  'Bank: Bandhan Bank, Rajpur Branch | A/c Name: MATRI ENTERPRISE, A/c No: 20100077079708 | IFSC: BDBL0001028'

function PrintableInvoice({ sale, items, store: _store, customer, onClose }: PrintableProps) {
  // store is intentionally unused — all branding is hardcoded above.
  void _store

  const partyName = customer?.name ?? sale.customer_name
  const partyAddress = customer?.route_area || ''
  const partyGstin = customer?.gstin || ''

  // v6 — Detect whether GST was actually applied for this sale.
  // GST is considered "off" if every line item has gst_percent = 0 (which the
  // POS sets when the user disables the Apply GST switch). In that case we
  // show the CGST/SGST rows as "— @ 0%" and Grand Total equals Total Amount.
  const anyGstApplied = items.some((it) => it.gst_percent > 0)
  // Use the first item's gst_percent as the displayed rate (uniform across the
  // bill when "Custom GST %" was used; otherwise reflects the per-product rate
  // of the first line — close enough for the slip header).
  const gstPercentForDisplay = items[0]?.gst_percent ?? 0
  const gstHalfPct = gstPercentForDisplay / 2

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

        {/* ============ PRINTABLE AREA — A5 MEMO SLIP ============ */}
        {/* max-width: 148mm = A5 width. Compact padding + small fonts. */}
        <div
          id="printable-invoice"
          className="print-area memo-slip rounded-lg bg-white font-sans text-black"
          style={{ maxWidth: '148mm', padding: '6mm 8mm' }}
        >
          {/* ---------- 1. HEADER ---------- */}
          <div className="border-b-2 border-black pb-2 text-center">
            <div className="text-[10px] font-bold uppercase tracking-[0.3em]">
              TAX INVOICE
            </div>
            <div className="mt-0.5 text-2xl font-extrabold uppercase tracking-wide leading-tight">
              {STORE_NAME}
            </div>
            <div className="mt-0.5 text-[11px] font-semibold italic">
              {STORE_SUBTITLE}
            </div>
            <div className="mt-1 text-[10px] font-medium leading-tight">
              {STORE_ADDRESS}
            </div>
            <div className="mt-0.5 text-[10px] leading-tight">
              <span className="font-semibold">GSTIN:</span>{' '}
              <span className="font-mono">{STORE_GSTIN}</span>
              <span className="mx-2">·</span>
              <span className="font-semibold">Mobile:</span> {STORE_MOBILE}
            </div>
          </div>

          {/* ---------- 2. BILL INFO (Party + Invoice meta) ---------- */}
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
            <div className="border border-black p-1.5">
              <div className="font-semibold uppercase tracking-wide">
                Party Name &amp; Address:
              </div>
              <div className="font-semibold leading-tight">{partyName}</div>
              {partyAddress && <div className="leading-tight">{partyAddress}</div>}
              <div className="mt-0.5">
                <span className="font-semibold">Party GST No:</span>{' '}
                <span className="font-mono">{partyGstin || '—'}</span>
              </div>
            </div>
            <div className="border border-black p-1.5 text-right">
              <div className="leading-tight">
                <span className="font-semibold">Invoice No:</span>{' '}
                <span className="font-mono font-bold">{sale.invoice_no}</span>
              </div>
              <div className="leading-tight">
                <span className="font-semibold">Date:</span>{' '}
                <span className="font-medium">{formatDate(sale.date)}</span>
              </div>
              <div className="mt-0.5 leading-tight">
                <span className="font-semibold">Mode:</span>{' '}
                <span className="font-medium">{sale.payment_mode}</span>
              </div>
            </div>
          </div>

          {/* ---------- 3. ITEMS TABLE ---------- */}
          <table className="memo-table mt-2 w-full border-collapse text-[9.5px]">
            <thead>
              <tr className="border border-black bg-gray-100 font-bold uppercase">
                <th className="border border-black px-1.5 py-1 text-left">
                  DESCRIPTION OF GOODS
                </th>
                <th className="border border-black px-1.5 py-1 text-center">HSN</th>
                <th className="border border-black px-1.5 py-1 text-right">Qnty</th>
                <th className="border border-black px-1.5 py-1 text-right">Rate</th>
                <th className="border border-black px-1.5 py-1 text-right">AMOUNT</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border border-black">
                  <td className="border border-black px-1.5 py-0.5">
                    <div className="font-medium leading-tight">{it.product_name}</div>
                    <div className="font-mono text-[8px] text-gray-700 leading-tight">
                      {it.product_sku}
                    </div>
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-center font-mono leading-tight">
                    {it.hsn_code}
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-right leading-tight">
                    {formatNumber(it.quantity_pcs, 0)}
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-right leading-tight">
                    {formatINR(it.rate)}
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-right font-medium leading-tight">
                    {formatINR(it.taxable_amount)}
                  </td>
                </tr>
              ))}
              {/* Fill empty rows for visual continuity on short invoices
                  (helps the slip look balanced on A5). */}
              {items.length < 8 &&
                Array.from({ length: 8 - items.length }).map((_, i) => (
                  <tr key={`empty-${i}`} className="border border-black">
                    <td className="border border-black px-1.5 py-0.5">&nbsp;</td>
                    <td className="border border-black px-1.5 py-0.5">&nbsp;</td>
                    <td className="border border-black px-1.5 py-0.5">&nbsp;</td>
                    <td className="border border-black px-1.5 py-0.5">&nbsp;</td>
                    <td className="border border-black px-1.5 py-0.5">&nbsp;</td>
                  </tr>
                ))}
            </tbody>
          </table>

          {/* ---------- 4. BOTTOM CALCULATION GRID ---------- */}
          <div className="mt-2 flex justify-end">
            <table className="memo-table w-3/5 border-collapse text-[10px]">
              <tbody>
                <tr className="border border-black">
                  <td className="border border-black px-1.5 py-0.5 font-semibold">
                    Total Amount
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-right font-medium">
                    {formatINR(sale.subtotal)}
                  </td>
                </tr>
                <tr className="border border-black">
                  <td className="border border-black px-1.5 py-0.5 font-semibold">
                    {anyGstApplied
                      ? `Add CGST @ ${formatNumber(gstHalfPct, 2)}%`
                      : 'Add CGST @ 0%'}
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-right">
                    {anyGstApplied ? formatINR(sale.cgst) : '—'}
                  </td>
                </tr>
                <tr className="border border-black">
                  <td className="border border-black px-1.5 py-0.5 font-semibold">
                    {anyGstApplied
                      ? `Add SGST @ ${formatNumber(gstHalfPct, 2)}%`
                      : 'Add SGST @ 0%'}
                  </td>
                  <td className="border border-black px-1.5 py-0.5 text-right">
                    {anyGstApplied ? formatINR(sale.sgst) : '—'}
                  </td>
                </tr>
                <tr className="border border-black bg-gray-100">
                  <td className="border border-black px-1.5 py-1 text-[12px] font-extrabold">
                    Grand Total
                  </td>
                  <td className="border border-black px-1.5 py-1 text-right text-[12px] font-extrabold">
                    {formatINR(sale.total_amount)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Rupees in words */}
          <div className="mt-1.5 border-t border-black pt-1 text-[10px]">
            <span className="font-semibold">Rupees in words:</span>{' '}
            <span className="italic">{amountToWords(sale.total_amount)}</span>
          </div>

          {/* ---------- 5. FOOTER ---------- */}
          <div className="mt-2 grid grid-cols-2 gap-3 border-t-2 border-black pt-2 text-[9px]">
            {/* Bottom-left: Bank Details (hardcoded with A/c Name) */}
            <div>
              <div className="font-bold uppercase tracking-wide">Bank Details:</div>
              <div className="mt-0.5 leading-snug">{BANK_DETAILS}</div>
              <div className="mt-1 text-[8px] text-gray-700">
                * Goods once sold will not be taken back. · Subject to Kolkata
                jurisdiction. · E. &amp; O.E.
              </div>
            </div>

            {/* Bottom-right: Authorised Signatory (hardcoded store name) */}
            <div className="text-right">
              <div className="font-semibold">For, {STORE_NAME}</div>
              <div className="mt-8 text-[9px] text-gray-700">
                Authorised Signatory
              </div>
            </div>
          </div>
        </div>
        {/* ============ END PRINTABLE AREA ============ */}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Row({
  label,
  value,
  bold,
}: {
  label: string
  value: React.ReactNode
  bold?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'text-lg font-bold text-foreground' : 'font-medium text-foreground'}>
        {value}
      </span>
    </div>
  )
}
