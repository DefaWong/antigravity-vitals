import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeVitals } from '../lib/metrics.mjs';

describe('computeVitals metrics engine', () => {
  it('returns empty state cleanly when no turns exist', () => {
    const res = computeVitals('0c0859ce-44cc-467d-9cd3-3085a8ca855d', {
      source: 'sqlite',
      tpsPrecision: 'decode',
      activity: 'idle',
      turns: [],
    });
    assert.equal(res.hasData, false);
    assert.equal(res.summary, null);
    assert.equal(res.turns.length, 0);
  });

  it('calculates time-weighted ratio-of-sums Decode/E2E TPS, TTFT warm vs cold, and filters buffered bursts', () => {
    const raw = {
      source: 'sqlite',
      tpsPrecision: 'decode',
      activity: 'idle',
      detectedContextLimit: 512000,
      turns: [
        // Turn 1: Cold prefill
        {
          id: 1,
          kind: 'tool',
          tools: 3,
          modelId: 'gemini-4-neon',
          modelDisplay: 'Gemini 4 Neon (High)',
          inputTokens: 14000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1000,
          thinkingTokens: 600,
          responseTokens: 400,
          ttftSec: 4.0,
          decodeSec: 10.0,
        },
        // Turn 2: Warm hit
        {
          id: 2,
          kind: 'reply',
          tools: 0,
          modelId: 'gemini-4-neon',
          modelDisplay: 'Gemini 4 Neon (High)',
          inputTokens: 2000,
          cacheReadTokens: 15000,
          cacheCreationTokens: 0,
          outputTokens: 3000,
          thinkingTokens: 1000,
          responseTokens: 2000,
          ttftSec: 0.5,
          decodeSec: 20.0,
        },
        // Turn 3: Short sample (1.0s, 253 tokens) — first-chunk buffering inflates rawDecodeTps to 253 t/s
        {
          id: 3,
          kind: 'tool',
          tools: 1,
          modelId: 'gemini-4-neon',
          modelDisplay: 'Gemini 4 Neon (High)',
          inputTokens: 1500,
          cacheReadTokens: 18500,
          cacheCreationTokens: 0,
          outputTokens: 253,
          thinkingTokens: 185,
          responseTokens: 68,
          ttftSec: 5.55,
          decodeSec: 1.0,
        },
      ],
      toolEvents: [
        { stepIndex: 2, name: 'run_command', isRunning: false, isError: false, durationSec: 2.4 },
        { stepIndex: 3, name: 'run_command', isRunning: true, isError: false, startedAtMs: 1_700_000_000_000 },
        { stepIndex: 4, name: 'read_file', isRunning: false, isError: true, durationSec: 0.2 },
      ],
      liveTurn: {
        stepIndex: 5,
        phase: 'streaming',
        startedAtMs: 1_700_000_000_000,
        streamingStartedAtMs: 1_700_000_002_000,
        thinkingBytes: 760,
        responseBytes: 1140,
        totalBytes: 1900,
      },
      promptSnapshot: {
        byRole: {
          user: { tokens: 400, count: 2, bytes: 1600 },
          assistant: { tokens: 4000, count: 2, bytes: 16000 },
          system: { tokens: 0, count: 0, bytes: 0 },
          tool: { tokens: 8600, count: 4, bytes: 34000 },
        },
        systemPromptBytes: 24000,
        toolDefsBytes: 12000,
        toolCount: 16,
        sections: [
          { name: 'identity', bytes: 300 },
          { name: 'skills', bytes: 6000 },
        ],
      },
    };

    const nowMs = 1_700_000_006_000;
    const res = computeVitals('0c0859ce-44cc-467d-9cd3-3085a8ca855d', raw, nowMs);
    assert.equal(res.hasData, true);
    assert.equal(res.contextLimit, 512000);
    assert.equal(res.turns[2].isShortSample, true);
    assert.equal(res.turns[2].decodeTps, null);
    assert.equal(res.turns[2].rawDecodeTps, 253.0);

    // Ratio-of-sums avgDecodeTps excludes Turn 3's short sample: (1000 + 3000) / (10 + 20) = 133.3
    assert.equal(res.summary.avgDecodeTps, 133.3);
    // Headline Decode TPS falls back to last steady-state turn (Turn 2: 3000 / 20 = 150.0)
    assert.equal(res.summary.headlineDecodeTps, 150.0);
    assert.equal(res.summary.headlineDecodeIsFallback, true);

    // Warm vs cold TTFT: cold = 4.0, warm = (0.5 + 5.55) / 2 = 3.025
    assert.equal(res.summary.avgColdTtft, 4.0);
    assert.equal(res.summary.avgWarmTtft, 3.025);
    assert.equal(res.summary.warmCount, 2);
    assert.equal(res.summary.coldCount, 1);

    // Tool hotspots & active tools
    assert.equal(res.toolStats.totalCalls, 3);
    assert.equal(res.toolStats.errorCalls, 1);
    assert.equal(res.toolStats.activeTools.length, 1);
    assert.equal(res.toolStats.activeTools[0].name, 'run_command');
    assert.equal(res.toolStats.activeTools[0].elapsedSec, 6.0);
    assert.equal(res.toolStats.hotspots[0].name, 'run_command');
    assert.equal(res.toolStats.hotspots[0].count, 2);

    // Live streaming turn estimation (1900 / 3.8 = 500 tok over 4.0s = 125.0 tok/s)
    assert.equal(res.liveTurn.phase, 'streaming');
    assert.equal(res.liveTurn.elapsedTtftSec, 2.0);
    assert.equal(res.liveTurn.elapsedDecodeSec, 4.0);
    assert.equal(res.liveTurn.estOutputTokens, 500);
    assert.equal(res.liveTurn.estLiveTps, 125.0);

    // Window bar segments must sum identically to latestContextUsed (no double-counting prior turns)
    const segs = res.summary.latestWindowSegments;
    assert.equal(
      segs.cacheRead + segs.uncachedInput + segs.thinking + segs.response,
      res.summary.latestContextUsed
    );

    // Exact breakdown matches latest context used (20000 + 271 = 20271)
    assert.equal(res.breakdown.mode, 'exact_snapshot');
    const breakdownSum = res.breakdown.categories.reduce((a, c) => a + c.tokens, 0);
    assert.ok(Math.abs(breakdownSum - res.summary.latestContextUsed) <= 5);
    assert.equal(res.alert, null);
  });

  it('triggers cache_drop alert when warm conversation drops to 0% cache hit', () => {
    const res = computeVitals('0c0859ce-44cc-467d-9cd3-3085a8ca855d', {
      source: 'sqlite',
      tpsPrecision: 'decode',
      activity: 'idle',
      detectedContextLimit: 512000,
      turns: [
        {
          id: 1,
          inputTokens: 2000,
          cacheReadTokens: 100000,
          outputTokens: 500,
          ttftSec: 0.45,
          decodeSec: 5.0,
        },
        {
          id: 2,
          inputTokens: 117319,
          cacheReadTokens: 0,
          outputTokens: 1800,
          ttftSec: 8.07,
          decodeSec: 15.0,
        },
      ],
    });

    assert.equal(res.turns[1].isCacheDrop, true);
    assert.equal(res.alert?.code, 'cache_drop');
    assert.equal(res.alert?.level, 'error');
  });

  it('triggers context_high alert at >= 80% utilization', () => {
    const res = computeVitals('0c0859ce-44cc-467d-9cd3-3085a8ca855d', {
      source: 'sqlite',
      tpsPrecision: 'decode',
      activity: 'idle',
      detectedContextLimit: 200000,
      turns: [
        {
          id: 1,
          inputTokens: 5000,
          cacheReadTokens: 165000,
          outputTokens: 2000,
          ttftSec: 0.7,
          decodeSec: 15.0,
        },
      ],
    });

    assert.equal(res.summary.latestContextPct, 86.0);
    assert.equal(res.alert?.code, 'context_high');
    assert.equal(res.alert?.level, 'warning');
  });
});
