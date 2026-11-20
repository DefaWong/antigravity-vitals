import { readFileSync } from 'node:fs';

/**
 * Fallback telemetry reader using `<appData>/brain/<id>/.system_generated/logs/transcript.jsonl`.
 *
 * Used automatically whenever the SQLite DB is absent, locked, or changes schema.
 * Token counts, cache hit rate, and context size remain exact; TPS degrades
 * gracefully to end-to-end duration inferred from consecutive step timestamps.
 */
export function readConversationTranscript(transcriptPath) {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.split('\n');
    const steps = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') steps.push(obj);
      } catch {
        // Skip a partially written trailing line during live streaming.
      }
    }

    const turns = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.type !== 'PLANNER_RESPONSE') continue;

      const createdMs = typeof s.created_at === 'string' ? Date.parse(s.created_at) : NaN;
      const nextStep = steps[i + 1];
      const nextMs = typeof nextStep?.created_at === 'string' ? Date.parse(nextStep.created_at) : NaN;

      let e2eSec = null;
      if (Number.isFinite(createdMs) && Number.isFinite(nextMs) && nextMs >= createdMs) {
        const delta = (nextMs - createdMs) / 1000;
        // Guard against idle gaps when next step is a later user message.
        if (nextStep?.type !== 'USER_INPUT' && delta > 0 && delta < 600) {
          e2eSec = delta;
        }
      }

      const tools = Array.isArray(s.tool_calls) ? s.tool_calls.length : 0;
      const out = Math.max(0, Number(s.output_tokens) || 0);

      turns.push({
        id: turns.length + 1,
        genIdx: turns.length,
        stepIndex: typeof s.step_index === 'number' ? s.step_index : null,
        timestampMs: Number.isFinite(createdMs) ? createdMs : null,
        kind: tools > 0 ? 'tool' : 'reply',
        tools,
        hasError: s.status === 'ERROR',
        modelId: typeof s.model === 'string' ? s.model : '',
        modelDisplay: typeof s.model === 'string' ? s.model : '',
        inputTokens: Math.max(0, Number(s.input_tokens) || 0),
        cacheReadTokens: Math.max(0, Number(s.cache_read_tokens) || 0),
        cacheCreationTokens: Math.max(0, Number(s.cache_creation_tokens) || 0),
        outputTokens: out,
        thinkingTokens: 0,
        responseTokens: out,
        ttftSec: null,
        decodeSec: e2eSec,
        contextLimit: 0,
      });
    }

    const lastStep = steps[steps.length - 1];
    const activity =
      lastStep && (lastStep.status === 'RUNNING' || lastStep.status === 'PENDING')
        ? lastStep.type === 'PLANNER_RESPONSE'
          ? 'streaming'
          : 'tool_running'
        : 'idle';

    return {
      ok: true,
      source: 'transcript',
      tpsPrecision: 'e2e_fallback',
      activity,
      totalSteps: steps.length,
      detectedContextLimit: 0,
      promptSnapshot: null,
      turns,
    };
  } catch (err) {
    return {
      ok: false,
      source: 'transcript',
      error: err instanceof Error ? err.message : String(err),
      turns: [],
    };
  }
}
