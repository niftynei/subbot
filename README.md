# Subbot

Subbot is a Gmail-first subscription auditor. The browser fetches up to 5,000 Gmail messages from the last 12 months, caches fetched messages locally in IndexedDB, finds unsubscribe headers and body links locally, groups recurring senders, and sends only aggregate subscription records to a Go API backed by SQLite locally or Postgres in production. Large scans are intentionally paced to stay under Gmail's per-user API limits.

## Development

Enter the dev shell:

```sh
nix develop
```

If you are using non-flake Nix:

```sh
nix develop -f shell.nix
```

Install frontend dependencies:

```sh
cd web
npm install
```

Run the backend from the repository root:

```sh
go run ./cmd/server
```

Run the frontend in another shell:

```sh
cd web
npm run dev
```

Open `http://127.0.0.1:5173`.

## Google OAuth

Create a Google OAuth web client and allow the Vite origin, usually `http://127.0.0.1:5173`. The browser requests the Gmail readonly scope so it can find unsubscribe links in message bodies:

```text
https://www.googleapis.com/auth/gmail.readonly
```

You can set the client ID in `web/.env.local`:

```sh
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
```

## Data Model

The backend stores:

- scans by account hash
- aggregate subscription rows
- unsubscribe attempt audit records

The backend does not store message bodies, attachments, or full raw Gmail payloads. The browser uses IndexedDB as a local-only cache for fetched Gmail message payloads so interrupted or repeated scans can avoid refetching the same message IDs. Clearing site data for the app deletes that cache.

Local development uses SQLite by default:

```sh
DATABASE_PATH=data/subbot.sqlite
```

Production can use Postgres by setting:

```sh
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require
```

When `DATABASE_URL` is present, the Go server uses Postgres. Otherwise it falls back to SQLite.

## Production Build

Build the frontend:

```sh
cd web
npm run build
```

Serve API and static assets from Go:

```sh
DATABASE_PATH=data/subbot.sqlite STATIC_DIR=web/dist go run ./cmd/server
```

On DigitalOcean App Platform, attach a PostgreSQL database and expose its connection string as `DATABASE_URL`. The server also accepts DigitalOcean's `PORT` env var when `ADDR` is not set.

## API

- `GET /api/health`
- `POST /api/scans`
- `GET /api/scans/latest?account_hash=<sha256>`
- `POST /api/unsubscribe/bulk`

Bulk unsubscribe only sends confirmed HTTPS one-click unsubscribe requests. Mailto unsubscribe entries are marked as manual.
