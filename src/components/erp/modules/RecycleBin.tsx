'use client'

// ============================================================================
// RecycleBin — Soft Delete recovery UI
// ----------------------------------------------------------------------------
// Lists all soft-deleted items (is_deleted === true) across 4 tabs:
// Products, Customers, Sales, Purchases. Each item has a "Restore" button
// (sets is_deleted = false + re-applies inventory math) and a "Hard Delete"
// button (permanently removes the row).
// ============================================================================

import { useState, useCallback } from 'react'
import {
  ProductService,
  CustomerService,
  PurchaseService,
  SaleService,
} from '@/lib/services/repository'
import {
  formatINR,
  formatDate,
} from '@/lib/utils/format'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { Recycle, RotateCcw, Trash2, Package, Users, Receipt, Truck } from 'lucide-react'
import type { Product, Customer, Sale, Purchase } from '@/lib/db/dexie'

export function RecycleBin() {
  const { toast } = useToast()
  const [refreshKey, setRefreshKey] = useState(0)

  const refresh = () => setRefreshKey((k) => k + 1)

  // ---- Handlers ----
  const handleRestoreProduct = async (id: number) => {
    await ProductService.restore(id)
    toast({ title: 'Product restored' })
    refresh()
  }
  const handleHardDeleteProduct = async (id: number, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return
    await ProductService.hardDelete(id)
    toast({ title: 'Product permanently deleted' })
    refresh()
  }

  const handleRestoreCustomer = async (id: number) => {
    await CustomerService.restore(id)
    toast({ title: 'Customer restored' })
    refresh()
  }
  const handleHardDeleteCustomer = async (id: number, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return
    await CustomerService.hardDelete(id)
    toast({ title: 'Customer permanently deleted' })
    refresh()
  }

  const handleRestoreSale = async (id: number) => {
    await SaleService.restore(id)
    toast({ title: 'Sale restored — stock re-applied' })
    refresh()
  }
  const handleHardDeleteSale = async (id: number, invoiceNo: string) => {
    if (!confirm(`Permanently delete sale ${invoiceNo}? This cannot be undone.`)) return
    await SaleService.hardDelete(id)
    toast({ title: 'Sale permanently deleted' })
    refresh()
  }

  const handleRestorePurchase = async (id: number) => {
    await PurchaseService.restore(id)
    toast({ title: 'Purchase restored — stock re-applied' })
    refresh()
  }
  const handleHardDeletePurchase = async (id: number, billNo: string) => {
    if (!confirm(`Permanently delete purchase ${billNo}? This cannot be undone.`)) return
    await PurchaseService.hardDelete(id)
    toast({ title: 'Purchase permanently deleted' })
    refresh()
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recycle Bin"
        description="Restore accidentally deleted items or permanently remove them. Inventory is automatically adjusted on restore."
      />

      <Tabs defaultValue="products" className="w-full">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
          <TabsTrigger value="products">
            <Package className="mr-1 h-3.5 w-3.5" /> Products
          </TabsTrigger>
          <TabsTrigger value="customers">
            <Users className="mr-1 h-3.5 w-3.5" /> Customers
          </TabsTrigger>
          <TabsTrigger value="sales">
            <Receipt className="mr-1 h-3.5 w-3.5" /> Sales
          </TabsTrigger>
          <TabsTrigger value="purchases">
            <Truck className="mr-1 h-3.5 w-3.5" /> Purchases
          </TabsTrigger>
        </TabsList>

        {/* ---- Products tab ---- */}
        <TabsContent value="products">
          <Card>
            <CardContent className="p-4">
              <DeletedProducts
                key={`prod-${refreshKey}`}
                onRestore={handleRestoreProduct}
                onHardDelete={handleHardDeleteProduct}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Customers tab ---- */}
        <TabsContent value="customers">
          <Card>
            <CardContent className="p-4">
              <DeletedCustomers
                key={`cust-${refreshKey}`}
                onRestore={handleRestoreCustomer}
                onHardDelete={handleHardDeleteCustomer}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Sales tab ---- */}
        <TabsContent value="sales">
          <Card>
            <CardContent className="p-4">
              <DeletedSales
                key={`sale-${refreshKey}`}
                onRestore={handleRestoreSale}
                onHardDelete={handleHardDeleteSale}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Purchases tab ---- */}
        <TabsContent value="purchases">
          <Card>
            <CardContent className="p-4">
              <DeletedPurchases
                key={`pur-${refreshKey}`}
                onRestore={handleRestorePurchase}
                onHardDelete={handleHardDeletePurchase}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Sub-components — each loads its own deleted list via the service
// ----------------------------------------------------------------------------

function DeletedProducts({
  onRestore,
  onHardDelete,
}: {
  onRestore: (id: number) => Promise<void>
  onHardDelete: (id: number, name: string) => Promise<void>
}) {
  const [items, setItems] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)

  // Load on mount
  useState(() => {
    ProductService.listDeleted().then((rows) => {
      setItems(rows)
      setLoading(false)
    })
  })

  if (loading) return <LoadingSpinner />
  if (items.length === 0) return <EmptyBin label="Products" />

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>SKU</TableHead>
          <TableHead>Product Name</TableHead>
          <TableHead>Company</TableHead>
          <TableHead className="text-right">Stock</TableHead>
          <TableHead>Deleted At</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="font-mono text-xs">{p.sku}</TableCell>
            <TableCell className="font-medium">{p.name}</TableCell>
            <TableCell className="text-xs">{p.company_name}</TableCell>
            <TableCell className="text-right text-xs">{p.opening_stock_pcs} {p.base_unit}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatDate(p.created_at)}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onRestore(p.id!)}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Restore
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onHardDelete(p.id!, p.name)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DeletedCustomers({
  onRestore,
  onHardDelete,
}: {
  onRestore: (id: number) => Promise<void>
  onHardDelete: (id: number, name: string) => Promise<void>
}) {
  const [items, setItems] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)

  useState(() => {
    CustomerService.listDeleted().then((rows) => {
      setItems(rows)
      setLoading(false)
    })
  })

  if (loading) return <LoadingSpinner />
  if (items.length === 0) return <EmptyBin label="Customers" />

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Code</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Route</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>Deleted At</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="font-mono text-xs">{c.customer_id}</TableCell>
            <TableCell className="font-medium">{c.name}</TableCell>
            <TableCell className="text-xs">{c.route_area}</TableCell>
            <TableCell className="text-xs">{c.phone}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatDate(c.created_at)}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onRestore(c.id!)}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Restore
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onHardDelete(c.id!, c.name)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DeletedSales({
  onRestore,
  onHardDelete,
}: {
  onRestore: (id: number) => Promise<void>
  onHardDelete: (id: number, invoiceNo: string) => Promise<void>
}) {
  const [items, setItems] = useState<Sale[]>([])
  const [loading, setLoading] = useState(true)

  useState(() => {
    SaleService.listDeleted().then((rows) => {
      setItems(rows)
      setLoading(false)
    })
  })

  if (loading) return <LoadingSpinner />
  if (items.length === 0) return <EmptyBin label="Sales" />

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
            <TableCell className="text-xs">{formatDate(s.date)}</TableCell>
            <TableCell className="text-xs">{s.customer_name}</TableCell>
            <TableCell>
              <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px]">{s.payment_mode}</span>
            </TableCell>
            <TableCell className="text-right text-xs font-semibold">{formatINR(s.total_amount)}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onRestore(s.id!)}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Restore
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onHardDelete(s.id!, s.invoice_no)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DeletedPurchases({
  onRestore,
  onHardDelete,
}: {
  onRestore: (id: number) => Promise<void>
  onHardDelete: (id: number, billNo: string) => Promise<void>
}) {
  const [items, setItems] = useState<Purchase[]>([])
  const [loading, setLoading] = useState(true)

  useState(() => {
    PurchaseService.listDeleted().then((rows) => {
      setItems(rows)
      setLoading(false)
    })
  })

  if (loading) return <LoadingSpinner />
  if (items.length === 0) return <EmptyBin label="Purchases" />

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Supplier</TableHead>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="font-mono text-xs">{p.bill_no}</TableCell>
            <TableCell className="text-xs">{formatDate(p.date)}</TableCell>
            <TableCell className="text-xs">{p.supplier_name}</TableCell>
            <TableCell className="text-xs">{p.product_name}</TableCell>
            <TableCell className="text-right text-xs font-semibold">{formatINR(p.total_amount)}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onRestore(p.id!)}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Restore
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onHardDelete(p.id!, p.bill_no)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function LoadingSpinner() {
  return (
    <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span className="ml-2">Loading deleted items...</span>
    </div>
  )
}

function EmptyBin({ label }: { label: string }) {
  return (
    <EmptyState
      title={`No deleted ${label.toLowerCase()}`}
      description={`Deleted ${label.toLowerCase()} will appear here for restoration.`}
      icon={<Recycle className="h-6 w-6" />}
    />
  )
}
