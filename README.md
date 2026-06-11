# reid-db-handler

> **Docs & wiki:** [github.com/jaskier-os/docs/wiki](https://github.com/jaskier-os/docs/wiki)

Koa HTTP API over MongoDB for person re-identification data (persons, traits,
sightings). It's the only thing that talks to the database directly; reid-worker
and reid-analytics go through this API. Similarity search and auto-merge run in a
Python FAISS subprocess (`faiss_server.py`) that the Node process spawns. Listens
on port 3001.

## Build / run

Local dev (needs Node 18+ and a MongoDB replica set):

```bash
npm install
cp .env.example .env   # then edit MONGODB_URI and API_KEY
npm run dev            # nodemon
npm start              # plain node
npm test               # node --test
```

Docker:

```bash
docker build -t reid-db-handler .
```

The image installs Node deps with `npm ci --omit=dev` plus Python 3 and the
FAISS deps from `requirements.txt` for the subprocess. Exposes 3001 with a
healthcheck. CI builds the Dockerfile and bumps the image tag in the deploy repo.

## Configuration

Config comes from env vars, validated by Joi at startup. `.env.example` is the
source of truth; copy it to `.env` and edit. The two required ones:

- `MONGODB_URI` - full connection string. A replica set is required, e.g.
  `mongodb://localhost:27017/repository_reid?replicaSet=rs0`.
- `API_KEY` - shared secret checked on every request via the `x-api-key` header
  (or `Authorization: Bearer <key>`).

Optional: `PORT` (3001), `LOG_LEVEL`, `SIMILARITY_MAX_WORKERS`,
`AUTO_MERGE_ENABLED`, `AUTO_MERGE_THRESHOLD`, `MERGE_WEBHOOK_URL`.

## Dependencies

- Node 18+, ES modules. Koa + koa-router, Mongoose, Joi, Winston.
- MongoDB running as a replica set (the API uses replica-set features).
- Python 3 with the pinned FAISS deps in `requirements.txt`, used by the
  `faiss_server.py` subprocess for similarity search. Kept consistent with
  reid-worker.
