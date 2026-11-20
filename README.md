# Antigravity Vitals

A zero-dependency, native **Antigravity 2.0 Sidecar UI plugin** mounted in the right-hand Auxiliary Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for live conversation telemetry:

- **Pure Decode TPS & E2E TPS**: Reads millisecond `time_to_first_token` (TTFT) and `streaming_duration` directly from Antigravity's local SQLite `gen_metadata` protobuf blobs via Node's built-in `node:sqlite`, using time-weighted ratio-of-sums averages and short-sample noise filtering (`<1.5s` or `<300 tok`) to avoid first-chunk buffering spikes.
- **Sub-Second Live Streaming Telemetry**: Monitors SQLite WAL-index (`-shm`) commit counters and in-progress `steps` (`status = 8` streaming / `status = 1,2` waiting TTFT or tool execution) at `350ms` active polling + `100ms` smooth client timers.
- **Tool Hotspots & Live Active Tools**: Tracks per-tool call counts, error counts, cumulative durations, and highlights currently running tools with live elapsed timers.
- **Prompt Cache Hit Rate & Drop Alerts**: Tracks cumulative & per-turn cache hit ratio, Warm vs. Cold TTFT comparison, and alerts immediately when a warm session suffers a sudden cache drop.
- **Context Utilization & Real Breakdown**: Reads the exact model context limit and message/section/tool token snapshot from `gen_metadata` to render a 100-cell context matrix and per-category breakdown.
- **Automatic Fallback, Native Theming & Bilingual UI (ZH / EN)**: Automatically falls back to `transcript.jsonl` if SQLite is unavailable, mirrors Antigravity's light/dark CSS tokens via `/preload.js`, auto-detects Chinese/English from the host/system locale (with one-click toggle), and suspends all polling when the pane is hidden (0% background CPU).

---

## Install (for Users / Friends)

Zero build step and zero `npm install` required (uses Antigravity's embedded Node >= 22.5 runtime).

### Option 1: Direct Git Clone (Recommended)

**macOS / Linux:**
```bash
git clone https://github.com/DefaWong/antigravity-vitals.git ~/.gemini/config/plugins/antigravity-vitals
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/DefaWong/antigravity-vitals.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-vitals"
```

Antigravity automatically discovers and enables the plugin under **Customizations → Plugins → Vitals** — open the right-hand Auxiliary Pane to view it immediately.

### Option 2: Local Dev Symlink

If you already cloned the repo elsewhere and want edits to reflect directly:

```bash
./scripts/install.sh
```

### Update / Uninstall

```bash
# Update (then toggle Vitals off & on once in Customizations to reload backend)
git -C ~/.gemini/config/plugins/antigravity-vitals pull

# Uninstall
rm -rf ~/.gemini/config/plugins/antigravity-vitals
```

---

## Development & Tests

```bash
cd sidecars/vitals
npm test
```

Standalone browser preview outside Antigravity:

```bash
PORT=4321 node sidecars/vitals/main.mjs
# Open http://127.0.0.1:4321/?conversationId=<your-conversation-id>
```

## Architecture

```text
antigravity-vitals/
├── plugin.json                        # Antigravity plugin manifest
├── assets/logo.svg                    # Plugin icon
├── scripts/install.sh                 # Symlink installer to ~/.gemini/config/plugins/
└── sidecars/vitals/
    ├── sidecar.json                   # SIDECAR_UI_ENTRYPOINT_AUX_PANE registration
    ├── main.mjs                       # sidecar_sdk server + standalone HTTP shim
    ├── lib/
    │   ├── protobuf.mjs               # Zero-dependency protobuf wire reader
    │   ├── data-dir.mjs               # App data dir resolver & WAL/SHM fingerprint
    │   ├── sqlite-reader.mjs          # Option A: read-only SQLite gen_metadata + steps reader
    │   ├── transcript-reader.mjs      # Fallback: transcript.jsonl reader
    │   ├── metrics.mjs                # Pure telemetry & tool hotspot calculation engine
    │   └── vitals-service.mjs         # ETag-cached telemetry facade (active bypass)
    ├── public/
    │   ├── index.html                 # Auxiliary pane layout (/preload.js bridge)
    │   ├── styles.css                 # Host-token-aware light/dark stylesheet
    │   └── app.js                     # 350ms live polling, 100ms ticker, SVG charts & UI
    └── test/                          # Unit & API integration tests (node:test)
```
