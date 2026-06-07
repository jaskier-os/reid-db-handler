#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Wait for MongoDB replica set if not ready yet
echo "[reid-db-handler] Waiting for MongoDB..."
elapsed=0
until docker exec reid-mongodb mongosh --quiet --eval 'rs.status().ok' 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $elapsed -ge 120 ]; then
        echo "[reid-db-handler] ERROR: MongoDB not ready after 120s"
        exit 1
    fi
done
echo "[reid-db-handler] MongoDB is ready"

echo "[reid-db-handler] Installing dependencies..."
npm install --silent

echo "[reid-db-handler] Starting..."
exec node src/index.js
