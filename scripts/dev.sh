#!/bin/bash

# ============================================================================
# FMCG ERP — Development Server Startup Script (npm-based, no Bun required)
# ----------------------------------------------------------------------------
# Works on Linux, macOS, and Windows (Git Bash / WSL / MSYS2).
# Requires: Node.js 18+, npm, and optionally curl for health checks.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step_start() {
        local step_name="$1"
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting: $step_name"
        echo "=========================================="
        export STEP_START_TIME
        STEP_START_TIME=$(date +%s)
}

log_step_end() {
        local step_name="${1:-Unknown step}"
        local end_time
        end_time=$(date +%s)
        local duration=$((end_time - STEP_START_TIME))
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Completed: $step_name"
        echo "[LOG] Step: $step_name | Duration: ${duration}s"
        echo "=========================================="
        echo ""
}

start_mini_services() {
        local mini_services_dir="$PROJECT_DIR/mini-services"
        local started_count=0

        log_step_start "Starting mini-services"
        if [ ! -d "$mini_services_dir" ]; then
                echo "Mini-services directory not found, skipping..."
                log_step_end "Starting mini-services"
                return 0
        fi

        echo "Found mini-services directory, scanning for sub-services..."

        for service_dir in "$mini_services_dir"/*; do
                if [ ! -d "$service_dir" ]; then
                        continue
                fi

                local service_name
                service_name=$(basename "$service_dir")
                echo "Checking service: $service_name"

                if [ ! -f "$service_dir/package.json" ]; then
                        echo "[$service_name] No package.json found, skipping..."
                        continue
                fi

                if ! grep -q '"dev"' "$service_dir/package.json"; then
                        echo "[$service_name] No dev script found, skipping..."
                        continue
                fi

                echo "Starting $service_name in background..."
                (
                        cd "$service_dir"
                        echo "[$service_name] Installing dependencies..."
                        npm install
                        echo "[$service_name] Running npm run dev..."
                        exec npm run dev
                ) >"$PROJECT_DIR/.zscripts/mini-service-${service_name}.log" 2>&1 &

                local service_pid=$!
                echo "[$service_name] Started in background (PID: $service_pid)"
                echo "[$service_name] Log: $PROJECT_DIR/.zscripts/mini-service-${service_name}.log"
                disown "$service_pid" 2>/dev/null || true
                started_count=$((started_count + 1))
        done

        echo "Mini-services startup completed. Started $started_count service(s)."
        log_step_end "Starting mini-services"
}

wait_for_service() {
        local host="$1"
        local port="$2"
        local service_name="$3"
        local max_attempts="${4:-60}"
        local attempt=1

        echo "Waiting for $service_name to be ready on $host:$port..."

        while [ "$attempt" -le "$max_attempts" ]; do
                if curl -s --connect-timeout 2 --max-time 5 "http://$host:$port" >/dev/null 2>&1; then
                        echo "$service_name is ready!"
                        return 0
                fi

                echo "Attempt $attempt/$max_attempts: $service_name not ready yet, waiting..."
                sleep 1
                attempt=$((attempt + 1))
        done

        echo "ERROR: $service_name failed to start within $max_attempts seconds"
        return 1
}

cleanup() {
        if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
                echo "Stopping Next.js dev server (PID: $DEV_PID)..."
                kill "$DEV_PID" >/dev/null 2>&1 || true
        fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

# ---- Check that Node.js + npm are available ----
if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: Node.js is not installed or not in PATH"
        echo "Install from https://nodejs.org (LTS version recommended)"
        exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
        echo "ERROR: npm is not installed or not in PATH"
        echo "npm comes bundled with Node.js — install from https://nodejs.org"
        exit 1
fi

echo "Using Node.js: $(node --version)"
echo "Using npm: $(npm --version)"

# ---- Install dependencies ----
log_step_start "npm install"
echo "[NPM] Installing dependencies..."
npm install
log_step_end "npm install"

# ---- Generate Prisma client ----
log_step_start "npx prisma generate"
echo "[NPM] Generating Prisma client..."
npx prisma generate || echo "[NPM] WARNING: prisma generate failed. The ERP UI will still work (IndexedDB is the primary DB)."
log_step_end "npx prisma generate"

# ---- Push database schema to PostgreSQL (non-fatal if unreachable) ----
log_step_start "npx prisma db push"
echo "[NPM] Setting up database (optional — will skip if PostgreSQL unreachable)..."
npx prisma db push || echo "[NPM] WARNING: db:push failed (PostgreSQL may be unreachable or not configured). Continuing — the ERP works offline-first via IndexedDB."
log_step_end "npx prisma db push"

# ---- Start Next.js dev server ----
log_step_start "Starting Next.js dev server"
echo "[NPM] Starting development server..."
npm run dev &
DEV_PID=$!
log_step_end "Starting Next.js dev server"

# ---- Wait for dev server to be ready ----
log_step_start "Waiting for Next.js dev server"
wait_for_service "localhost" "3000" "Next.js dev server"
log_step_end "Waiting for Next.js dev server"

# ---- Health check ----
log_step_start "Health check"
echo "[NPM] Performing health check..."
if command -v curl >/dev/null 2>&1; then
        curl -fsS localhost:3000 >/dev/null
        echo "[NPM] Health check passed"
else
        echo "[NPM] curl not found — skipping health check (server should be running)"
fi
log_step_end "Health check"

# ---- Start any mini-services ----
start_mini_services

echo ""
echo "=============================================="
echo "  FMCG ERP is running at http://localhost:3000"
echo "  PID: $DEV_PID"
echo "  To stop: kill $DEV_PID"
echo "=============================================="
echo ""

disown "$DEV_PID" 2>/dev/null || true
unset DEV_PID