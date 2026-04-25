# BigAvatar Cloud Server

Production-grade avatar server for Minecraft (Figura mod) with WebSocket real-time sync, Redis clustering, and enterprise stability features.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your settings
npm run dev
```

## Build & Run

```bash
npm run build   # Compile TypeScript → dist/
npm start       # Run compiled server
npm run dev     # Run with ts-node (development)
```

## Environment Variables

See `.env.example` for all options. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `80` | HTTP port |
| `REDIS_URL` | *(none)* | Redis connection URL (optional — runs single-node without it) |
| `SERVER_ZONE` | `TH` | Server zone: `TH`, `SG`, `JP` |
| `DISCORD_WEBHOOK_URL` | *(none)* | Discord webhook for alerts |
| `DASHBOARD_PASS` | `admin123` | Password for `/api/server-stats` |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `UPLOAD_MAX_FILE_SIZE_BYTES` | `10485760` | Max avatar file size (10 MB) |
| `WS_MAX_CONNECTIONS` | `10000` | Max concurrent WebSocket connections |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown drain timeout |

## API Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (200 healthy, 503 degraded) |
| `GET` | `/api/motd` | Server MOTD message |
| `GET` | `/api/version` | Server version |
| `GET` | `/api/limits` | Upload/rate limits |
| `GET` | `/api/auth/id?username=<name>` | Get auth server ID |
| `GET` | `/api/auth/verify?id=<sid>` | Verify with Mojang, get token |
| `GET` | `/api/:uuid` | Avatar metadata JSON |
| `GET` | `/api/:uuid/avatar` | Avatar binary file |

### Authenticated (requires `token` header)

| Method | Path | Description |
|---|---|---|
| `PUT` | `/api/avatar` | Upload avatar |
| `DELETE` | `/api/avatar` | Delete avatar |
| `POST` | `/api/equip` | Broadcast equip event |

### Admin

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/server-stats?pass=<password>` | Server statistics |
| `GET` | `/admin/bans` | List active bans |
| `DELETE` | `/admin/bans/:clientId` | Lift a ban |

## Health Endpoint

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "memory": { "heapUsed": 52428800, "heapTotal": 134217728 },
  "cpu": { "loadAvg": [0.5, 0.4, 0.3] },
  "disk": { "freeBytes": 10737418240, "status": "healthy" },
  "redis": { "status": "healthy", "latencyMs": 1 },
  "websocket": { "activeConnections": 42 },
  "upload": { "pendingCount": 3 }
}
```

Returns `200` when healthy, `503` when any subsystem is degraded or unhealthy.

## Running Tests

```bash
npm run test:run   # Run all tests once (CI)
npm test           # Run in watch mode
```

Test coverage: 118 tests across 15 suites covering all 10 stability requirements.

## Architecture

The server is split into focused modules under `src/`:

- `config.ts` — Environment validation, typed config
- `log-manager.ts` — Winston + daily rotation + gzip compression
- `lru-cache.ts` — O(1) LRU cache with TTL
- `redis-client.ts` — ioredis wrapper with exponential backoff reconnect
- `rate-limiter.ts` — Per-user rate limiting with Redis fallback
- `anti-spam.ts` — Auto-ban system with Redis-backed storage
- `ws-manager.ts` — WebSocket heartbeat, connection limits, message rate
- `upload-pipeline.ts` — Stream-based upload with MIME validation
- `temp-file-cleaner.ts` — Background temp file cleanup
- `health-monitor.ts` — Cached health metrics, disk/Redis/memory checks
- `graceful-shutdown.ts` — Signal handling, in-flight request drain
- `server.ts` — Main entry point, wires all modules

## Stability Features

- **Memory bounded** — LRU caches with TTL, token/socket cleanup on GC
- **WebSocket hardened** — Ping/pong heartbeat, pong timeout, connection limit, message rate limit
- **Upload reliable** — Atomic rename, stream error cleanup, MIME validation
- **Redis resilient** — Exponential backoff reconnect, in-process fallback
- **Rate limiting** — Per-user (not just IP), Redis-backed, proper 429 headers
- **Graceful shutdown** — Drains in-flight requests, closes WS with code 1001
- **Health monitoring** — Cached metrics, disk/Redis/memory checks every 15s
- **Log rotation** — Daily + size-based rotation, gzip compression, 14-file retention
- **Anti-spam** — Escalating bans, Redis-backed, admin management endpoints
- **Error handling** — uncaughtException, unhandledRejection, async Express errors
