'use client'

// ============================================================================
// SaleEditDialog — Upgrade 2: Edit a saved Sale in place
// ----------------------------------------------------------------------------
// Loads a sale + its line items via SaleService.get(), exposes an editable
// form (customer Combobox, payment mode, date, line items with qty/rate/GST),
// and saves changes via SaleService.update() which atomically:
//   - restores old stock,
//   - deletes old sale_items,
//   - updates the sale header in place,
//   - inserts new sale_items,
//   - decrements new stock.
// All edits mark the sale + items + affected products isSynced=false so the
// sync layer re-pushes them to Turso.
//
// This dialog is reusable: pass `saleId`, `open`, `onOpenChange`, and
// `onSaved()` callback (typically to refresh the live query / show toast).
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import {
  useProducts,
  useCustomers,
} from '@/lib/hooks/use-erp'
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
  todayISO,
} from '@/lib/utils/format'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import { Combobox } from '@/components/erp/Combobox'
import { Save, X, Plus, Trash2, Percent } from 'lucide-react'
import type { Product, Customer } from '@/lib/db/dexie'

interface EditCartLine {
  uid: string
  product: Product
  qtyPcs: number
  rate: number // selling rate per piece (editable)
  gstPercent: number // override per-line
}

interface SaleEditDialogProps {
  saleId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}

export function SaleEditDialog({
  saleId,
  open,
  onOpenChange,
  onSaved,
}: SaleEditDialogProps) {
  const products = useProducts()
  const customers = useCustomers()
  const { toast } = useToast()

  // ---- Form state ----
  const [invoiceNo, setInvoiceNo] = useState('')
  const [date, setDate] = useState(todayISO())
  const [customerId, setCustomerId] = useState<string>('')
  const [paymentMode, setPaymentMode] = useState<'Cash' | 'Credit'>('Cash')
  const [cart, setCart] = useState<EditCartLine[]>([])
  // GST control — mirrors SalesBill's manual GST switch (v6).
  const [applyGst, setApplyGst] = useState(true)
  const [useCustomGstPercent, setUseCustomGstPercent] = useState(false)
  const [customGstPercent, setCustomGstPercent] = useState<number>(5)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // ---- Load sale + items when the dialog opens ----
  useEffect(() => {
    if (!open || saleId == null) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const detail = await SaleService.get(saleId)
        if (cancelled || !detail) return
        const { sale, items } = detail
        setInvoiceNo(sale.invoice_no)
        setDate(sale.date)
        setCustomerId(String(sale.customer_id))
        setPaymentMode(sale.payment_mode)
        // Reconstruct cart from sale_items. Each line gets a fresh uid so
        // React keys are stable across edits.
        const newCart: EditCartLine[] = []
        for (const it of items) {
          const prod = (products ?? []).find(
            (p) => String(p.id) === String(it.product_id)
          )
          if (!prod) {
            // Product was deleted since the sale was made — skip it but warn.
            console.warn(
              `[SaleEditDialog] product_id ${it.product_id} not found; skipping line`
            )
            continue
          }
          newCart.push({
            uid:
              Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            product: prod,
            qtyPcs: it.quantity_pcs,
            rate: it.rate,
            gstPercent: it.gst_percent,
          })
        }
        setCart(newCart)
        // Auto-detect if the original sale had GST applied — if every line
        // had gst_percent = 0, default the Apply GST switch to off.
        const anyGst = items.some((it) => it.gst_percent > 0)
        setApplyGst(anyGst)
        setUseCustomGstPercent(false)
        setCustomGstPercent(5)
      } catch (e) {
        toast({
          title: 'Failed to load sale',
          description: String(e),
          variant: 'destructive',
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Re-load whenever the dialog opens with a different saleId.
    // products is also a dep because we resolve product objects inside.
  }, [open, saleId, products, toast])

  const customer = (customers ?? []).find(
    (c) => String(c.id) === customerId
  )

  // ---- Per-item live computation (mirrors SalesBill's logic) ----
  const computedItems: SaleDraftItem[] = useMemo(() => {
    return cart.map((line) => {
      const p = line.product
      const purchaseRatePerPiece = getPurchaseRatePerPiece(p)
      const taxable = line.rate * line.qtyPcs
      // GST resolution per line: respect the per-line override captured in the
      // cart (which mirrors the saved item), but if useCustomGstPercent is on,
      // override it with the global custom rate.
      let lineGstPercent = 0
      if (applyGst) {
        lineGstPercent = useCustomGstPercent
          ? Number(customGstPercent) || 0
          : line.gstPercent
      }
      const cgst = (taxable * (lineGstPercent / 2)) / 100
      const sgst = (taxable * (lineGstPercent / 2)) / 100
      const total = taxable + cgst + sgst
      const itemProfit =
        (line.rate - purchaseRatePerPiece) * line.qtyPcs
      const margin = total > 0 ? (itemProfit / total) * 100 : 0
      return {
        product_id: p.id!,
        product_name: p.name,
        product_sku: p.sku,
        hsn_code: p.hsn_code,
        quantity_pcs: line.qtyPcs,
        rate: line.rate,
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
    const prodIdStr = String(prod.id)
    setCart((prev) => {
      const existing = prev.find((l) => String(l.product.id) === prodIdStr)
      if (existing) {
        return prev.map((l) =>
          String(l.product.id) === prodIdStr
            ? { ...l, qtyPcs: l.qtyPcs + 1 }
            : l
        )
      }
      return [
        ...prev,
        {
          uid:
            Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          product: prod,
          qtyPcs: 1,
          rate: getSellingRatePerPiece(prod),
          gstPercent: prod.gst_percent,
        },
      ]
    })
  }

  const updateLineQty = (uid: string, qty: number) => {
    setCart((prev) =>
      prev.map((l) =>
        l.uid === uid ? { ...l, qtyPcs: Math.max(0, qty) } : l
      )
    )
  }
  const updateLineRate = (uid: string, rate: number) => {
    setCart((prev) =>
      prev.map((l) => (l.uid === uid ? { ...l, rate: Math.max(0, rate) } : l))
    )
  }
  const removeLine = (uid: string) => {
    setCart((prev) => prev.filter((l) => l.uid !== uid))
  }

  const handleSave = async () => {
    if (saleId == null) return
    if (!customer) {
      toast({
        title: 'Customer required',
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
    setSaving(true)
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
      await SaleService.update(saleId, draft)
      toast({
        title: 'Bill updated',
        description: `${invoiceNo} · ${formatINR(totals.total)}`,
      })
      onSaved?.()
      onOpenChange(false)
    } catch (e) {
      toast({
        title: 'Update failed',
        description: String(e),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Edit Sale</span>
            {invoiceNo && (
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                {invoiceNo}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="ml-3">Loading sale...</span>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Top row: invoice / date / customer / payment mode */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Invoice No">
                <Input
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
              <Field label="Customer *" className="sm:col-span-2">
                <Combobox<Customer>
                  items={customers ?? []}
                  value={customerId}
                  onValueChange={setCustomerId}
                  getItemValue={(c) => String(c.id)}
                  getItemLabel={(c) =>
                    `${c.customer_id} · ${c.name} (${c.route_area})`
                  }
                  filterFn={(c, q) =>
                    c.name.toLowerCase().includes(q) ||
                    c.customer_id.toLowerCase().includes(q) ||
                    c.route_area.toLowerCase().includes(q) ||
                    (c.phone || '').toLowerCase().includes(q)
                  }
                  placeholder="Search customer..."
                  searchPlaceholder="Search customer..."
                  emptyText="No customer matches your search."
                  renderItem={(c) => (
                    <div className="flex flex-col leading-tight">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {c.customer_id} · {c.route_area}
                      </span>
                    </div>
                  )}
                />
              </Field>
            </div>

            {/* Payment mode + GST control */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Payment Mode">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={paymentMode === 'Cash' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPaymentMode('Cash')}
                  >
                    Cash
                  </Button>
                  <Button
                    type="button"
                    variant={paymentMode === 'Credit' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPaymentMode('Credit')}
                  >
                    Credit
                  </Button>
                </div>
              </Field>
              <Field label="Apply GST">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={applyGst}
                    onCheckedChange={setApplyGst}
                  />
                  <span className="text-xs text-muted-foreground">
                    {applyGst ? 'GST on' : 'GST off'}
                  </span>
                </div>
              </Field>
              {applyGst && (
                <Field label="Custom GST % (all items)">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={useCustomGstPercent}
                      onCheckedChange={setUseCustomGstPercent}
                    />
                    {useCustomGstPercent && (
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step="0.5"
                        value={customGstPercent}
                        onChange={(e) =>
                          setCustomGstPercent(Number(e.target.value))
                        }
                        className="h-8 w-20 text-right text-xs"
                      />
                    )}
                    <Percent className="h-3 w-3 text-muted-foreground" />
                  </div>
                </Field>
              )}
            </div>

            {/* Add product to cart */}
            <Field label="Add Product to Cart">
              <Combobox<Product>
                items={products ?? []}
                value=""
                onValueChange={(v) => {
                  if (v) addProductToCart(v)
                }}
                getItemValue={(p) => String(p.id)}
                getItemLabel={(p) =>
                  `${p.sku} · ${p.name} — Sell ${formatINR(getSellingRatePerPiece(p))}/Pcs · Margin ${formatINR(getProfitPerPiece(p))}/Pcs`
                }
                filterFn={(p, q) =>
                  p.name.toLowerCase().includes(q) ||
                  p.sku.toLowerCase().includes(q) ||
                  p.company_name.toLowerCase().includes(q) ||
                  p.hsn_code.toLowerCase().includes(q)
                }
                placeholder="Search & select product to add to bill..."
                searchPlaceholder="Search by name / SKU / company / HSN..."
                emptyText="No product matches your search."
                renderItem={(p) => (
                  <div className="flex w-full items-center justify-between gap-2 leading-tight">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.sku} · Stock {formatNumber(p.opening_stock_pcs, 0)} {p.base_unit}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[11px]">
                      <div className="font-semibold text-emerald-700">
                        Sell {formatINR(getSellingRatePerPiece(p))}/{p.base_unit}
                      </div>
                      <div className="text-muted-foreground">
                        Margin {formatINR(getProfitPerPiece(p))}/{p.base_unit}
                      </div>
                    </div>
                  </div>
                )}
              />
            </Field>

            {/* Cart items table */}
            {cart.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Cart is empty. Add products above.
              </div>
            ) : (
              <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Qty (Pcs)</TableHead>
                      <TableHead className="text-right">Rate/Pcs</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">GST%</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Profit</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computedItems.map((item, idx) => {
                      const line = cart[idx]
                      return (
                        <TableRow key={line.uid}>
                          <TableCell>
                            <div className="text-sm font-medium">
                              {item.product_name}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {item.product_sku}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min={0}
                              value={line.qtyPcs}
                              onChange={(e) =>
                                updateLineQty(line.uid, Number(e.target.value))
                              }
                              className="h-8 w-20 text-right text-xs"
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              value={line.rate}
                              onChange={(e) =>
                                updateLineRate(line.uid, Number(e.target.value))
                              }
                              className="h-8 w-24 text-right text-xs"
                            />
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {formatINR(item.taxable_amount)}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {item.gst_percent > 0
                              ? `${item.gst_percent}%`
                              : '—'}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {item.cgst > 0 ? formatINR(item.cgst) : '—'}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {item.sgst > 0 ? formatINR(item.sgst) : '—'}
                          </TableCell>
                          <TableCell className="text-right text-xs font-semibold">
                            {formatINR(item.total)}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            <span
                              className={
                                item.item_profit >= 0
                                  ? 'text-emerald-600'
                                  : 'text-red-600'
                              }
                            >
                              {formatINR(item.item_profit)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={() => removeLine(line.uid)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Summary + actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
                <Mini label="Subtotal" value={formatINR(totals.subtotal)} />
                <Mini label="CGST" value={formatINR(totals.cgst)} />
                <Mini label="SGST" value={formatINR(totals.sgst)} />
                <Mini label="Grand Total" value={formatINR(totals.total)} bold />
                <Mini
                  label="Profit"
                  value={
                    <span
                      className={
                        totals.profit >= 0
                          ? 'text-emerald-600'
                          : 'text-red-600'
                      }
                    >
                      {formatINR(totals.profit)}
                    </span>
                  }
                />
                <Mini
                  label="Margin"
                  value={`${formatNumber(totals.margin, 2)}%`}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  <X className="mr-1 h-4 w-4" /> Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <>
                      <div className="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-1 h-4 w-4" /> Save Changes
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------
// Local helpers
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
      <Label className="mb-1 block text-xs font-medium text-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

function Mini({
  label,
  value,
  bold,
}: {
  label: string
  value: React.ReactNode
  bold?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={
          'text-sm ' + (bold ? 'font-bold text-foreground' : 'font-medium')
        }
      >
        {value}
      </div>
    </div>
  )
}
