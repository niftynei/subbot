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

Build the frontend locally:

```sh
cd web
npm run build
```

Serve API and static assets from Go:

```sh
DATABASE_PATH=data/subbot.sqlite STATIC_DIR=web/dist PORT=8080 go run ./cmd/server
```

For container deploys, the root `Dockerfile` builds both the Vite frontend and Go backend. It copies `web/dist` into the runtime image at `/app/web/dist`, so the Go server can serve the frontend.

Build locally with:

```sh
docker build \
  --build-arg VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com \
  -t subbot .
```

Run locally with SQLite:

```sh
docker run --rm -p 8080:8080 subbot
```

## DigitalOcean App Platform

Use the repository root `Dockerfile` for the service. App Platform must receive `VITE_GOOGLE_CLIENT_ID` as a build-time argument or build-time environment variable so Vite can compile it into the frontend.

In the App Platform app spec, the service must use the repository root as its source directory and set the Dockerfile path explicitly:

```yaml
services:
  - name: subbot
    source_dir: /
    dockerfile_path: Dockerfile
```

If deploy logs mention framework detection, buildpacks, or parsing `go.mod`, the service is not using this Dockerfile. A buildpack deploy can compile the Go server without building `web/dist`, which causes the runtime error `frontend is not built`.

Attach a PostgreSQL database and expose its connection string as `DATABASE_URL`.

Recommended App Platform environment variables:

- `VITE_GOOGLE_CLIENT_ID`: build-time. Public Google OAuth web client ID. Also pass this as a Docker build arg if App Platform separates build args from env vars.
- `DATABASE_URL`: run-time. Bind this to the attached Postgres database connection string.
- `STATIC_DIR`: run-time, optional. Defaults to `/app/web/dist` in the Docker image.
- `PORT`: run-time, optional. Defaults to `8080`; App Platform may set this for the service.

Do not set `DATABASE_PATH` in production unless you intentionally want ephemeral SQLite storage. Do not set or expose a Google OAuth client secret; this browser OAuth flow does not use one.

## API

- `GET /api/health`
- `POST /api/scans`
- `GET /api/scans/latest?account_hash=<sha256>`
- `POST /api/unsubscribe/bulk`

Bulk unsubscribe only sends confirmed HTTPS one-click unsubscribe requests. Mailto unsubscribe entries are marked as manual.
