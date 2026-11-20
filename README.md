# Antigravity Vitals

A zero-dependency, native **Antigravity 2.0 Sidecar UI plugin** mounted in the right-hand Auxiliary Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for live conversation telemetry:

- **Pure Decode TPS & E2E TPS**: Reads millisecond `time_to_first_token` (TTFT) and `streaming_duration` directly from Antigravity's local SQLite `gen_metadata` protobuf blobs via Node's built-in `node:sqlite`, using time-weighted ratio-of-sums averages and buffered single-chunk burst protection.
- **Warm vs. Cold TTFT**: Splits cached hits vs. cold prefills and reports exact cache speedup ratio.
- **Prompt Cache Hit Rate & Drop Alerts**: Tracks cumulative & per-turn cache hit ratio and alerts immediately when a warm session suffers a sudden cache drop.
- **Context Utilization & Real Breakdown**: Reads the exact model context limit and message/section/tool token snapshot from `gen_metadata` to render a 100-cell context matrix and per-category breakdown (Tool Outputs, System Prompt/Skills/Rules, Assistant/Thinking, Tool/MCP Definitions, User Messages).
- **Automatic Fallback**: If a conversation's SQLite DB is missing or its schema ever changes, automatically falls back to `transcript.jsonl` with exact tokens/cache and E2E TPS.
- **Native Host Theming**: Syncs automatically with Antigravity's light/dark CSS tokens via `/preload.js` with zero external CDN dependencies.

## Install

```bash
./scripts/install.sh
```

This symlinks the repository into `~/.gemini/config/plugins/antigravity-vital`. Antigravity discovers it automatically without restarting.

## Development & Tests

Requires Node.js >= 22.5 (for built-in `node:sqlite` and `node:test`). Zero `npm install` needed.

```bash
cd sidecars/vitals
npm test
```

Run standalone preview outside Antigravity:

```bash
PORT=4321 node sidecars/vitals/main.mjs
# Open http://127.0.0.1:4321/?conversationId=<your-conversation-id>
```

## Architecture

```text
antigravity-vital/
├── plugin.json                        # Antigravity plugin manifest
├── assets/logo.svg                    # Plugin icon
├── scripts/install.sh                 # Symlink installer to ~/.gemini/config/plugins/
└── sidecars/vitals/
    ├── sidecar.json                   # SIDECAR_UI_ENTRYPOINT_AUX_PANE registration
    ├── main.mjs                       # sidecar_sdk server + standalone HTTP shim
    ├── lib/
    │   ├── protobuf.mjs               # Zero-dependency protobuf wire reader
    │   ├── data-dir.mjs               # App data dir resolver & WAL-aware ETag fingerprint
    │   ├── sqlite-reader.mjs          # Option A: read-only node:sqlite gen_metadata reader
    │   ├── transcript-reader.mjs      # Fallback: transcript.jsonl reader
    │   ├── metrics.mjs                # Pure telemetry calculation engine
    │   └── vitals-service.mjs         # ETag-cached telemetry facade
    ├── public/
    │   ├── index.html                 # Auxiliary pane layout (/preload.js bridge)
    │   ├── styles.css                 # Host-token-aware light/dark stylesheet
    │   └── app.js                     # Polling, SVG charts, turns ledger & 100-cell matrix
    └── test/                          # Unit & API integration tests (node:test)
```
