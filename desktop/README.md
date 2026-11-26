# SAG V1 standalone desktop: build preflight

This is the first stage, not a desktop release. Keep the existing React/Fastify/TypeScript application and PostgreSQL 16 + pgvector data model. The native matrix builds PostgreSQL 16.16 and pgvector 0.8.7 from pinned official upstream commits and exercises V1 migrations and vector persistence in a relocated temporary runtime. It does not publish any installers or real business data.

Remaining release gates:
- Electron desktop launcher with a packaged, self-contained database and Node runtime; no Docker or external PostgreSQL required.
- Runtime relocation and dependency/signature verification on actual DMG and NSIS EXE.
- Separate app identity and durable user data directory; authenticated loopback PostgreSQL, per-install credentials, graceful shutdown and no destructive migration.
- Retain existing UI, structured import/export, search, settings and MCP; test API and large-file import, launch and restart using packaged application.
- Reproducible dependency lockfiles, third-party license notices, no real databases or credentials in installers.
- Both architecture checks and package smoke tests must pass before versioned GitHub prerelease with checksums.
