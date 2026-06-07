# Person ReID Traits Database Handler

Node.js (Koa) API server for managing person re-identification data: persons,
biometric traits (face/gait embeddings), sightings, similarity scoring, and
OSINT assets. Data is persisted in MongoDB. A companion FAISS subprocess
(Python) provides fast vector similarity search over face embeddings.

## Features

- RESTful API for persons, traits, sightings, similarity, and OSINT assets
- MongoDB persistence via Mongoose
- FAISS-backed vector similarity search (512-dim embeddings)
- Background similarity processor with optional auto-merge of duplicate persons
- API-key authentication
- Request logging (Winston), health check, graceful shutdown

## Prerequisites

- Node.js 20+
- MongoDB 7 running as a replica set (a single-node replica set is fine)
- Python 3 with the FAISS dependencies (see `requirements.txt`) for similarity
  search. If Python/FAISS is unavailable the server still starts; similarity
  endpoints are simply disabled.

## Setup

1. Copy the example environment file and fill in the values:

   ```bash
   cp .env.example .env
   ```

   Variables:

   | Variable | Description |
   | --- | --- |
   | `PORT` | HTTP port the API listens on (default 3001) |
   | `NODE_ENV` | `development`, `production`, or `test` |
   | `MONGODB_URI` | MongoDB connection string. Replica set required. |
   | `API_KEY` | Shared secret required on every request. Use a strong random value. |
   | `LOG_LEVEL` | `error`, `warn`, `info`, or `debug` |
   | `SIMILARITY_MAX_WORKERS` | Parallel workers for the similarity processor (1-20) |
   | `AUTO_MERGE_ENABLED` | Auto-merge highly similar persons (true/false) |
   | `AUTO_MERGE_THRESHOLD` | Cosine-similarity threshold for auto-merge (0.4-1.0) |
   | `MERGE_WEBHOOK_URL` | Optional webhook notified on auto-merge. Empty disables it. |

2. Install Node dependencies:

   ```bash
   npm ci
   ```

3. (Optional, for similarity search) install the Python FAISS dependencies:

   ```bash
   python3 -m venv venv
   ./venv/bin/pip install -r requirements.txt
   ```

   If a `venv` exists at the project root, the app uses `./venv/bin/python`
   automatically; otherwise it falls back to `python3` on `PATH`.

## Database

Start a local single-node MongoDB replica set with Docker Compose:

```bash
docker-compose up -d
```

This launches `mongo:7` with `--replSet rs0`, exposes port 27017, and the
healthcheck initiates the replica set on first run. Point `MONGODB_URI` at it
(the default `.env.example` value already matches).

## Build and Run

This is a plain Node.js project; there is no compile step.

```bash
npm run dev    # development, auto-reload via nodemon
npm start      # production
npm test       # node --test
```

Or run inside Docker:

```bash
docker build -t reid-db-handler .
docker run --env-file .env -p 3001:3001 reid-db-handler
```

## Health Check

```bash
GET /health
```

Returns `200` with `{ "status": "healthy", ... }` when MongoDB is reachable,
otherwise `503`. This route requires no authentication.

## Authentication

All endpoints except `/health` require an API key:

```
x-api-key: <API_KEY>
```

or

```
Authorization: Bearer <API_KEY>
```

## API Endpoints

Root (`GET /`) returns the service descriptor and endpoint map:

- `GET /health` - health check (no auth)
- `/api/persons` - person management (GET, POST, PUT, DELETE)
- `/api/traits` - trait/embedding storage (GET, POST, DELETE, batch)
- `/api/sightings` - detection records (GET, POST, DELETE, batch)
- `/api/faiss` - direct FAISS index operations
- `/api/similarity` - similarity scoring and queries
- `/api/osint-assets` - OSINT asset management

Embeddings are 512-dimensional vectors transmitted as base64-encoded bytes.
Request bodies up to 10 MB are accepted for batch embedding uploads.

### Example: create a person

```bash
curl -X POST http://localhost:3001/api/persons \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Person_abc123"}'
```

## TLS / VPN

The server speaks plain HTTP and connects to MongoDB using whatever scheme is
in `MONGODB_URI`. No certificate or VPN is required to run it. To secure
transport, place it behind a reverse proxy (nginx, Caddy, etc.) that terminates
TLS, or use a `mongodb+srv://` / TLS-enabled `MONGODB_URI` if your MongoDB
deployment requires it. No certificate files are bundled with this repository.

## Project Structure

```
reid-db-handler/
├── src/
│   ├── index.js              # Main server + service lifecycle
│   ├── config.js             # Env config (Joi-validated)
│   ├── database.js           # MongoDB connection (Mongoose)
│   ├── logger.js             # Winston logger
│   ├── middleware/           # auth, error handling
│   ├── models/               # Mongoose schemas
│   ├── routes/               # HTTP route handlers
│   ├── services/             # FAISS, similarity queue/processor, merge
│   └── utils/                # geo helpers
├── faiss_server.py           # Python FAISS subprocess (stdin/stdout JSON)
├── requirements.txt          # Pinned Python deps for FAISS
├── database/                 # SQL seed reference + FAISS runtime dir
├── docker-compose.yml        # Local MongoDB replica set
├── Dockerfile
├── .env.example
└── README.md
```

## Notes

- `database/seed.sql` is legacy reference seed data from an earlier SQL-backed
  iteration and is not used by the current MongoDB implementation.
- The FAISS index (`database/faiss/`) is runtime state and is regenerated as
  faces are added; it is intentionally not committed.

## License

MIT
