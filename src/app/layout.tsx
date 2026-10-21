import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SyncProvider } from "@/components/erp/SyncProvider";

export const metadata: Metadata = {
  title: "FMCG Distribution House ERP & Billing",
  description:
    "Offline-first ERP for FMCG distributors — Product & Customer masters, Purchase, POS Billing, Sales Ledger, Collections, Inventory, GST Reports for CA. Hybrid sync to PostgreSQL backend.",
  keywords: [
    "FMCG ERP",
    "Distribution House",
    "Billing",
    "POS",
    "GST Reports",
    "IndexedDB",
    "Dexie",
    "PostgreSQL",
    "Offline-First",
    "Hybrid Sync",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <SyncProvider>{children}</SyncProvider>
        <Toaster />
      </body>
    </html>
  );
}
