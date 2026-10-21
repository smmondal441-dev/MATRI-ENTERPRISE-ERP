# Deployment Guide — FMCG ERP with PostgreSQL Backend

This guide covers PostgreSQL installation, schema setup, production build, and ongoing operations for the v5 Hybrid Sync architecture.

---

## 1. Prerequisites

| Component | Minimum Version | Notes |
|-----------|-----------------|-------|
| Node.js | 18+ | 20+ recommended |
| Bun (or npm/yarn/pnpm) | Bun 1.0+ | Preferred for speed |
| PostgreSQL | 13+ | 15+ recommended |

---

## 2. PostgreSQL Setup

### Option A — Docker (recommended for quick start)

```bash
# Pull the official PostgreSQL 16 image
docker pull postgres:16

# Run a container with a named volume for data persistence
docker run -d \
  --name fmcg-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=fmcg_erp \
  -p 5432:5432 \
  -v fmcg_pgdata:/var/lib/postgresql/data \
  postgres:16

# Verify it's running
docker ps | grep fmcg-postgres

# Test the connection
docker exec -it fmcg-postgres psql -U postgres -d fmcg_erp -c "SELECT version();"
```

The connection string becomes:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fmcg_erp
```

### Option B — Native install (Ubuntu/Debian)

```bash
# Install PostgreSQL 16
sudo apt update
sudo apt install -y postgresql-16 postgresql-contrib

# Start the service
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Create a database + user for the ERP
sudo -u postgres psql <<EOF
CREATE USER fmcg_user WITH PASSWORD 'change_me_in_prod';
CREATE DATABASE fmcg_erp OWNER fmcg_user;
GRANT ALL PRIVILEGES ON DATABASE fmcg_erp TO fmcg_user;
EOF

# Test the connection
psql "postgresql://fmcg_user:change_me_in_prod@localhost:5432/fmcg_erp" -c "SELECT version();"
```

The connection string becomes:
```
DATABASE_URL=postgresql://fmcg_user:change_me_in_prod@localhost:5432/fmcg_erp
```

### Option C — Managed PostgreSQL (Neon / Supabase / RDS / Aiven)

Create a managed PostgreSQL instance with any cloud provider. Copy the connection string from the provider's dashboard.

Example Neon connection string:
```
DATABASE_URL=postgresql://fmcg_user:xxxxxxxx@ep-xxx-pooler.region.aws.neon.tech/fmcg_erp?sslmode=require
```

**Important for managed providers**: Most require `?sslmode=require` (or `sslmode=verify-full`) at the end of the URL.

---

## 3. Configure the ERP

### Install dependencies

```bash
cd fmcg-erp
bun install   # or npm install
```

### Set environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Local PostgreSQL (Option A or B)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fmcg_erp

# Managed PostgreSQL (Option C)
# DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

### Create database tables

```bash
# Push the Prisma schema to PostgreSQL (creates all 10 tables)
bun run db:push

# Verify
psql "postgresql://postgres:postgres@localhost:5432/fmcg_erp" -c "\dt"
# Should list: products, customers, purchases, sales, sale_items,
# collections, distributor_settings, damages, purchase_returns,
# sales_returns, sync_audit_logs
```

### (Optional) Generate Prisma client

This is already done automatically by `db:push`, but if you ever change the schema:

```bash
bun run db:generate
```

---

## 4. Run the ERP

### Development mode

```bash
bun run dev
# Open http://localhost:3000
```

### Production build

```bash
# Build the standalone production bundle
bun run build

# Start the production server (port 3000 by default)
bun run start

# Override port
PORT=8080 bun run start
```

---

## 5. Verify Hybrid Sync Works

1. Open the app at <http://localhost:3000>.
2. The **SyncStatusBadge** in the header should show:
   - "10 pending" (the seeded records)
   - After a few seconds: "Synced" (green check) once PostgreSQL receives them
3. Navigate to **Settings & Backup** → **Hybrid Sync (PostgreSQL)** panel:
   - Status: "Online"
   - Last sync: timestamp
   - All pending counts should be 0 after a successful sync
4. Verify on the PostgreSQL side:
   ```bash
   psql "postgresql://postgres:postgres@localhost:5432/fmcg_erp" \
     -c "SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM customers;"
   ```
   Both should return 5 and 4 respectively (the seeded data).

### Test offline behavior

1. Open browser DevTools → Network tab → toggle "Offline".
2. The SyncStatusBadge should turn red: "Offline · 10 pending".
3. Record a sale in the POS — it saves locally.
4. Toggle "Offline" off.
5. Within 30 seconds, the SyncService should push all pending records automatically.

---

## 6. Production Deployment

### Option A — Standalone Next.js server

Best for LAN/intranet deployments or VPS hosting.

```bash
# Build
bun run build

# Run the standalone server
NODE_ENV=production bun run start

# Or with a process manager (PM2)
pm2 start "bun run start" --name fmcg-erp
pm2 save
pm2 startup
```

### Option B — Reverse proxy with Nginx

Best for production deployments with HTTPS.

`/etc/nginx/sites-available/fmcg-erp`:

```nginx
server {
    listen 80;
    server_name erp.yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name erp.yourdomain.com;

    # SSL certs (use Let's Encrypt / certbot)
    ssl_certificate /etc/letsencrypt/live/erp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/erp.yourdomain.com/privkey.pem;

    # Next.js app
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/fmcg-erp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certs
sudo certbot --nginx -d erp.yourdomain.com
```

### Option C — Deploy to Vercel / Netlify / Cloudflare Pages

Standard Next.js 16 app — push to GitHub and import.

1. Push the repo to GitHub.
2. Import the repo in Vercel (or your platform).
3. Set environment variables in the host's dashboard:
   - `DATABASE_URL` = your PostgreSQL connection string
4. Deploy.

**Note for Vercel**: Prisma needs to be generated at build time. The `postinstall` script in `package.json` should handle this automatically. If not, add:
```json
"scripts": {
  "postinstall": "prisma generate"
}
```

---

## 7. Backup Strategy

### PostgreSQL backups (automated via cron)

Set up a daily PostgreSQL dump:

```bash
# Create a backup script
sudo tee /usr/local/bin/fmcg-pg-backup.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/var/backups/fmcg-erp
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y-%m-%d_%H%M%S)
FILE="$BACKUP_DIR/fmcg-erp-$STAMP.sql.gz"

# Use pg_dump with the connection string from .env
PGPASSWORD=postgres pg_dump \
  -h localhost \
  -U postgres \
  -d fmcg_erp \
  --no-owner --no-privileges \
  | gzip > "$FILE"

# Keep only the last 14 days of backups
find "$BACKUP_DIR" -name "fmcg-erp-*.sql.gz" -mtime +14 -delete

echo "Backup saved: $FILE"
EOF

sudo chmod +x /usr/local/bin/fmcg-pg-backup.sh

# Schedule daily at 2 AM
sudo tee /etc/cron.d/fmcg-pg-backup << 'EOF'
0 2 * * * root /usr/local/bin/fmcg-pg-backup.sh >> /var/log/fmcg-pg-backup.log 2>&1
EOF
```

### Local JSON backups (manual, user-initiated)

Users can also export a JSON backup from **Settings & Backup → Download Full Backup (.json)**. This is useful for:
- Moving data between devices (export → restore on new device → re-push to PostgreSQL)
- Ad-hoc snapshots before risky operations

---

## 8. Monitoring & Operations

### Health checks

```bash
# Check that the app is up
curl -sS http://localhost:3000/api/sync/status | jq

# Expected response when PostgreSQL is reachable:
# {
#   "ok": true,
#   "serverTime": "...",
#   "counts": { "products": 5, "customers": 4, ... }
# }

# If PostgreSQL is down, you'll see:
# {
#   "ok": false,
#   "error": "Database connection failed",
#   "hint": "..."
# }
```

### Sync audit log

The Prisma schema includes a `SyncAuditLog` model that can be used to log sync events for debugging. To query it:

```bash
psql "postgresql://postgres:postgres@localhost:5432/fmcg_erp" \
  -c "SELECT * FROM sync_audit_logs ORDER BY created_at DESC LIMIT 20;"
```

(Note: the current SyncService implementation does not write audit log entries by default — this is reserved for future enhancement. The table exists in the schema so it's ready to use.)

### Checking pending counts from the client

The SyncStatusBadge in the header always shows the current pending count. To inspect deeper:

1. Navigate to **Settings & Backup** → **Hybrid Sync** panel.
2. The "Pending Records (per entity)" grid shows exactly which tables have un-synced records.
3. Click "Sync Now" to manually push pending records.

### Restarting the app

```bash
# PM2
pm2 restart fmcg-erp

# Systemd
sudo systemctl restart fmcg-erp

# Direct
kill $(cat /var/run/fmcg-erp.pid) && bun run start &
```

---

## 9. Upgrading the Schema

When you make changes to `prisma/schema.prisma`:

```bash
# 1. Always take a backup first
/usr/local/bin/fmcg-pg-backup.sh

# 2. Push the new schema (WARNING: may drop columns / tables depending on changes)
bun run db:push

# Or, for safer migrations with history:
bun run db:migrate --name descriptive_name_of_change
```

When you make changes to `src/lib/db/dexie.ts`:

```ts
// Bump the version in the constructor:
this.version(6).stores({
  // ... updated indexes
})
```

Dexie auto-migrates existing user databases on next app load — no user action needed.

---

## 10. Troubleshooting

### "Error validating datasource: URL must start with `postgresql://`"

The `.env` file is missing or has the wrong protocol. Ensure it reads:
```
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

### "Can't reach database server at localhost:5432"

PostgreSQL isn't running. Start it:
```bash
# Docker
docker start fmcg-postgres

# Native
sudo systemctl start postgresql
```

### SyncStatusBadge stays at "N pending Retry" forever

1. Open browser DevTools → Console.
2. Look for the actual error message from `/api/sync/push`.
3. Common causes:
   - PostgreSQL not running
   - `DATABASE_URL` not set in `.env`
   - Tables not created — run `bun run db:push`
   - Wrong password in the connection string
   - Firewall blocking port 5432

### "relation \"products\" does not exist"

You haven't pushed the schema. Run:
```bash
bun run db:push
```

### Records are syncing but the badge still shows "pending"

This usually means the server returned `success: false` with partial errors. Check the **Settings & Backup → Hybrid Sync** panel for the "Last error" message — it will show which specific records failed and why.

### Lost internet during a sync

No problem — the SyncService is single-flight and idempotent. Records that were already pushed will not be re-pushed (they're marked `isSynced=true`), and the interrupted records will retry on the next online event.

---

## 11. Multi-Device Setup

The v5 sync is **push-only** (client → server). To set up a second device:

1. On Device A: go to **Settings & Backup → Download Full Backup (.json)**.
2. Move the `.json` file to Device B (e.g. via email, USB, cloud drive).
3. On Device B: open the app, go to **Settings & Backup → Choose backup file & Restore**, upload the JSON.
4. Restored records are marked `isSynced=false` on Device B.
5. Device B will automatically push all records to PostgreSQL (duplicates are upserted, no conflict).
6. From this point, both devices can operate independently — their writes will queue locally and push to PostgreSQL.

**Note**: True pull sync (server → client, real-time) is a future enhancement. For now, to sync from Device B back to Device A, you'd need to export from B and re-import on A, OR query PostgreSQL directly.

---

For architecture details, see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.
For the full changelog, see **[CHANGELOG.md](./CHANGELOG.md)**.
