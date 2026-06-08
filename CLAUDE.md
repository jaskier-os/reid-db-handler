# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

IMPORTANT: NEVER USE EMOJIS ANYWHERE IN LOGGING, CODE, OR OTHER TEXT.

IMPORTANT: Treat this codebase as work in progress. Never add backwards-compatibility
or legacy support unless explicitly asked. When a change may break a dependency, go
refactor every dependency rather than preserving the old path. Remove code that
becomes redundant.

## What this is

reid-db-handler is the Koa HTTP API over MongoDB for the ReID system. It is the
single source of truth for all reid and FAISS data in raw form: unique person ids,
metadata, traits (face/gait embeddings), sightings, relations, and OSINT assets.
Similarity search and auto-merge run in a Python FAISS subprocess
(`faiss_server.py`) that the Node process spawns. Listens on port 3001.

This is one of three tightly coupled ReID services. For the whole-system map (every
service, port map, architecture), see the orchestrator repo's CLAUDE.md / docs
(jaskier-os/orchestrator) rather than duplicating it here.

- **reid-db-handler** (this repo) -- only service that talks to the database directly.
- **reid-worker repo** -- recognizes people from camera feeds and POSTs new data here.
- **reid-analytics repo** -- backend reads from this API and aggregates for the
  frontend catalogue/sightings UI.

## Architecture rule (KEEP PROMINENT)

This service is the ONLY component allowed to connect to the database (MongoDB) and
to the FAISS subprocess directly. reid-worker and reid-analytics MUST go through this
HTTP API -- they never touch the DB. Do not add backdoors that let other services
bypass this API.

## Coupling rule

These three repos are bound by shared protocols, and this repo's schema is the root
of the dependency chain: reid-db-handler schema -> reid-analytics export -> frontend.
When you change a model, route, or wire format here, check the others before assuming
the contract holds. Concretely: if you change a person/sighting/trait schema or an
endpoint shape, inspect reid-analytics (its `reidService.js` proxies these endpoints,
`socketService.js` polls sightings) to confirm aggregation/export still works, and
inspect reid-worker to confirm it still POSTs the expected shape. A schema change here
almost always ripples through all three.

## Build / run

Needs Node 18+ and a MongoDB replica set (FAISS subprocess needs Python 3 +
`requirements.txt`).

```bash
npm install
cp .env.example .env   # then edit MONGODB_URI and API_KEY
npm run dev            # nodemon (src/index.js)
npm start              # plain node
npm test               # node --test
```

Docker: `docker build -t reid-db-handler .` (installs Node deps `npm ci --omit=dev`
plus Python 3 and FAISS deps for the subprocess; exposes 3001 with a healthcheck).

## Configuration

Env vars validated by Joi at startup; `.env.example` is the source of truth. Required:

- `MONGODB_URI` -- full connection string. A replica set is required, e.g.
  `mongodb://localhost:27017/repository_reid?replicaSet=rs0`.
- `API_KEY` -- shared secret checked on every request via the `x-api-key` header
  (or `Authorization: Bearer <key>`). The `/health` route is the only unauthenticated one.

Optional: `PORT` (3001), `LOG_LEVEL`, `SIMILARITY_MAX_WORKERS`, `AUTO_MERGE_ENABLED`,
`AUTO_MERGE_THRESHOLD`, `MERGE_WEBHOOK_URL`.

## Deploy

Deploy is via CI: commit + push, let GitLab CI build the Dockerfile and bump the
image tag in the deployment catalog repo. Never build/push the image by hand and
never edit Kubernetes deployments/env/secrets directly (`kubectl set env`/`edit`/
`patch`) -- those get overwritten by Flux. All deployed-service changes go through the
deployment catalog manifests. When changing `.env` values, update the corresponding
secrets in the deployment catalog too.

## Key files

- `src/index.js` -- Koa server entrypoint, graceful shutdown.
- `src/config.js` -- Joi-validated env config.
- `src/database.js` -- MongoDB connection.
- `src/middleware/` -- auth (API key) and friends.
- `src/models/` -- Mongoose schemas (persons, traits, sightings, relations, OSINT).
- `src/routes/` -- `persons.js`, `traits.js`, `sightings.js`, `similarity.js`,
  `faiss.js`, `osintAssets.js`, `health.js`.
- `src/services/` -- business logic, including spawning/managing the FAISS subprocess.
- `faiss_server.py` -- Python FAISS subprocess for similarity search + auto-merge.
  Kept consistent with the Node side; change both together.
- `database/seed.sql` -- seed data.

## Service management

Never restart any deployed service unless the user explicitly asks. When a restart is
needed, tell the user which service and why.

Do not write documentation unless asked to.
