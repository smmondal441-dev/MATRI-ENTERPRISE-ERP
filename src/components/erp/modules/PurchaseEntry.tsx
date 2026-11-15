'use client'

// ============================================================================
// Purchase Entry — Multi-item Vendor Invoice (Tally/SAP style)
// ----------------------------------------------------------------------------
// A single vendor invoice (lorry load) contains multiple products. This
// module captures the shared invoice header (Vendor, Invoice No, Date) once,
// then lets the user add multiple products to a cart, each with its own
// qty / rate / GST / MFG / Expiry. A single "Save Purchase Invoice" button
// calls PurchaseService.createBatch() which creates N Purchase rows sharing
// the same bill_no, bumps stock per item, and updates each product's
// purchase rate to the latest batch rate.
//
// Cart respects is_loose:
//   - Packaged: shows "Bag Qty" + "Extra Pcs" inputs
//   - Loose: shows a single "Qty (Kg/Gm)" input (bag_qty forced to 0)
// ============================================================================

import { useState, useMemo } from 'react'
import { useProducts, usePurchases } from '@/lib/hooks/use-erp'
import {
  PurchaseService,
  getPurchaseRatePerOuterUnit,
  getPurchaseRatePerPiece,
  type PurchaseDraftItem,
} from '@/lib/services/repository'
import {
  formatINR,
  formatNumber,
  formatDate,
  todayISO,
} from '@/lib/utils/format'
import type { Product } from '@/lib/db/dexie'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Combobox } from '@/components/erp/Combobox'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  Trash2,
  Truck,
  Plus,
  RotateCcw,
  AlertTriangle,
  Save,
  X,
  Receipt,
} from 'lucide-react'

// ---- Cart line interface ----
// Each line = one product in the vendor invoice cart. qty is captured as
// bag_qty + pcs_qty (packaged) OR a single weight qty (loose). The line
// computes its own taxable / CGST / SGST / total based on the editable
// purchase_rate (per outer unit or per Kg for loose).
interface PurchaseCartLine {
  uid: string
  product: Product
  bagQty: number // 0 for loose products
  pcsQty: number // loose: this IS the qty in Kg/Gm; packaged: extra pcs
  purchaseRate: number // editable — per outer unit (Bag) or per Kg (loose)
  gstPercent: number // defaults to product's gst_percent
  mfgDate: string
  expiryDate: string
}

export function PurchaseEntry() {
  const products = useProducts()
  const purchases = usePurchases()
  const { toast } = useToast()

  // ---- Shared invoice header (master section) ----
  const [date, setDate] = useState(todayISO())
  const [billNo, setBillNo] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [supplierGstin, setSupplierGstin] = useState('')

  // ---- Cart (detail section) ----
  const [cart, setCart] = useState<PurchaseCartLine[]>([])

  // ---- Computed cart items (live tax/GST math) ----
  // Each line computes: totalPcs, taxable, CGST, SGST, total based on the
  // editable purchaseRate + qty + gstPercent. This feeds both the cart table
  // display AND the createBatch() payload.
  const computedItems: PurchaseDraftItem[] = useMemo(() => {
    return cart.map((line) => {
      const p = line.product
      const cf = Number(p.conversion_factor) || 1
      const bagQty = p.is_loose ? 0 : line.bagQty
      const pcsQty = line.pcsQty
      const totalPcs = p.is_loose ? pcsQty : bagQty * cf + pcsQty
      // purchaseRate is per outer unit (Bag) for packaged, per Kg for loose.
      // taxable = totalPcs * purchaseRatePerPiece
      //         = totalPcs * (purchaseRate / cf)
      // For loose, cf=1 so taxable = pcsQty * purchaseRate (per Kg × Kg).
      const purchaseRatePerPiece = cf > 0 ? line.purchaseRate / cf : line.purchaseRate
      const taxableAmount = totalPcs * purchaseRatePerPiece
      const cgst = (taxableAmount * (line.gstPercent / 2)) / 100
      const sgst = (taxableAmount * (line.gstPercent / 2)) / 100
      const totalAmount = taxableAmount + cgst + sgst
      return {
        product_id: p.id!,
        product_sku: p.sku,
        product_name: p.name,
        hsn_code: p.hsn_code,
        bag_qty: bagQty,
        pcs_qty: pcsQty,
        total_pcs: totalPcs,
        purchase_rate: line.purchaseRate,
        gst_percent: line.gstPercent,
        taxable_amount: taxableAmount,
        cgst,
        sgst,
        total_amount: totalAmount,
        mfg_date: line.mfgDate || undefined,
        expiry_date: line.expiryDate || undefined,
      }
    })
  }, [cart])

  // ---- Grand totals (sum across all cart lines) ----
  const totals = useMemo(() => {
    const taxable = computedItems.reduce((s, i) => s + i.taxable_amount, 0)
    const cgst = computedItems.reduce((s, i) => s + i.cgst, 0)
    const sgst = computedItems.reduce((s, i) => s + i.sgst, 0)
    const total = computedItems.reduce((s, i) => s + i.total_amount, 0)
    const items = computedItems.length
    const totalPcs = computedItems.reduce((s, i) => s + i.total_pcs, 0)
    return { taxable, cgst, sgst, total, items, totalPcs }
  }, [computedItems])

  // ---- Add product to cart ----
  const addProductToCart = (productId: string) => {
    const prod = (products ?? []).find((p) => String(p.id) === productId)
    if (!prod) return
    const prodIdStr = String(prod.id)
    setCart((prev) => {
      const existing = prev.find((l) => String(l.product.id) === prodIdStr)
      if (existing) {
        // Already in cart — bump bag qty by 1 (packaged) or pcs by 1 (loose)
        return prev.map((l) =>
          String(l.product.id) === prodIdStr
            ? {
                ...l,
                bagQty: l.product.is_loose ? 0 : l.bagQty + 1,
              }
            : l
        )
      }
      // New line — default purchase rate to product's current rate, gst to
      // product's gst_percent. User can edit both in the cart.
      return [
        ...prev,
        {
          uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          product: prod,
          bagQty: prod.is_loose ? 0 : 1,
          pcsQty: 0,
          purchaseRate: getPurchaseRatePerOuterUnit(prod),
          gstPercent: prod.gst_percent,
          mfgDate: '',
          expiryDate: '',
        },
      ]
    })
  }

  // ---- Cart line updaters ----
  const updateBagQty = (uid: string, qty: number) => {
    setCart((prev) =>
      prev.map((l) =>
        l.uid === uid ? { ...l, bagQty: Math.max(0, qty) } : l
      )
    )
  }
  const updatePcsQty = (uid: string, qty: number) => {
    setCart((prev) =>
      prev.map((l) =>
        l.uid === uid ? { ...l, pcsQty: Math.max(0, qty) } : l
      )
    )
  }
  const updateRate = (uid: string, rate: number) => {
    setCart((prev) =>
      prev.map((l) =>
        l.uid === uid ? { ...l, purchaseRate: Math.max(0, rate) } : l
      )
    )
  }
  const updateGst = (uid: string, gst: number) => {
    setCart((prev) =>
      prev.map((l) =>
        l.uid === uid ? { ...l, gstPercent: Math.max(0, gst) } : l
      )
    )
  }
  const updateMfg = (uid: string, val: string) => {
    setCart((prev) =>
      prev.map((l) => (l.uid === uid ? { ...l, mfgDate: val } : l))
    )
  }
  const updateExpiry = (uid: string, val: string) => {
    setCart((prev) =>
      prev.map((l) => (l.uid === uid ? { ...l, expiryDate: val } : l))
    )
  }
  const removeLine = (uid: string) => {
    setCart((prev) => prev.filter((l) => l.uid !== uid))
  }

  const resetForm = () => {
    setDate(todayISO())
    setBillNo('')
    setSupplierName('')
    setSupplierGstin('')
    setCart([])
  }

  // ---- Save: validates header + cart, then calls createBatch ----
  const saveInvoice = async () => {
    if (!billNo || !supplierName) {
      toast({
        title: 'Missing invoice details',
        description: 'Invoice Number and Vendor Name are required.',
        variant: 'destructive',
      })
      return
    }
    if (cart.length === 0) {
      toast({
        title: 'Empty cart',
        description: 'Add at least one product to the purchase invoice.',
        variant: 'destructive',
      })
      return
    }
    // Check every line has qty > 0
    const emptyLines = computedItems.filter((i) => i.total_pcs <= 0)
    if (emptyLines.length > 0) {
      toast({
        title: 'Invalid quantity',
        description: `${emptyLines.length} line(s) have zero quantity. Enter bag or pcs qty > 0.`,
        variant: 'destructive',
      })
      return
    }
    // Soft warning for missing MFG/Expiry on lines (FEFO depends on these)
    const missingDates = cart.filter((l) => !l.mfgDate || !l.expiryDate)
    if (missingDates.length > 0) {
      const proceed = confirm(
        `${missingDates.length} of ${cart.length} item(s) are missing MFG or Expiry date. ` +
          'Inventory FEFO / near-expiry alerts depend on these dates. Save anyway?'
      )
      if (!proceed) return
    }
    try {
      const ids = await PurchaseService.createBatch({
        bill_no: billNo,
        date,
        supplier_name: supplierName,
        supplier_gstin: supplierGstin || undefined,
        items: computedItems,
      })
      toast({
        title: 'Purchase invoice saved',
        description: `${billNo} · ${ids.length} item(s) · ${formatINR(totals.total)}`,
      })
      resetForm()
    } catch (e) {
      toast({
        title: 'Save failed',
        description: String(e),
        variant: 'destructive',
      })
    }
  }

  const removePurchase = async (id: number, bill: string) => {
    if (!confirm(`Delete purchase entry ${bill}? Stock will be reverted.`)) return
    await PurchaseService.remove(id)
    toast({ title: 'Purchase deleted', description: bill })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchase Entry"
        description="Record multi-item vendor invoices (lorry loads). Shared invoice header + per-item cart."
      />

      {/* ---------- Master: shared invoice header ---------- */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Supplier Invoice No *">
              <Input
                value={billNo}
                onChange={(e) => setBillNo(e.target.value)}
                placeholder="e.g. PUR-2024-001"
              />
            </Field>
            <Field label="Vendor / Company Name *">
              <Input
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="e.g. Parle Agro Pvt Ltd"
              />
            </Field>
            <Field label="Supplier GSTIN">
              <Input
                value={supplierGstin}
                onChange={(e) => setSupplierGstin(e.target.value)}
                placeholder="29ABCDE1234F1Z5"
                className="font-mono text-xs"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ---------- Product cart: add + table ---------- */}
      <Card>
        <CardContent className="space-y-3 p-4">
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
                `${p.sku} · ${p.name} — Buy ${formatINR(getPurchaseRatePerOuterUnit(p))}/${p.is_loose ? p.base_unit : p.outer_unit}`
              }
              filterFn={(p, q) =>
                p.name.toLowerCase().includes(q) ||
                p.sku.toLowerCase().includes(q) ||
                p.company_name.toLowerCase().includes(q) ||
                p.hsn_code.toLowerCase().includes(q)
              }
              placeholder="Search & select product to add to purchase cart..."
              searchPlaceholder="Search by name / SKU / company / HSN..."
              emptyText="No product matches your search."
              renderItem={(p) => (
                <div className="flex w-full items-center justify-between gap-2 leading-tight">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {p.sku} · Stock {formatNumber(p.opening_stock_pcs, 0)} {p.base_unit}
                      {p.is_loose ? ' · Loose' : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-[11px]">
                    <div className="font-semibold text-blue-700">
                      Buy {formatINR(getPurchaseRatePerOuterUnit(p))}/{p.is_loose ? p.base_unit : p.outer_unit}
                    </div>
                  </div>
                </div>
              )}
            />
          </Field>

          {/* Cart table */}
          {cart.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <Receipt className="mx-auto mb-2 h-8 w-8 opacity-40" />
              Cart is empty. Add products above to start recording this invoice.
            </div>
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    {/* Packaged: Bag Qty + Extra Pcs. Loose: single Qty column. */}
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>MFG</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">GST%</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">CGST</TableHead>
                    <TableHead className="text-right">SGST</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {computedItems.map((item, idx) => {
                    const line = cart[idx]
                    const p = line.product
                    const cf = Number(p.conversion_factor) || 1
                    return (
                      <TableRow key={line.uid}>
                        <TableCell>
                          <div className="text-sm font-medium">{item.product_name}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {item.product_sku} · HSN {item.hsn_code}
                          </div>
                          {p.is_loose && (
                            <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                              Loose
                            </span>
                          )}
                        </TableCell>
                        {/* Qty cell — adapts to is_loose */}
                        <TableCell className="text-right">
                          {p.is_loose ? (
                            // Loose: single qty input (Kg or Gm)
                            <div className="flex items-center justify-end gap-1">
                              <Input
                                type="number"
                                min={0}
                                step="0.001"
                                value={line.pcsQty}
                                onChange={(e) => updatePcsQty(line.uid, Number(e.target.value))}
                                className="h-8 w-20 text-right text-xs"
                              />
                              <span className="text-xs text-muted-foreground">{p.base_unit}</span>
                            </div>
                          ) : (
                            // Packaged: Bag Qty + Extra Pcs stacked
                            <div className="flex flex-col items-end gap-1">
                              <div className="flex items-center gap-1">
                                <Input
                                  type="number"
                                  min={0}
                                  value={line.bagQty}
                                  onChange={(e) => updateBagQty(line.uid, Number(e.target.value))}
                                  className="h-7 w-16 text-right text-xs"
                                />
                                <span className="text-[10px] text-muted-foreground">{p.outer_unit}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Input
                                  type="number"
                                  min={0}
                                  value={line.pcsQty}
                                  onChange={(e) => updatePcsQty(line.uid, Number(e.target.value))}
                                  className="h-7 w-16 text-right text-xs"
                                />
                                <span className="text-[10px] text-muted-foreground">{p.base_unit}</span>
                              </div>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="date"
                            value={line.mfgDate}
                            onChange={(e) => updateMfg(line.uid, e.target.value)}
                            className="h-8 w-36 text-xs"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="date"
                            value={line.expiryDate}
                            onChange={(e) => updateExpiry(line.uid, e.target.value)}
                            className="h-8 w-36 text-xs"
                          />
                        </TableCell>
                        {/* Editable purchase rate (per outer unit or per Kg) */}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              value={line.purchaseRate}
                              onChange={(e) => updateRate(line.uid, Number(e.target.value))}
                              className="h-8 w-24 text-right text-xs"
                            />
                            <span className="text-[10px] text-muted-foreground">
                              /{p.is_loose ? p.base_unit : p.outer_unit}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="number"
                              min={0}
                              step="0.5"
                              value={line.gstPercent}
                              onChange={(e) => updateGst(line.uid, Number(e.target.value))}
                              className="h-8 w-16 text-right text-xs"
                            />
                            <span className="text-[10px] text-muted-foreground">%</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {formatINR(item.taxable_amount)}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {item.cgst > 0 ? formatINR(item.cgst) : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {item.sgst > 0 ? formatINR(item.sgst) : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold">
                          {formatINR(item.total_amount)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            onClick={() => removeLine(line.uid)}
                          >
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

          {/* Footer: grand totals + save button */}
          {cart.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
                <Mini label="Items" value={String(totals.items)} />
                <Mini label="Total Qty" value={formatNumber(totals.totalPcs, 2)} />
                <Mini label="Taxable" value={formatINR(totals.taxable)} />
                <Mini label="CGST" value={formatINR(totals.cgst)} />
                <Mini label="SGST" value={formatINR(totals.sgst)} />
                <Mini label="Grand Total" value={formatINR(totals.total)} bold />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={resetForm}>
                  <RotateCcw className="mr-1 h-4 w-4" /> Reset
                </Button>
                <Button onClick={saveInvoice} size="lg">
                  <Save className="mr-2 h-4 w-4" /> Save Purchase Invoice
                </Button>
              </div>
            </div>
          )}

          {/* FEFO hint */}
          {cart.length > 0 && cart.some((l) => !l.mfgDate || !l.expiryDate) && (
            <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>Inventory FEFO tip:</strong> MFG &amp; Expiry dates
                power the Inventory module&apos;s shelf-life tracking
                (Near-Expiry / Expired filter tabs + days-remaining badges).
                Please fill them in when the supplier invoice has them.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- Recent purchases (read-only log) ---------- */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent Purchases</h3>
            <span className="text-xs text-muted-foreground">
              {purchases?.length ?? 0} entries
            </span>
          </div>
          {(purchases ?? []).length === 0 ? (
            <EmptyState
              title="No purchases yet"
              description="Record your first supplier invoice above."
              icon={<Truck className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">GST%</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(purchases ?? []).slice(0, 100).map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs">{formatDate(p.date)}</TableCell>
                      <TableCell className="font-mono text-xs">{p.bill_no}</TableCell>
                      <TableCell className="text-xs">{p.supplier_name}</TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium">{p.product_name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {p.product_sku}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {p.bag_qty > 0 ? `${p.bag_qty} × ${p.pcs_qty}` : formatNumber(p.total_pcs, 2)}
                        <div className="text-[10px] text-muted-foreground">
                          {formatNumber(p.total_pcs, p.bag_qty > 0 ? 0 : 2)} {p.bag_qty > 0 ? 'Pcs' : 'units'}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs">{p.gst_percent}%</TableCell>
                      <TableCell className="text-right text-xs">
                        {formatINR(p.taxable_amount)}
                      </TableCell>
                      <TableCell className="text-right text-xs font-semibold">
                        {formatINR(p.total_amount)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => removePurchase(p.id!, p.bill_no)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
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

function Mini({
  label,
  value,
  bold,
}: {
  label: string
  value: string
  bold?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={bold ? 'text-sm font-bold text-primary' : 'text-sm font-medium'}>
        {value}
      </div>
    </div>
  )
}
