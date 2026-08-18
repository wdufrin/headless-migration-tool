# Gemini Enterprise Admin Migration Tool (`gemini-migrate`)

Enterprise admin-driven headless tool and service for migrating Gemini Enterprise custom agents, notebooks, notes, sources, datastores, and associated IAM permissions across GCP environments on behalf of users.

---

## Architecture & InfoSec Compliance

Built specifically to satisfy the **Gemini Enterprise Admin Migration Report** (Security Review & Requirements EAI 3542282), this tool implements all required security controls:

- **Mitigation #1: SSRF Prevention** — Strict GCP region allowlisting (`global`, `us`, `eu`, `us-central1`, etc.) and regex validation on all project/engine/datastore IDs.
- **Mitigation #2: Server-Side Token Authentication** — Verifies Google OAuth Bearer tokens via `tokeninfo` and validates authorized corporate email domains (`@fedex.com`).
- **Mitigation #3: CORS Lockdown** — Restricted to authorized internal origin.
- **Mitigation #4: Header-Only Token Transport** — Tokens are passed strictly via HTTP `Authorization: Bearer` headers; zero tokens in JSON request bodies.
- **Mitigation #5: NetworkPolicy Isolation** — Hardened ingress and outbound HTTPS egress allowlist.
- **Mitigation #6 & #8: Hardened Container Runtime** — Runs as non-root (`UID 1000`), read-only root filesystem, with explicit CPU/Memory limits.
- **Mitigation #7: Zero Secrets in Git** — Environment and secrets resolved via runtime environment / GCP Secret Manager.

---

## Quick Start (CLI Mode)

### 1. Installation
```bash
npm install
npm run build
```

### 2. Run Dry Run (Simulation)
```bash
npx tsx src/cli.ts --config config.example.json --dry-run
```

### 3. Execute Live Batch Migration on Behalf of Users
```bash
# Migrate all assets for specific users
npx tsx src/cli.ts --config config.example.json --users "john.doe@fedex.com" "jane.doe@fedex.com"

# Migrate all organization assets with concurrency 15
npx tsx src/cli.ts --config config.example.json --concurrency 15
```

---

## Admin Web UI Console

Launch the interactive web dashboard to configure migrations, track progress live, review audit certificates, and manage target environments:

```bash
npm run ui
# or
npx tsx src/server.ts
```

Open your browser to: **`http://localhost:8080`**

### Features:
- 🚀 **Migration Studio**: Interactive configuration builder, agent type filter (`Low-Code`, `ADK`, `A2A`, `ALL`), Dry Run simulation toggle, and Domain-Wide Delegation (DWD) key selection.
- ⚡ **Live Progress Tracker**: Real-time progress bar, milestone stage trackers (Pre-flight, Discovery, Notebooks, Agents), and live color-coded streaming log console.
- 📊 **Audit Report & Analytics**: Summary metrics (Total Migrated, Duration, Failures), searchable asset data table with owner identity verification, and one-click **Markdown (`.md`)** & **JSON (`.json`)** export.
- 📁 **Historical Runs Archive**: Browse and inspect past migration certificates stored on disk.
- 🧹 **Target Maintenance Utility**: One-click cleanup to safely reset destination notebooks and custom agents before new migration runs.

---

## Running as an Admin Service (REST API)

### Start Server
```bash
npm start
```

### Endpoints
- `GET /`: Serves the Admin Web UI Console.
- `POST /api/preflight`: Executes pre-flight validation on target project, engine, and datastore mappings.
- `POST /api/migrate`: Executes the full admin migration pipeline.
- `GET /api/reports`: Lists all past migration run reports and summaries.
- `GET /api/reports/:id`: Retrieves full details and telemetry for a specific migration run.
- `POST /api/cleanup`: Clears target engine agents and destination notebooks.
- `GET /api/users`: Discovers active creators via BigQuery audit logs.
- `GET /healthz`: Kubernetes liveness / readiness probe.

---

## Configuration Schema (`migration-config.json`)

```json
{
  "source": {
    "projectId": "gemini-enterprise-test",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "ge-chat-engine",
    "assistantId": "default_assistant"
  },
  "target": {
    "projectId": "gemini-enterprise-prod",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "ge-chat-engine-prod",
    "assistantId": "default_assistant"
  },
  "options": {
    "migrateNotebooks": true,
    "migrateAgents": true,
    "dryRun": false,
    "concurrency": 10,
    "userFilter": ["*@fedex.com"],
    "preserveOwnership": true
  },
  "datastoreMapping": {
    "test-hr-policy-ds": "prod-hr-policy-ds"
  },
  "identityMapping": {
    "user:john.doe@test-tenant.com": "user:john.doe@fedex.com"
  }
}
```

---

## Running Tests

```bash
npm test
```
