/**
 * Pure telemetry computation engine for Antigravity Vitals.
 *
 * Computes per-turn and session-wide metrics from raw SQLite (`gen_metadata` +
 * `steps`) or fallback `transcript.jsonl` payloads:
 * - Pure decode TPS with short-sample noise filter (avoids first-chunk buffer inflation)
 * - Time-weighted ratio-of-sums session averages
 * - Warm vs. cold TTFT & cache speedup
 * - Cache hit rate & mid-session cache-drop detection
 * - Exact context window utilization & role/section breakdown
 * - Tool hotspots & real-time active tool/streaming telemetry
 */

// Gemini buffers the initial ~100-150 tokens (thinking summary / tool-call JSON)
// before emitting the first streamed chunk (status=8). Dividing total output by
// a short tail window (<1.5s or <300 tokens) artificially inflates decode TPS
// to 250-1000+ tok/s. Such turns are marked `isShortSample` so steady-state
// Decode TPS charts and averages stay physically accurate.
const SHORT_SAMPLE_MIN_SEC = 1.5;
const SHORT_SAMPLE_MIN_OUT = 300;
const MIN_VALID_SEC = 0.05;
const BYTES_PER_TOKEN_EST = 3.8;

function inferDefaultContextLimit(modelStr = '') {
  const m = String(modelStr).toLowerCase();
  if (m.includes('claude')) return 200000;
  if (m.includes('gemini')) return 512000;
  if (m.includes('gpt')) return 256000;
  return 256000;
}

/**
 * Normalize thinking vs. visible output tokens safely across providers.
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
 * Aggregate tool call hotspots & currently running tools from `toolEvents`.
 */
function buildToolStats(toolEvents = [], nowMs = Date.now()) {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
    return {
      totalCalls: 0,
      errorCalls: 0,
      uniqueTools: 0,
      totalDurationSec: 0,
      activeTools: [],
      hotspots: [],
    };
  }

  const byName = new Map();
  const activeTools = [];
  let totalCalls = 0;
  let errorCalls = 0;
  let totalDurationSec = 0;

  for (const evt of toolEvents) {
    const name = evt.name || 'tool';
    totalCalls++;
    if (evt.isError) errorCalls++;

    let row = byName.get(name);
    if (!row) {
      row = { name, count: 0, errors: 0, totalDurationSec: 0, timedCount: 0, running: 0 };
      byName.set(name, row);
    }
    row.count++;
    if (evt.isError) row.errors++;

    if (evt.isRunning) {
      row.running++;
      const elapsedSec =
        evt.startedAtMs != null && nowMs >= evt.startedAtMs
          ? Number(((nowMs - evt.startedAtMs) / 1000).toFixed(1))
          : 0;
      activeTools.push({
        name,
        stepIndex: evt.stepIndex ?? null,
        startedAtMs: evt.startedAtMs ?? nowMs,
        elapsedSec,
      });
    } else if (evt.durationSec != null && Number.isFinite(evt.durationSec) && evt.durationSec >= 0) {
      row.totalDurationSec += evt.durationSec;
      row.timedCount++;
      totalDurationSec += evt.durationSec;
    }
  }

  const hotspots = [...byName.values()]
    .map((r) => ({
      name: r.name,
      count: r.count,
      errors: r.errors,
      running: r.running,
      totalDurationSec: Number(r.totalDurationSec.toFixed(1)),
      avgDurationSec: r.timedCount > 0 ? Number((r.totalDurationSec / r.timedCount).toFixed(2)) : null,
    }))
    .sort((a, b) => b.running - a.running || b.count - a.count || b.totalDurationSec - a.totalDurationSec);

  return {
    totalCalls,
    errorCalls,
    uniqueTools: byName.size,
    totalDurationSec: Number(totalDurationSec.toFixed(1)),
    activeTools,
    hotspots,
  };
}

/**
 * Enrich an in-progress planner turn (`waiting_ttft` or `streaming`) with live
 * elapsed timers and estimated streaming tokens/TPS.
 */
function buildLiveTurn(rawLive, nowMs = Date.now()) {
  if (!rawLive) return null;
  const startedAtMs = rawLive.startedAtMs ?? nowMs;
  const streamingStartedAtMs = rawLive.streamingStartedAtMs ?? null;

  let elapsedTtftSec = null;
  let elapsedDecodeSec = null;

  if (rawLive.phase === 'streaming' && streamingStartedAtMs != null) {
    elapsedTtftSec = Math.max(0, (streamingStartedAtMs - startedAtMs) / 1000);
    elapsedDecodeSec = Math.max(0, (nowMs - streamingStartedAtMs) / 1000);
  } else {
    elapsedTtftSec = Math.max(0, (nowMs - startedAtMs) / 1000);
  }

  const estThinkingTokens = Math.round((rawLive.thinkingBytes || 0) / BYTES_PER_TOKEN_EST);
  const estResponseTokens = Math.round((rawLive.responseBytes || 0) / BYTES_PER_TOKEN_EST);
  const estOutputTokens = estThinkingTokens + estResponseTokens;

  let estLiveTps = null;
  if (
    rawLive.phase === 'streaming' &&
    elapsedDecodeSec != null &&
    elapsedDecodeSec >= 0.4 &&
    estOutputTokens >= 15
  ) {
    estLiveTps = Number((estOutputTokens / elapsedDecodeSec).toFixed(1));
  }

  return {
    stepIndex: rawLive.stepIndex ?? null,
    phase: rawLive.phase,
    startedAtMs,
    streamingStartedAtMs,
    elapsedTtftSec: Number(elapsedTtftSec.toFixed(2)),
    elapsedDecodeSec: elapsedDecodeSec != null ? Number(elapsedDecodeSec.toFixed(2)) : null,
    estThinkingTokens,
    estResponseTokens,
    estOutputTokens,
    estLiveTps,
  };
}

/**
 * Build real context breakdown from SQLite `promptSnapshot`, or an honest
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
    const rawOverhead = Math.max(0, promptTotal - msgTokenSum);
    const totalOverheadBytes = systemPromptBytes + toolDefsBytes;

    let sysTokens = 0;
    let toolDefTokens = 0;
    if (rawOverhead > 0 && totalOverheadBytes > 0) {
      sysTokens = Math.round(rawOverhead * (systemPromptBytes / totalOverheadBytes));
      toolDefTokens = rawOverhead - sysTokens;
    } else if (totalOverheadBytes > 0) {
      sysTokens = Math.round(systemPromptBytes / 3.6);
      toolDefTokens = Math.round(toolDefsBytes / 3.6);
    }

    const rawCats = [
      {
        key: 'tool_outputs',
        label: '工具输出与文件读取',
        detail: `${byRole.tool.count} 条结果`,
        count: byRole.tool.count,
        rawTokens: byRole.tool.tokens,
        colorVar: 'var(--v-chart-1)',
      },
      {
        key: 'system_prompt',
        label: '系统提示词 / Skills / Rules',
        detail: sections.length ? `${sections.length} 个区块` : '系统指令',
        count: sections.length,
        rawTokens: sysTokens + byRole.system.tokens,
        colorVar: 'var(--v-chart-2)',
      },
      {
        key: 'assistant',
        label: '历史回复与 Thinking',
        detail: `${byRole.assistant.count} 轮生成`,
        count: byRole.assistant.count,
        rawTokens: byRole.assistant.tokens + latestTurn.totalOutput,
        colorVar: 'var(--v-chart-3)',
      },
      {
        key: 'tool_defs',
        label: '工具与 MCP 定义',
        detail: `${toolCount} 个工具`,
        count: toolCount,
        rawTokens: toolDefTokens,
        colorVar: 'var(--v-chart-4)',
      },
      {
        key: 'user',
        label: '用户输入消息',
        detail: `${byRole.user.count} 条消息`,
        count: byRole.user.count,
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
          count: c.count,
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
export function computeVitals(conversationId, rawData, nowMs = Date.now()) {
  const rawTurns = rawData?.turns || [];
  const source = rawData?.source || 'none';
  const tpsPrecision = rawData?.tpsPrecision || 'none';
  const activity = rawData?.activity || 'idle';
  const liveTurn = buildLiveTurn(rawData?.liveTurn || null, nowMs);
  const toolStats = buildToolStats(rawData?.toolEvents || [], nowMs);

  if (rawTurns.length === 0) {
    return {
      conversationId,
      serverNowMs: nowMs,
      hasData: false,
      source,
      tpsPrecision,
      activity,
      liveTurn,
      toolStats,
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
      e2eSec = decodeSec;
    }

    let rawDecodeTps = null;
    let decodeTps = null;
    let isShortSample = false;

    if (tpsPrecision === 'decode' && decodeSec != null && decodeSec >= MIN_VALID_SEC && totalOutput > 0) {
      rawDecodeTps = Number((totalOutput / decodeSec).toFixed(1));
      isShortSample = decodeSec < SHORT_SAMPLE_MIN_SEC || totalOutput < SHORT_SAMPLE_MIN_OUT;
      if (!isShortSample) {
        decodeTps = rawDecodeTps;
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
      rawDecodeTps,
      e2eTps,
      isShortSample,
      isBufferedBurst: isShortSample,
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

  const headlineDecodeTps =
    latest.decodeTps != null ? latest.decodeTps : lastValidDecodeTps ?? avgDecodeTps ?? latest.e2eTps;

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
      params: {
        turnId: latest.id,
        cacheRate: Number(latest.cacheRate.toFixed(0)),
        totalPrompt: latest.totalPrompt,
        ttftSec: latest.ttftSec,
        avgWarmTtft,
      },
    };
  } else if (ctxPct >= 80) {
    alert = {
      code: 'context_high',
      level: ctxPct >= 92 ? 'error' : 'warning',
      title: `上下文窗口接近上限（${ctxPct.toFixed(1)}%）`,
      desc: `当前占用 ${latest.contextUsed.toLocaleString()} / ${contextLimit.toLocaleString()} tokens。建议使用 /compact 压缩历史上下文以保持响应速度。`,
      params: {
        ctxPct: Number(ctxPct.toFixed(1)),
        contextUsed: latest.contextUsed,
        contextLimit,
      },
    };
  }

  const breakdown = buildBreakdown(latest, rawData?.promptSnapshot || null, contextLimit);

  const historyRev = `${source}:${turns.length}:${rawData?.gmMaxIdx ?? turns.length}`;
  const toolsRev = `${toolStats.totalCalls}:${toolStats.errorCalls}:${toolStats.totalDurationSec}:${toolStats.activeTools
    .map((t) => `${t.stepIndex}:${t.name}`)
    .join(',')}`;

  return {
    conversationId,
    serverNowMs: nowMs,
    historyRev,
    toolsRev,
    hasData: true,
    source,
    tpsPrecision,
    activity,
    liveTurn,
    toolStats,
    model: {
      id: modelId,
      display: modelDisplay,
    },
    contextLimit,
    detectedContextLimit,
    summary: {
      turnCount: turns.length,
      headlineDecodeTps,
      headlineDecodeIsFallback: Boolean(latest.isShortSample && headlineDecodeTps !== latest.rawDecodeTps),
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
