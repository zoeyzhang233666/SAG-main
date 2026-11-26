# SAG V1 independent desktop preview

The installers run this repository's original React UI and Fastify backend. Electron provides the Node.js runtime. PostgreSQL 16, pgvector, pg_trgm and unaccent ship with each installer. Normal startup needs no Docker or system Node.js/PostgreSQL. AI provider settings work through the existing V1 UI.

SAG V1 uses the bundle ID `com.chemclaw.sag.v1` and application data directory `SAG-V1` under `~/Library/Application Support` on macOS or `%APPDATA%` on Windows. Running the development launcher uses `SAG-V1-Development`. V2 uses `com.chemclaw.knowledgegraph` and its own `ChemClaw Knowledge Graph` data directory.

First launch creates a password-protected, loopback-only database and seeds the default entity types. Every launch checks the data directory version and applies pending V1 migrations before starting the local API. The renderer uses a stable app origin and the main process forwards requests through an authenticated loopback connection. Closing the app stops the backend and database. Installer upgrades and Windows uninstall preserve the V1 data directory. To back up a closed app, keep the whole `SAG-V1` directory together. Use V1 structured import/export to move existing V1 server data into a desktop project.

## Build and verify

The [Desktop installers workflow](../.github/workflows/desktop-preflight.yml) contains the native PostgreSQL and pgvector build commands. Run them from the repository root, placing the source trees in `pg-source` and `pgvector-source` and the installation in `postgres-runtime`. Then run these commands with Node.js 22.23.5.

```sh
npm ci
npm run typecheck
npm test
npm run build
node desktop/scripts/smoke-db.mjs
npm ci --prefix desktop
node desktop/scripts/stage.mjs
npm ci --omit=dev --prefix desktop/build/resources/backend
node desktop/scripts/smoke-app.mjs --source
```

From the `desktop` directory, run `npm run package -- --mac --arm64` on Apple Silicon or `npm run package -- --win --x64` on Windows x64. Install the resulting package and run `node desktop/scripts/smoke-app.mjs "/path/to/installed/executable"` from the repository root. The smoke test submits a V1 structured import, verifies stored documents and graph relationships, opens the Hypergraph tab, then checks the same records and browser preferences after restart. Each run checks that PostgreSQL and the backend exit. GitHub Actions uploads the tested installers and SHA256 files.

The preview uses ad-hoc signing on macOS and an unsigned Windows installer. Production code signing and macOS notarization require release credentials. The original V1 license is included.
