# Ghost Example

Instruments a local [Ghost](https://ghost.org/) CMS instance with `opinionated-telemetry`, demonstrating:

- Honeycomb trace + metric export via `honeycombInit`
- Auto-instrumentation of Ghost's `core/server/services` directory
- Knex integration for query enrichment
- Conditional span dropping for low-level net/dns/tcp spans
- Express middleware layer filtering

## Prerequisites

- Node.js 22+
- A [Honeycomb](https://www.honeycomb.io/) API key (free tier works)

## Setup

1. Create a `.env` file in this directory:

```
HC_API_KEY=your-honeycomb-api-key
```

2. Run the dev script:

```bash
./dev.sh
```

This will:

- Build `opinionated-telemetry` from source
- Install Ghost locally (via `ghost-cli`) into `ghost-app/` if not already present
- Install dependencies
- Start Ghost with telemetry instrumentation enabled (with `--watch` for live reload)

To do a clean reinstall of Ghost, run:

```bash
./dev.sh --clean
```

## How it works

[`telemetry.mts`](./telemetry.mts) is loaded via `--import` before Ghost starts. It:

1. Calls `honeycombInit()` with auto-instrumentations and custom hooks
2. Sets up CJS auto-instrumentation for Ghost's service layer
3. Wires up `otelInitKnex` after Ghost boots to enrich database spans

Ghost runs on `http://localhost:2368` by default.
