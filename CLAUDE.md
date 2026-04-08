# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Boundless Official Marketplace** - a collection of demo applications for the Boundless platform. It contains sample apps demonstrating various capabilities like MCP (Model Context Protocol) servers, BI dashboards, and operations consoles.

## Build Commands

### mcp-demo App (TypeScript)

Located in `apps/mcp-demo/`. This is the only app requiring a build step.

```bash
cd apps/mcp-demo
npm install
npm run build
```

The build uses esbuild to bundle `src/main.ts` into `main.bundle.cjs` (Node 18 target).

### Other Apps

- `apps/chart-demo/` - Pure JavaScript, no build step
- `apps/ops-console/` - Pure JavaScript, no build step
- `apps/bi-dashboard/` - Pure JavaScript, no build step (though it has a bundle config, the entry point is `main.js`)

## Architecture

### App Structure

Each app in `apps/` is a self-contained Boundless application with:

- **`manifest.json`** - App metadata, permissions, and entry point configuration
- **`main.js`** (or bundled `.cjs`) - Server entry point
- **`index.html`** - Frontend entry (referenced in manifest, served by Boundless host)
- **`bundle.config.json`** - Optional esbuild configuration for TypeScript apps

### Boundless App Model

Apps run as HTTP servers within the Boundless platform:

- **Port**: Read from `BOUNDLESS_APP_PORT` environment variable (falls back to app-specific defaults)
- **Host**: Always bind to `127.0.0.1`
- **Protocol**: REST API with CORS headers for cross-origin requests

### Permission System

Apps declare permissions in `manifest.json`:

- `"env:read"` / `"env:write"` - Access to environment variables
- `"mcp:server"` - App implements an MCP server endpoint

### MCP Demo App (`mcp-demo`)

Special implementation using the Model Context Protocol SDK:

- **Transport**: `StreamableHTTPServerTransport` over HTTP
- **Endpoint**: `/mcp` (GET/POST/DELETE for session management)
- **Session Handling**: UUID-based session IDs via `mcp-session-id` header
- **Tools Exposed**: `list_tasks`, `add_task`, `complete_task`
- **Additional Routes**: `/health`, `/api/tasks`

The MCP server maintains in-memory session state and supports the full MCP initialization flow.

### BI Dashboard App (`bi-dashboard`)

Connects to a MySQL database (Lingbo e-commerce platform schema):

- **Required Env Vars**: `LING_BO_DB_HOST`, `LING_BO_DB_USER`, `LING_BO_DB_NAME`
- **Optional**: `LING_BO_DB_PASSWORD`, `LING_BO_DB_PORT` (default 3306)
- **Queries**: Order metrics, refund data, account summaries, product/store rankings

Database schemas referenced:
- `lingbo_base.ecp_order` / `ecp_order_item` / `ecp_product_spu`
- `lingbo_base.ecp_order_after_sale`
- `lingbo_funds.ecp_account`

### Ops Console App (`ops-console`)

A simulation/toy operations dashboard with mock data:

- Auto-drifts state every 8 seconds (simulates time passing)
- Action endpoints: `/api/actions/assign-next`, `/api/actions/run-playbook`, `/api/actions/resolve-oldest`, `/api/actions/reset`
- Returns full dashboard state on each action

### Marketplace Registry

`marketplace.json` at root defines the marketplace metadata and lists available apps.

## Development Notes

- No test framework is configured
- No linting (ESLint/Prettier) is configured
- Apps use native Node.js `http` module or Express (for MCP apps)
- CORS headers are manually set on all responses for cross-origin access from the Boundless host
