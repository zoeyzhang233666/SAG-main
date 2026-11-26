# SAG V1 standalone desktop preview

Independent from SAG-main-V2. Electron packaging uses the V2 dependency lock as its starting point; no V2 application code or database is used.

- macOS Apple Silicon DMG / Windows x64 NSIS EXE. Artifacts are uploaded only after native preflight, installer creation and actual packaged launch/write/restart tests.
- First launch initializes PostgreSQL 16 + pgvector, pg_trgm and unaccent under the independent SAG-V1 data directory. No system Node, Docker or PostgreSQL is needed; Electron's Node runtime starts the existing Fastify server.
- Desktop HTTP binds only to loopback and requires a per-launch header. The ordinary web/server deployment is unchanged when desktop authorization is not configured.
- Data is stored under ~/Library/Application Support/SAG-V1 on macOS or %APPDATA%\SAG-V1 on Windows. Back up postgres-data and postgres-password together with the app closed. Do not delete during upgrades.
- Existing server data is not copied automatically; use existing structured import/export workflows.
- No knowledge data or API credentials bundled. Set AI provider credentials for remote AI functions.
- macOS ad-hoc signing, no notarization; Windows unsigned preview. No automatic updates. Windows 10 and physical-device testing remain necessary.
- The ordinary web UI and MCP-related features remain intact; a separate external MCP service is not started automatically.

Do not merge or publish before both packaged launch tests pass. The original license is retained; publication authorization and licensing must be verified separately.
