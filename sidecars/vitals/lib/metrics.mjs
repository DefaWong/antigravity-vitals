/**
 * Pure telemetry computation engine for Antigravity Vitals.
 *
 * Computes per-turn and session-wide metrics from raw SQLite (`gen_metadata`)
 * or fallback `transcript.jsonl` payloads:
 * - Pure decode TPS (buffered single-chunk burst aware) & E2E TPS
 * - Time-weighted ratio-of-sums averages
 * - Warm vs. cold TTFT & cache speedup
 * - Cache hit rate & mid-session cache-drop detection
 * - Exact context window utilization & role/section breakdown
 */

const BURST_MAX_SEC = 0.5;
const BURST_SPEED_THRESHOLD = 450; // tok/s above this on <0.5s indicates single-chunk tool JSON flush
const MIN_VALID_SEC = 0.05;

function inferDefaultContextLimit(modelStr = '') {
  const m = String(modelStr).toLowerCase();
  if (m.includes('claude')) return 200000;
  if (m.includes('gemini')) return 512000;
  if (m.includes('gpt')) return 256000;
  return 256000;
}

/**
 * Normalize thinking vs. visible output tokens safely across providers
 * (handles both inclusive total output like Gemini and split output).
 */
function normalizeOutput(raw) {
  const rawOut = Math.max(0, raw.outputTokens || 0);
  const think = Math.max(0, raw.thinkingTokens || 0);
  const resp = Math.max(0, raw.responseTokens || 0);

  if (think > 0 && resp > 0) {
    const total = Math.max(rawOut, think + resp);
    return { thinking: think, response: resp, totalOutput: total };
  }
  if (think > 0 && resp === 0) {
    if (rawOut >= think) {
      return { thinking: think, response: rawOut - think, totalOutput: rawOut };
    }
    return { thinking: think, response: rawOut, totalOutput: rawOut + think };
  }
  return { thinking: 0, response: rawOut, totalOutput: rawOut };
}

/**
 * Build real context breakdown from the SQLite `promptSnapshot`, or an honest
 * prompt/output breakdown when running in JSONL fallback mode.
 */
function buildBreakdown(latestTurn, promptSnapshot, contextLimit) {
  const ctx = latestTurn.contextUsed;
  const pct = (tokens) => (contextLimit > 0 ? Number(((tokens / contextLimit) * 100).toFixed(2)) : 0);

  if (promptSnapshot) {
    const { byRole, systemPromptBytes, toolDefsBytes, toolCount, sections } = promptSnapshot;
    const msgTokenSum =
      byRole.user.tokens + byRole.assistant.tokens + byRole.system.tokens + byRole.tool.tokens;

    const promptTotal = latestTurn.totalPrompt;
    // Overhead = System Prompt + Tool/MCP Schemas (everything in prompt outside chat messages).
    const rawOverhead = Math.max(0, promptTotal - msgTokenSum);
    const totalOverheadBytes = systemPromptBytes + toolDefsBytes;

    let sysTokens = 0;
    let toolDefTokens = 0;
    if (rawOverhead > 0 && totalOverheadBytes > 0) {
      sysTokens = Math.round(rawOverhead * (systemPromptBytes / totalOverheadBytes));
      toolDefTokens = rawOverhead - sysTokens;
    } else if (totalOverheadBytes > 0) {
      // Fallback byte estimate (~3.6 bytes/token) when msg estimates exceed promptTotal.
      sysTokens = Math.round(systemPromptBytes / 3.6);
      toolDefTokens = Math.round(toolDefsBytes / 3.6);
    }

    const rawCats = [
      {
        key: 'tool_outputs',
        label: '工具输出与文件读取',
        detail: `${byRole.tool.count} 条结果`,
        rawTokens: byRole.tool.tokens,
        colorVar: 'var(--v-chart-1)',
      },
      {
        key: 'system_prompt',
        label: '系统提示词 / Skills / Rules',
        detail: sections.length ? `${sections.length} 个区块` : '系统指令',
        rawTokens: sysTokens + byRole.system.tokens,
        colorVar: 'var(--v-chart-2)',
      },
      {
        key: 'assistant',
        label: '历史回复与 Thinking',
        detail: `${byRole.assistant.count} 轮生成`,
        rawTokens: byRole.assistant.tokens + latestTurn.totalOutput,
        colorVar: 'var(--v-chart-3)',
      },
      {
        key: 'tool_defs',
        label: '工具与 MCP 定义',
        detail: `${toolCount} 个工具`,
        rawTokens: toolDefTokens,
        colorVar: 'var(--v-chart-4)',
      },
      {
        key: 'user',
        label: '用户输入消息',
        detail: `${byRole.user.count} 条消息`,
        rawTokens: byRole.user.tokens,
        colorVar: 'var(--v-chart-5)',
      },
    ];

    const rawSum = rawCats.reduce((acc, c) => acc + c.rawTokens, 0);
    const scale = rawSum > 0 && ctx > 0 ? ctx / rawSum : 1;

    const categories = rawCats
      .map((c) => {
        const tokens = Math.round(c.rawTokens * scale);
        return {
          key: c.key,
          label: c.label,
          detail: c.detail,
          tokens,
          pctOfWindow: pct(tokens),
          pctOfUsed: ctx > 0 ? Number(((tokens / ctx) * 100).toFixed(1)) : 0,
          colorVar: c.colorVar,
        };
      })
      .filter((c) => c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);

    return {
      mode: 'exact_snapshot',
      categories,
      toolCount,
      sectionCount: sections.length,
    };
  }

  // Honest fallback when only transcript.jsonl is available.
  const fallbackCats = [
    {
      key: 'cache_read',
      label: '缓存命中 Prompt',
      detail: '前缀复用',
      tokens: latestTurn.cacheReadTokens,
      colorVar: 'var(--v-chart-1)',
    },
    {
      key: 'uncached_input',
      label: '新增 Input Tokens',
      detail: '本轮增量',
      tokens: latestTurn.inputTokens + latestTurn.cacheCreationTokens,
      colorVar: 'var(--v-chart-2)',
    },
    {
      key: 'output',
      label: '模型输出与工具调用',
      detail: '本轮输出',
      tokens: latestTurn.totalOutput,
      colorVar: 'var(--v-chart-4)',
    },
  ]
    .filter((c) => c.tokens > 0)
    .map((c) => ({
      ...c,
      pctOfWindow: pct(c.tokens),
      pctOfUsed: ctx > 0 ? Number(((c.tokens / ctx) * 100).toFixed(1)) : 0,
    }));

  return {
    mode: 'transcript_fallback',
    categories: fallbackCats,
    toolCount: 0,
    sectionCount: 0,
  };
}

/**
 * Compute the complete vitals snapshot sent by `/api/vitals`.
 */
export function computeVitals(conversationId, rawData) {
  const rawTurns = rawData?.turns || [];
  const source = rawData?.source || 'none';
  const tpsPrecision = rawData?.tpsPrecision || 'none';
  const activity = rawData?.activity || 'idle';

  if (rawTurns.length === 0) {
    return {
      conversationId,
      hasData: false,
      source,
      tpsPrecision,
      activity,
      model: { id: '', display: '' },
      contextLimit: rawData?.detectedContextLimit || 256000,
      detectedContextLimit: rawData?.detectedContextLimit || 0,
      summary: null,
      turns: [],
      breakdown: null,
      alert: null,
    };
  }

  const turns = [];
  let sumInputUncached = 0;
  let sumCacheRead = 0;
  let sumCacheCreation = 0;
  let sumThinking = 0;
  let sumResponse = 0;
  let sumOutput = 0;

  let sumDecodeOut = 0;
  let sumDecodeSec = 0;
  let sumE2eOut = 0;
  let sumE2eSec = 0;

  const warmTtfts = [];
  const coldTtfts = [];

  let prevCacheRate = 0;
  let lastValidDecodeTps = null;

  for (let i = 0; i < rawTurns.length; i++) {
    const r = rawTurns[i];
    const { thinking, response, totalOutput } = normalizeOutput(r);

    const inputUncached = Math.max(0, r.inputTokens || 0);
    const cacheRead = Math.max(0, r.cacheReadTokens || 0);
    const cacheCreation = Math.max(0, r.cacheCreationTokens || 0);
    const totalPrompt = inputUncached + cacheRead + cacheCreation;
    const contextUsed = totalPrompt + totalOutput;
    const cacheRate = totalPrompt > 0 ? (cacheRead / totalPrompt) * 100 : 0;

    const ttftSec = r.ttftSec != null && Number.isFinite(r.ttftSec) ? Math.max(0, r.ttftSec) : null;
    const decodeSec =
      r.decodeSec != null && Number.isFinite(r.decodeSec) ? Math.max(0, r.decodeSec) : null;

    let e2eSec = null;
    if (tpsPrecision === 'decode') {
      if (ttftSec != null && decodeSec != null) e2eSec = ttftSec + decodeSec;
      else if (decodeSec != null) e2eSec = decodeSec;
    } else if (decodeSec != null) {
      // In transcript fallback, decodeSec holds the E2E step delta.
      e2eSec = decodeSec;
    }

    let decodeTps = null;
    let isBufferedBurst = false;
    if (tpsPrecision === 'decode' && decodeSec != null && decodeSec >= MIN_VALID_SEC && totalOutput > 0) {
      const rawSpeed = totalOutput / decodeSec;
      isBufferedBurst = decodeSec < BURST_MAX_SEC && rawSpeed > BURST_SPEED_THRESHOLD;
      decodeTps = Number(rawSpeed.toFixed(1));
      if (!isBufferedBurst) {
        sumDecodeOut += totalOutput;
        sumDecodeSec += decodeSec;
        lastValidDecodeTps = decodeTps;
      }
    }

    let e2eTps = null;
    if (e2eSec != null && e2eSec >= MIN_VALID_SEC && totalOutput > 0) {
      e2eTps = Number((totalOutput / e2eSec).toFixed(1));
      sumE2eOut += totalOutput;
      sumE2eSec += e2eSec;
    }

    const isWarmCache = cacheRate >= 20;
    const isCacheDrop = i > 0 && prevCacheRate >= 50 && cacheRate < 20 && totalPrompt >= 8000;

    if (ttftSec != null && ttftSec > 0) {
      if (isWarmCache) warmTtfts.push(ttftSec);
      else coldTtfts.push(ttftSec);
    }

    sumInputUncached += inputUncached;
    sumCacheRead += cacheRead;
    sumCacheCreation += cacheCreation;
    sumThinking += thinking;
    sumResponse += response;
    sumOutput += totalOutput;

    turns.push({
      id: r.id ?? i + 1,
      genIdx: r.genIdx ?? i,
      stepIndex: r.stepIndex ?? null,
      timestampMs: r.timestampMs ?? null,
      kind: r.kind || (r.tools > 0 ? 'tool' : 'reply'),
      tools: r.tools || 0,
      hasError: Boolean(r.hasError),
      modelId: r.modelId || '',
      modelDisplay: r.modelDisplay || r.modelId || '',
      inputTokens: inputUncached,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalPrompt,
      thinkingTokens: thinking,
      responseTokens: response,
      totalOutput,
      contextUsed,
      cacheRate: Number(cacheRate.toFixed(1)),
      ttftSec: ttftSec != null ? Number(ttftSec.toFixed(3)) : null,
      decodeSec: tpsPrecision === 'decode' && decodeSec != null ? Number(decodeSec.toFixed(3)) : null,
      e2eSec: e2eSec != null ? Number(e2eSec.toFixed(3)) : null,
      decodeTps,
      e2eTps,
      isBufferedBurst,
      isWarmCache,
      isCacheDrop,
    });

    prevCacheRate = cacheRate;
  }

  const latest = turns[turns.length - 1];
  const modelDisplay = latest.modelDisplay || latest.modelId || 'Unknown Model';
  const modelId = latest.modelId || '';

  const detectedContextLimit = rawData?.detectedContextLimit || latest.contextLimit || 0;
  const contextLimit = detectedContextLimit || inferDefaultContextLimit(modelDisplay || modelId);

  const totalPromptAll = sumInputUncached + sumCacheRead + sumCacheCreation;
  const totalTokensAll = totalPromptAll + sumOutput;
  const overallCacheRate = totalPromptAll > 0 ? (sumCacheRead / totalPromptAll) * 100 : 0;

  const avgDecodeTps = sumDecodeSec > 0 ? Number((sumDecodeOut / sumDecodeSec).toFixed(1)) : null;
  const avgE2eTps = sumE2eSec > 0 ? Number((sumE2eOut / sumE2eSec).toFixed(1)) : null;

  // Headline decode TPS: avoid showing a 1,400+ tok/s artifact on a 0.19s single-chunk tool flush.
  const headlineDecodeTps =
    latest.decodeTps != null && !latest.isBufferedBurst
      ? latest.decodeTps
      : lastValidDecodeTps ?? avgDecodeTps ?? latest.decodeTps;

  const avgWarmTtft =
    warmTtfts.length > 0
      ? Number((warmTtfts.reduce((a, b) => a + b, 0) / warmTtfts.length).toFixed(3))
      : null;
  const avgColdTtft =
    coldTtfts.length > 0
      ? Number((coldTtfts.reduce((a, b) => a + b, 0) / coldTtfts.length).toFixed(3))
      : null;
  const ttftSpeedup =
    avgWarmTtft != null && avgWarmTtft > 0 && avgColdTtft != null && avgColdTtft > 0
      ? Number((avgColdTtft / avgWarmTtft).toFixed(2))
      : null;

  const ctxPct = contextLimit > 0 ? Number(((latest.contextUsed / contextLimit) * 100).toFixed(1)) : 0;

  let alert = null;
  if (latest.isCacheDrop) {
    const prevWarm = avgWarmTtft != null ? `${avgWarmTtft.toFixed(2)}s` : '暖缓存';
    const curTtft = latest.ttftSec != null ? `，TTFT 升至 ${latest.ttftSec.toFixed(2)}s（均 ${prevWarm}）` : '';
    alert = {
      code: 'cache_drop',
      level: 'error',
      title: `Prompt 缓存失效（本轮命中率 ${latest.cacheRate.toFixed(0)}%）`,
      desc: `第 #${latest.id} 轮触发冷预填充（${latest.totalPrompt.toLocaleString()} tokens）${curTtft}。通常由模型切换、规则/MCP 变更或缓存过期引起。`,
    };
  } else if (ctxPct >= 80) {
    alert = {
      code: 'context_high',
      level: ctxPct >= 92 ? 'error' : 'warning',
      title: `上下文窗口接近上限（${ctxPct.toFixed(1)}%）`,
      desc: `当前占用 ${latest.contextUsed.toLocaleString()} / ${contextLimit.toLocaleString()} tokens。建议使用 /compact 压缩历史上下文以保持响应速度。`,
    };
  }

  const breakdown = buildBreakdown(latest, rawData?.promptSnapshot || null, contextLimit);

  return {
    conversationId,
    hasData: true,
    source,
    tpsPrecision,
    activity,
    model: {
      id: modelId,
      display: modelDisplay,
    },
    contextLimit,
    detectedContextLimit,
    summary: {
      turnCount: turns.length,
      headlineDecodeTps,
      headlineDecodeIsFallback: Boolean(latest.isBufferedBurst && headlineDecodeTps !== latest.decodeTps),
      latestDecodeTps: latest.decodeTps,
      latestE2eTps: latest.e2eTps,
      avgDecodeTps,
      avgE2eTps,
      latestTtftSec: latest.ttftSec,
      avgWarmTtft,
      avgColdTtft,
      warmCount: warmTtfts.length,
      coldCount: coldTtfts.length,
      ttftSpeedup,
      overallCacheRate: Number(overallCacheRate.toFixed(1)),
      latestCacheRate: latest.cacheRate,
      totalCacheRead: sumCacheRead,
      totalCacheCreation: sumCacheCreation,
      totalInputUncached: sumInputUncached,
      totalPromptAll,
      totalThinking: sumThinking,
      totalResponse: sumResponse,
      totalOutputAll: sumOutput,
      totalTokensAll,
      latestContextUsed: latest.contextUsed,
      latestContextPct: ctxPct,
      latestWindowSegments: {
        cacheRead: latest.cacheReadTokens,
        uncachedInput: latest.inputTokens + latest.cacheCreationTokens,
        thinking: latest.thinkingTokens,
        response: latest.responseTokens,
      },
    },
    turns,
    breakdown,
    alert,
  };
}
