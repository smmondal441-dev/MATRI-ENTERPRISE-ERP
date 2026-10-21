'use client'

import { useState, useEffect } from 'react'
import { useSettings, useProducts, useCustomers, useSales, usePurchases, useCollections } from '@/lib/hooks/use-erp'
import { SettingsService, BackupService } from '@/lib/services/repository'
import {
  onSyncStateChange,
  triggerSyncNow,
  getSyncState,
  type SyncState,
} from '@/lib/services/sync'
import { downloadJSON } from '@/lib/utils/format'
import { PageHeader } from '@/components/erp/EmptyState'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import {
  Save,
  Download,
  Upload,
  Database,
  Store,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  RefreshCw,
  Cloud,
  CloudOff,
} from 'lucide-react'

export function Settings() {
  const settings = useSettings()
  const { toast } = useToast()
  const [storeName, setStoreName] = useState('MATRI ENTERPRISE')
  const [subtitle, setSubtitle] = useState('Distributor Of: Too Yumm / Trsna Water')
  const [gstin, setGstin] = useState('19DSFPM8845F1Z8')
  const [address, setAddress] = useState('51, ELACHI CHAKRABORTYPARA ROAD, KOLKATA-700 151')
  const [phone, setPhone] = useState('8777746395 / 9874532121')
  const [email, setEmail] = useState('')
  const [state, setState] = useState('West Bengal (19)')
  const [invoicePrefix, setInvoicePrefix] = useState('INV')
  const [bankDetails, setBankDetails] = useState(
    'Bandhan Bank, Rajpur Branch | A/c No: 20100077079708 | IFSC: BDBL0001028'
  )

  // v5 — live sync state
  const [syncState, setSyncState] = useState<SyncState>(() => getSyncState())

  useEffect(() => {
    if (settings) {
      setStoreName(settings.store_name || 'MATRI ENTERPRISE')
      setSubtitle(settings.subtitle || 'Distributor Of: Too Yumm / Trsna Water')
      setGstin(settings.gstin || '19DSFPM8845F1Z8')
      setAddress(settings.address || '51, ELACHI CHAKRABORTYPARA ROAD, KOLKATA-700 151')
      setPhone(settings.phone || '8777746395 / 9874532121')
      setEmail(settings.email || '')
      setState(settings.state || 'West Bengal (19)')
      setInvoicePrefix(settings.invoice_prefix || 'INV')
      setBankDetails(
        settings.bank_details ||
          'Bandhan Bank, Rajpur Branch | A/c No: 20100077079708 | IFSC: BDBL0001028'
      )
    }
  }, [settings])

  useEffect(() => {
    const unsubscribe = onSyncStateChange(setSyncState)
    return unsubscribe
  }, [])

  const save = async () => {
    try {
      await SettingsService.save({
        store_name: storeName,
        subtitle,
        gstin,
        address,
        phone,
        email,
        state,
        invoice_prefix: invoicePrefix,
        bank_details: bankDetails,
      })
      toast({ title: 'Settings saved', description: storeName })
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  // Counts for backup card
  const products = useProducts()
  const customers = useCustomers()
  const sales = useSales()
  const purchases = usePurchases()
  const collections = useCollections()

  const handleExport = async () => {
    try {
      const json = await BackupService.export()
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      downloadJSON(`fmcg-erp-backup-${stamp}.json`, JSON.parse(json))
      toast({ title: 'Backup downloaded', description: 'Full IndexedDB export saved.' })
    } catch (e) {
      toast({ title: 'Backup failed', description: String(e), variant: 'destructive' })
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!confirm('Restoring will OVERWRITE all current data. Continue?')) {
      e.target.value = ''
      return
    }
    try {
      const text = await file.text()
      await BackupService.import(text)
      toast({ title: 'Restore complete', description: 'All data imported from backup file.' })
    } catch (err) {
      toast({
        title: 'Restore failed',
        description: String(err),
        variant: 'destructive',
      })
    } finally {
      e.target.value = ''
    }
  }

  const handleSyncNow = async () => {
    toast({ title: 'Syncing...', description: 'Pushing pending records to PostgreSQL' })
    await triggerSyncNow()
    const s = getSyncState()
    if (s.lastError && s.totalPending > 0) {
      toast({
        title: 'Sync failed',
        description: s.lastError,
        variant: 'destructive',
      })
    } else {
      toast({
        title: 'Sync complete',
        description: `${s.totalPending} pending record(s) remaining`,
      })
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings & Backup"
        description="Distributor profile, hybrid sync status, and offline backup / restore."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Distributor Profile */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Store className="h-4 w-4" /> Distributor Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Store Name">
              <Input value={storeName} onChange={(e) => setStoreName(e.target.value)} />
            </Field>
            <Field label="Subtitle / Tagline (printed under store name on invoice)">
              <Input
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder="e.g. Distributor Of: Too Yumm / Trsna Water"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="GSTIN">
                <Input
                  value={gstin}
                  onChange={(e) => setGstin(e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="State (with code)">
                <Input
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  placeholder="Karnataka (29)"
                />
              </Field>
            </div>
            <Field label="Address">
              <Input value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
              <Field label="Email">
                <Input value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </div>
            <Field label="Invoice Prefix">
              <Input
                value={invoicePrefix}
                onChange={(e) => setInvoicePrefix(e.target.value)}
                className="font-mono text-xs"
                placeholder="INV"
              />
            </Field>
            <Field label="Bank Details (printed on invoice footer)">
              <Input
                value={bankDetails}
                onChange={(e) => setBankDetails(e.target.value)}
                placeholder="Bank Name, Branch | A/c No: XXXX | IFSC: XXXX"
                className="text-xs"
              />
            </Field>
            <Button onClick={save}>
              <Save className="mr-1 h-4 w-4" /> Save Settings
            </Button>
          </CardContent>
        </Card>

        {/* Hybrid Sync Status (NEW v5) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Cloud className="h-4 w-4" /> Hybrid Sync (PostgreSQL)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              className={
                'rounded-md border p-3 text-xs ' +
                (syncState.isOnline
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-900')
              }
            >
              <div className="flex items-center gap-2 font-semibold">
                {syncState.isOnline ? (
                  <Cloud className="h-4 w-4" />
                ) : (
                  <CloudOff className="h-4 w-4" />
                )}
                {syncState.isOnline ? 'Online' : 'Offline'}
                {syncState.isSyncing && (
                  <span className="ml-2 inline-flex items-center gap-1 text-sky-700">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Syncing...
                  </span>
                )}
              </div>
              <div className="mt-1 opacity-80">
                {syncState.lastSyncAt
                  ? `Last sync: ${new Date(syncState.lastSyncAt).toLocaleString()}`
                  : 'No sync yet — pending records will push on next online event'}
              </div>
              {syncState.lastError && (
                <div className="mt-1 rounded bg-red-100 px-2 py-1 text-red-800">
                  Last error: {syncState.lastError}
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-semibold text-foreground">
                Pending Records (per entity)
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <Count
                  label="Products"
                  value={syncState.pendingCounts.products}
                  total={products?.length ?? 0}
                />
                <Count
                  label="Customers"
                  value={syncState.pendingCounts.customers}
                  total={customers?.length ?? 0}
                />
                <Count
                  label="Purchases"
                  value={syncState.pendingCounts.purchases}
                  total={purchases?.length ?? 0}
                />
                <Count
                  label="Sales"
                  value={syncState.pendingCounts.sales}
                  total={sales?.length ?? 0}
                />
                <Count
                  label="Sale Items"
                  value={syncState.pendingCounts.sale_items}
                  total={0}
                />
                <Count
                  label="Collections"
                  value={syncState.pendingCounts.collections}
                  total={collections?.length ?? 0}
                />
                <Count
                  label="Damages"
                  value={syncState.pendingCounts.damages}
                  total={0}
                />
                <Count
                  label="Pur. Returns"
                  value={syncState.pendingCounts.purchase_returns}
                  total={0}
                />
                <Count
                  label="Sales Returns"
                  value={syncState.pendingCounts.sales_returns}
                  total={0}
                />
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="text-[11px] text-muted-foreground">
                  Total pending: <strong>{syncState.totalPending}</strong>
                </span>
                <Button
                  size="sm"
                  onClick={handleSyncNow}
                  disabled={syncState.isSyncing || !syncState.isOnline}
                >
                  <RefreshCw
                    className={
                      'mr-1 h-4 w-4 ' + (syncState.isSyncing ? 'animate-spin' : '')
                    }
                  />
                  Sync Now
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
              <div className="flex items-center gap-2 font-semibold">
                <Database className="h-4 w-4" /> How Hybrid Sync Works
              </div>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-sky-800">
                <li>
                  All writes go to <strong>Dexie.js (IndexedDB)</strong> first —
                  billing works even when offline.
                </li>
                <li>
                  Each new/updated record is flagged <code>isSynced=false</code>.
                </li>
                <li>
                  If <code>navigator.onLine</code> is true, the SyncService pushes
                  a batch to <code>/api/sync/push</code> immediately.
                </li>
                <li>
                  On the <code>online</code> event, all pending records are pushed
                  automatically. Also re-checked every 30 seconds.
                </li>
                <li>
                  On success, <code>isSynced</code> flips to <code>true</code> +
                  <code>synced_at</code> timestamp is recorded.
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Backup & Restore */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <HardDrive className="h-4 w-4" /> Local Backup &amp; Restore
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-semibold text-foreground">
                Current Local Database Snapshot
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <Count label="Products" value={products?.length ?? 0} />
                <Count label="Customers" value={customers?.length ?? 0} />
                <Count label="Purchases" value={purchases?.length ?? 0} />
                <Count label="Sales" value={sales?.length ?? 0} />
                <Count label="Collections" value={collections?.length ?? 0} />
                <Count label="Settings" value={settings ? 1 : 0} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-center gap-2 text-emerald-800">
                  <Database className="h-4 w-4" />
                  <span className="text-sm font-semibold">Export Backup</span>
                </div>
                <p className="mt-1 text-xs text-emerald-700">
                  Download all ERP data (products, customers, purchases, sales, items,
                  collections, settings, damages, returns) as a single <code>.json</code> file.
                  Includes <code>isSynced</code> flags so you can restore on another device
                  and re-sync to PostgreSQL.
                </p>
                <Button className="mt-3 w-full" onClick={handleExport}>
                  <Download className="mr-1 h-4 w-4" /> Download Full Backup (.json)
                </Button>
              </div>

              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-sm font-semibold">Restore from Backup</span>
                </div>
                <p className="mt-1 text-xs text-amber-700">
                  Upload a previously exported <code>.json</code> file. <strong>This will
                  overwrite all current data.</strong> Restored records are marked
                  <code>isSynced=false</code> so they re-push to PostgreSQL.
                </p>
                <label className="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700">
                  <Upload className="h-4 w-4" /> Choose backup file &amp; Restore
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={handleImport}
                  />
                </label>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <div>
                <strong className="text-foreground">Offline-First Hybrid Sync:</strong>{' '}
                All data lives locally in your browser&apos;s IndexedDB via Dexie.js.
                A PostgreSQL backend (configured via <code>DATABASE_URL</code>) receives
                pushed copies for backup / multi-device sync. If the backend is
                unreachable, the ERP continues to work — pending records queue
                locally and sync automatically once connectivity returns.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Count({
  label,
  value,
  total,
}: {
  label: string
  value: number
  total?: number
}) {
  const isPending = value > 0
  return (
    <div
      className={
        'rounded-md border px-2 py-1.5 ' +
        (isPending
          ? 'border-amber-200 bg-amber-50'
          : 'border-border bg-card')
      }
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-base font-semibold">
        {value}
        {total !== undefined && total > 0 && (
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            / {total}
          </span>
        )}
      </div>
    </div>
  )
}

