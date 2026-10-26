'use client'

import { useState, useMemo } from 'react'
import { useProducts, usePurchases } from '@/lib/hooks/use-erp'
import { PurchaseService } from '@/lib/services/repository'
import {
  formatINR,
  formatNumber,
  formatDate,
  todayISO,
} from '@/lib/utils/format'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Trash2, Truck, Plus, RotateCcw } from 'lucide-react'

export function PurchaseEntry() {
  const products = useProducts()
  const purchases = usePurchases()
  const { toast } = useToast()

  const [date, setDate] = useState(todayISO())
  const [billNo, setBillNo] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [supplierGstin, setSupplierGstin] = useState('')
  const [productId, setProductId] = useState<string>('')
  const [bagQty, setBagQty] = useState(0)
  const [pcsQty, setPcsQty] = useState(0)
  const [mfgDate, setMfgDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')

  const selectedProduct = useMemo(
    () => (products ?? []).find((p) => String(p.id) === productId),
    [products, productId]
  )

  const gstPercent = selectedProduct?.gst_percent ?? 0
  const conversion = selectedProduct?.conversion_factor ?? 1
  // v4 — purchase rate per outer unit (the per-Bag buying price)
  const purchaseRatePerOuter = selectedProduct
    ? (selectedProduct.purchase_rate_per_outer_unit ?? selectedProduct.purchase_rate ?? 0)
    : 0
  const purchaseRatePerPiece = selectedProduct
    ? (selectedProduct.purchase_rate_per_piece ?? selectedProduct.purchase_rate_per_pcs ?? purchaseRatePerOuter / conversion)
    : 0

  const totalPcs = bagQty * conversion + pcsQty
  // taxable = (total_pcs / conversion) * purchase_rate_per_outer_unit
  //        = total_pcs * purchase_rate_per_piece
  const taxableAmount = totalPcs * purchaseRatePerPiece
  const cgst = (taxableAmount * (gstPercent / 2)) / 100
  const sgst = (taxableAmount * (gstPercent / 2)) / 100
  const totalAmount = taxableAmount + cgst + sgst

  const resetForm = () => {
    setDate(todayISO())
    setBillNo('')
    setSupplierName('')
    setSupplierGstin('')
    setProductId('')
    setBagQty(0)
    setPcsQty(0)
    setMfgDate('')
    setExpiryDate('')
  }

  const save = async () => {
    if (!billNo || !supplierName || !selectedProduct) {
      toast({
        title: 'Missing fields',
        description: 'Bill No, Supplier, and Product are required.',
        variant: 'destructive',
      })
      return
    }
    if (totalPcs <= 0) {
      toast({
        title: 'Invalid quantity',
        description: 'Enter bag or pcs qty > 0.',
        variant: 'destructive',
      })
      return
    }
    try {
      await PurchaseService.create({
        bill_no: billNo,
        date,
        supplier_name: supplierName,
        supplier_gstin: supplierGstin,
        product_id: selectedProduct.id!,
        product_sku: selectedProduct.sku,
        product_name: selectedProduct.name,
        hsn_code: selectedProduct.hsn_code,
        bag_qty: bagQty,
        pcs_qty: pcsQty,
        total_pcs: totalPcs,
        // Store the per-outer purchase rate (matches the input model).
        purchase_rate: purchaseRatePerOuter,
        gst_percent: gstPercent,
        taxable_amount: taxableAmount,
        cgst,
        sgst,
        total_amount: totalAmount,
        mfg_date: mfgDate || undefined,
        expiry_date: expiryDate || undefined,
      })
      toast({
        title: 'Purchase recorded',
        description: `${billNo} — stock +${formatNumber(totalPcs, 0)} ${selectedProduct.base_unit}`,
      })
      resetForm()
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  const remove = async (id: number, bill: string) => {
    if (!confirm(`Delete purchase ${bill}? Stock will be reverted.`)) return
    await PurchaseService.remove(id)
    toast({ title: 'Purchase deleted', description: bill })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchase Entry"
        description="Record supplier invoices, auto-calculate GST, and update stock."
      />

      <Card>
        <CardContent className="space-y-4 p-4">
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
            <Field label="Supplier Name *">
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Product *" className="sm:col-span-2">
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select product (auto-fetches SKU & rate)" />
                </SelectTrigger>
                <SelectContent>
                  {(products ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.sku} · {p.name} ({p.company_name})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={`Bag Qty (1 Bag = ${conversion} Pcs)`}>
              <Input
                type="number"
                min={0}
                value={bagQty}
                onChange={(e) => setBagQty(Number(e.target.value))}
              />
            </Field>
            <Field label="Extra Pcs Qty">
              <Input
                type="number"
                min={0}
                value={pcsQty}
                onChange={(e) => setPcsQty(Number(e.target.value))}
              />
            </Field>
            <Field label="MFG Date">
              <Input
                type="date"
                value={mfgDate}
                onChange={(e) => setMfgDate(e.target.value)}
              />
            </Field>
            <Field label="Expiry Date">
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </Field>
          </div>

          {selectedProduct && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                <Mini label="SKU" value={selectedProduct.sku} />
                <Mini label="HSN" value={selectedProduct.hsn_code} />
                <Mini label="GST%" value={`${gstPercent}%`} />
                <Mini label="Total Pcs" value={formatNumber(totalPcs, 0)} />
                <Mini label={`Pur. Rate / ${selectedProduct.outer_unit}`} value={formatINR(purchaseRatePerOuter)} />
                <Mini
                  label={`Pur. Rate / ${selectedProduct.base_unit}`}
                  value={`₹${purchaseRatePerPiece.toFixed(4)}`}
                  highlight
                />
                <Mini label="Taxable Amt" value={formatINR(taxableAmount)} />
                <Mini label="CGST" value={formatINR(cgst)} />
                <Mini label="SGST" value={formatINR(sgst)} />
                <Mini label="Total Amount" value={formatINR(totalAmount)} bold />
              </div>
              <div className="mt-2 rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
                <strong>Effective per-piece rate:</strong>{' '}
                {formatINR(purchaseRatePerOuter)} (per {selectedProduct.outer_unit}){' '}
                ÷ {conversion} ({selectedProduct.base_unit}/{selectedProduct.outer_unit}) ={' '}
                <strong className="font-mono">
                  ₹{purchaseRatePerPiece.toFixed(4)}/{selectedProduct.base_unit}
                </strong>
                . This rate is saved to the product master so POS profit
                calculations remain accurate.
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={save}>
              <Plus className="mr-1 h-4 w-4" /> Save Purchase
            </Button>
            <Button variant="outline" onClick={resetForm}>
              <RotateCcw className="mr-1 h-4 w-4" /> Reset
            </Button>
          </div>
        </CardContent>
      </Card>

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
                    <TableHead className="text-right">Bag × Pcs</TableHead>
                    <TableHead className="text-right">Total Pcs</TableHead>
                    <TableHead className="text-right">GST%</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">CGST</TableHead>
                    <TableHead className="text-right">SGST</TableHead>
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
                        {p.bag_qty} × {p.pcs_qty}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatNumber(p.total_pcs, 0)}
                      </TableCell>
                      <TableCell className="text-right text-xs">{p.gst_percent}%</TableCell>
                      <TableCell className="text-right text-xs">
                        {formatINR(p.taxable_amount)}
                      </TableCell>
                      <TableCell className="text-right text-xs">{formatINR(p.cgst)}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(p.sgst)}</TableCell>
                      <TableCell className="text-right text-xs font-semibold">
                        {formatINR(p.total_amount)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => remove(p.id!, p.bill_no)}
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
  highlight,
}: {
  label: string
  value: string
  bold?: boolean
  highlight?: boolean
}) {
  return (
    <div
      className={
        highlight ? 'rounded bg-emerald-100 px-1.5 py-1 dark:bg-emerald-950' : ''
      }
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={
          'text-sm ' +
          (bold
            ? 'font-semibold text-primary'
            : highlight
            ? 'font-semibold text-emerald-700 dark:text-emerald-300'
            : 'font-medium')
        }
      >
        {value}
      </div>
    </div>
  )
}
