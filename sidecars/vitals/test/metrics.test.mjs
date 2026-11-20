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
        // Turn 3: Buffered single-chunk tool JSON flush (0.19s for 271 tokens = 1426 tok/s)
        {
          id: 3,
          kind: 'tool',
          tools: 1,
          modelId: 'gemini-4-neon',
          modelDisplay: 'Gemini 4 Neon (High)',
          inputTokens: 1500,
          cacheReadTokens: 18500,
          cacheCreationTokens: 0,
          outputTokens: 271,
          thinkingTokens: 21,
          responseTokens: 250,
          ttftSec: 0.6,
          decodeSec: 0.19,
        },
      ],
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

    const res = computeVitals('0c0859ce-44cc-467d-9cd3-3085a8ca855d', raw);
    assert.equal(res.hasData, true);
    assert.equal(res.contextLimit, 512000);
    assert.equal(res.turns[2].isBufferedBurst, true);

    // Ratio-of-sums avgDecodeTps excludes Turn 3's buffered burst: (1000 + 3000) / (10 + 20) = 133.3
    assert.equal(res.summary.avgDecodeTps, 133.3);
    // Headline Decode TPS falls back to last unbuffered turn (Turn 2: 3000 / 20 = 150.0)
    assert.equal(res.summary.headlineDecodeTps, 150.0);
    assert.equal(res.summary.headlineDecodeIsFallback, true);

    // Warm vs cold TTFT: cold = 4.0, warm = (0.5 + 0.6) / 2 = 0.55 -> speedup = 7.27x
    assert.equal(res.summary.avgColdTtft, 4.0);
    assert.equal(res.summary.avgWarmTtft, 0.55);
    assert.equal(res.summary.ttftSpeedup, 7.27);
    assert.equal(res.summary.warmCount, 2);
    assert.equal(res.summary.coldCount, 1);

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
