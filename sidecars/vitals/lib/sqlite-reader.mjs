import { DatabaseSync } from 'node:sqlite';
import {
  decodeDurationSec,
  decodePackedVarints,
  decodeTimestampMs,
  decodeUtf8,
  findAllFields,
  findField,
  parseFields,
} from './protobuf.mjs';

const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;
const STEP_TYPE_TOOL = 132;

const STEP_STATUS_PENDING = 1;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_DONE = 3;
const STEP_STATUS_ERROR = 7;
const STEP_STATUS_GENERATING = 8;

const ACTIVE_STATUSES = new Set([STEP_STATUS_PENDING, STEP_STATUS_RUNNING, STEP_STATUS_GENERATING]);

/**
 * Parse `ModelUsageStats` protobuf message (chat_model field 4 or field 17.2).
 */
function parseUsage(bytes) {
  const fields = parseFields(bytes);
  if (!fields) return null;

  const num = (fn) => {
    const f = findField(fields, fn, 0);
    return f && Number.isFinite(f.value) && f.value >= 0 ? f.value : 0;
  };

  return {
    modelEnum: num(1),
    inputTokens: num(2),
    outputTokens: num(3),
    cacheCreationTokens: num(4),
    cacheReadTokens: num(5),
    apiProvider: num(6),
    responseId: decodeUtf8(findField(fields, 7, 2)?.bytes),
    thinkingTokens: num(9),
    responseTokens: num(10),
  };
}

/**
 * Parse `chat_model.f9` context budget info (`f10.f1` estimated prompt, `f10.f4` window limit).
 */
function parseContextBudget(bytes) {
  const f9 = parseFields(bytes);
  if (!f9) return { estimatedPromptTokens: 0, contextLimit: 0 };
  const f10Field = findField(f9, 10, 2);
  if (!f10Field) return { estimatedPromptTokens: 0, contextLimit: 0 };
  const f10 = parseFields(f10Field.bytes);
  if (!f10) return { estimatedPromptTokens: 0, contextLimit: 0 };
  return {
    estimatedPromptTokens: findField(f10, 1, 0)?.value || 0,
    contextLimit: findField(f10, 4, 0)?.value || 0,
  };
}

/**
 * Extract context composition snapshot from a `chat_model` message.
 */
function parsePromptSnapshot(chatFields) {
  const msgFields = findAllFields(chatFields, 2, 2);
  const toolFields = findAllFields(chatFields, 8, 2);
  const sectionFields = findAllFields(chatFields, 16, 2);
  const sysPromptField = findField(chatFields, 1, 2);

  if (!msgFields.length && !toolFields.length && !sectionFields.length && !sysPromptField) {
    return null;
  }

  const byRole = {
    user: { tokens: 0, count: 0, bytes: 0 },
    assistant: { tokens: 0, count: 0, bytes: 0 },
    system: { tokens: 0, count: 0, bytes: 0 },
    tool: { tokens: 0, count: 0, bytes: 0 },
  };

  for (const mf of msgFields) {
    const sub = parseFields(mf.bytes);
    if (!sub) continue;
    const role = findField(sub, 2, 0)?.value || 0;
    const tokens = Math.max(0, findField(sub, 4, 0)?.value || 0);
    const bodyBytes = mf.bytes.length;

    if (role === 1) {
      byRole.user.tokens += tokens;
      byRole.user.count++;
      byRole.user.bytes += bodyBytes;
    } else if (role === 2) {
      byRole.assistant.tokens += tokens;
      byRole.assistant.count++;
      byRole.assistant.bytes += bodyBytes;
    } else if (role === 3) {
      byRole.system.tokens += tokens;
      byRole.system.count++;
      byRole.system.bytes += bodyBytes;
    } else if (role === 4) {
      byRole.tool.tokens += tokens;
      byRole.tool.count++;
      byRole.tool.bytes += bodyBytes;
    }
  }

  const sections = [];
  let sectionBytesTotal = 0;
  for (const sf of sectionFields) {
    const sub = parseFields(sf.bytes);
    if (!sub) continue;
    const name = decodeUtf8(findField(sub, 1, 2)?.bytes) || 'section';
    const bodyLen = findField(sub, 2, 2)?.bytes?.length || sf.bytes.length;
    sections.push({ name, bytes: bodyLen });
    sectionBytesTotal += bodyLen;
  }

  const systemPromptBytes = Math.max(sectionBytesTotal, sysPromptField?.bytes?.length || 0);

  const tools = [];
  let toolDefsBytes = 0;
  for (const tf of toolFields) {
    const sub = parseFields(tf.bytes);
    const name = sub ? decodeUtf8(findField(sub, 1, 2)?.bytes) || 'tool' : 'tool';
    tools.push({ name, bytes: tf.bytes.length });
    toolDefsBytes += tf.bytes.length;
  }

  return {
    byRole,
    systemPromptBytes,
    toolDefsBytes,
    toolCount: tools.length,
    sections,
  };
}

/**
 * Parse a single `gen_metadata` row blob.
 */
export function parseGenMetadataRow(idx, dataBuf) {
  const outer = parseFields(dataBuf);
  if (!outer) return null;

  const stepIndices = [];
  for (const f of outer) {
    if (f.field === 2 && f.wireType === 2) {
      stepIndices.push(...decodePackedVarints(f.bytes));
    } else if (f.field === 2 && f.wireType === 0) {
      stepIndices.push(f.value);
    }
  }

  const chatField = findField(outer, 1, 2);
  if (!chatField) return null;

  const chat = parseFields(chatField.bytes);
  if (!chat) return null;

  let usage = null;
  const u4 = findField(chat, 4, 2);
  if (u4) usage = parseUsage(u4.bytes);
  if (!usage) {
    const f17 = findField(chat, 17, 2);
    const f17Sub = f17 ? parseFields(f17.bytes) : null;
    const u17 = f17Sub ? findField(f17Sub, 2, 2) : null;
    if (u17) usage = parseUsage(u17.bytes);
  }
  if (!usage) return null;

  const budget = findField(chat, 9, 2)
    ? parseContextBudget(findField(chat, 9, 2).bytes)
    : { estimatedPromptTokens: 0, contextLimit: 0 };

  const ttftRaw = findField(chat, 11, 2);
  const decodeRaw = findField(chat, 12, 2);
  const ttftSec = ttftRaw ? Math.max(0, decodeDurationSec(ttftRaw.bytes) ?? 0) : null;
  const decodeSec = decodeRaw ? Math.max(0, decodeDurationSec(decodeRaw.bytes) ?? 0) : null;

  const modelId = decodeUtf8(findField(chat, 19, 2)?.bytes);
  const modelDisplay = decodeUtf8(findField(chat, 21, 2)?.bytes);
  const promptSnapshot = parsePromptSnapshot(chat);

  return {
    idx,
    stepIndices,
    usage,
    ttftSec,
    decodeSec,
    contextLimit: budget.contextLimit,
    estimatedPromptTokens: budget.estimatedPromptTokens,
    modelId,
    modelDisplay,
    promptSnapshot,
  };
}

/**
 * Parse `steps.metadata` protobuf:
 * - `f1`: created_at Timestamp
 * - `f4`: tool_call (`f1`: id, `f2`: tool name)
 * - `f26`: status_transitions (`f1` repeated -> `f1`: status, `f2`: Timestamp)
 */
function parseStepMetadata(metadataBuf) {
  if (!metadataBuf) {
    return { createdAtMs: null, toolName: '', transitions: {} };
  }
  const fields = parseFields(metadataBuf);
  if (!fields) {
    return { createdAtMs: null, toolName: '', transitions: {} };
  }

  const tsField = findField(fields, 1, 2);
  const createdAtMs = tsField ? decodeTimestampMs(tsField.bytes) : null;

  let toolName = '';
  const f4 = findField(fields, 4, 2);
  if (f4) {
    const f4Fields = parseFields(f4.bytes);
    const nameField = findField(f4Fields, 2, 2);
    if (nameField) toolName = decodeUtf8(nameField.bytes).trim();
  }

  const transitions = {};
  const f26 = findField(fields, 26, 2);
  if (f26) {
    const f26Fields = parseFields(f26.bytes);
    for (const tr of findAllFields(f26Fields, 1, 2)) {
      const trFields = parseFields(tr.bytes);
      const st = findField(trFields, 1, 0)?.value;
      const at = decodeTimestampMs(findField(trFields, 2, 2)?.bytes);
      if (st != null && at != null) {
        transitions[st] = at;
      }
    }
  }

  return { createdAtMs, toolName, transitions };
}

/**
 * Estimate live partial output bytes from an in-progress `PLANNER_RESPONSE`
 * `step_payload` (`f20`: `f1`/`f2` content, `f3` thinking, `f7` tool calls).
 */
function estimatePlannerPayloadBytes(payloadBuf) {
  if (!payloadBuf) return { thinkingBytes: 0, responseBytes: 0, totalBytes: 0 };
  const top = parseFields(payloadBuf);
  const f20 = findField(top, 20, 2);
  if (!f20) return { thinkingBytes: 0, responseBytes: 0, totalBytes: 0 };
  const sub = parseFields(f20.bytes);
  if (!sub) return { thinkingBytes: 0, responseBytes: 0, totalBytes: 0 };

  let thinkingBytes = 0;
  let responseBytes = 0;
  for (const x of sub) {
    if (x.wireType !== 2) continue;
    if (x.field === 3) {
      thinkingBytes += x.bytes.length;
    } else if (x.field === 1 || x.field === 2 || x.field === 7 || x.field === 8) {
      responseBytes += x.bytes.length;
    }
  }
  return {
    thinkingBytes,
    responseBytes,
    totalBytes: thinkingBytes + responseBytes,
  };
}

function stepRowToParsed(sr) {
  const meta = parseStepMetadata(sr.metadata);
  const info = {
    idx: sr.idx,
    stepType: sr.step_type,
    status: sr.status,
    createdAtMs: meta.createdAtMs,
    toolName: meta.toolName,
    transitions: meta.transitions,
  };

  let toolEvent = null;
  if (sr.step_type === STEP_TYPE_TOOL || meta.toolName) {
    const startedAtMs = meta.transitions[STEP_STATUS_RUNNING] ?? meta.createdAtMs;
    const finishedAtMs =
      meta.transitions[STEP_STATUS_DONE] ?? meta.transitions[STEP_STATUS_ERROR] ?? null;
    const isRunning = sr.status === STEP_STATUS_PENDING || sr.status === STEP_STATUS_RUNNING;
    const isError = sr.status === STEP_STATUS_ERROR;
    const durationSec =
      !isRunning && startedAtMs != null && finishedAtMs != null && finishedAtMs >= startedAtMs
        ? (finishedAtMs - startedAtMs) / 1000
        : null;

    toolEvent = {
      stepIndex: sr.idx,
      name: meta.toolName || 'tool',
      status: sr.status,
      isRunning,
      isError,
      startedAtMs,
      finishedAtMs,
      durationSec,
    };
  }

  return { info, toolEvent };
}

function buildLiveActivity(db, activePlannerStep, activeToolSteps) {
  let activity = 'idle';
  let liveTurn = null;

  if (activePlannerStep) {
    const isStreaming = activePlannerStep.status === STEP_STATUS_GENERATING;
    activity = isStreaming ? 'streaming' : 'waiting_ttft';
    const streamingStartedAtMs = activePlannerStep.transitions[STEP_STATUS_GENERATING] ?? null;

    let partialBytes = { thinkingBytes: 0, responseBytes: 0, totalBytes: 0 };
    if (isStreaming) {
      const payloadRow = db
        .prepare('SELECT step_payload FROM steps WHERE idx = ?')
        .get(activePlannerStep.idx);
      if (payloadRow?.step_payload) {
        partialBytes = estimatePlannerPayloadBytes(payloadRow.step_payload);
      }
    }

    liveTurn = {
      stepIndex: activePlannerStep.idx,
      phase: activity,
      startedAtMs: activePlannerStep.createdAtMs,
      streamingStartedAtMs,
      thinkingBytes: partialBytes.thinkingBytes,
      responseBytes: partialBytes.responseBytes,
      totalBytes: partialBytes.totalBytes,
    };
  } else if (activeToolSteps.length > 0) {
    activity = 'tool_running';
  }

  return { activity, liveTurn };
}

/**
 * Read conversation telemetry from local Antigravity SQLite DB (Option A).
 *
 * When `prevCache` is supplied and `gen_metadata` row count / max idx have not
 * changed (e.g. during active streaming or tool execution), skips re-reading
 * historical `gen_metadata` blobs and completed `steps` prefix — querying only
 * the live tail steps and the single active `step_payload` (< 0.3ms).
 */
export function readConversationSqlite(dbPath, prevCache = null) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 500;');

    const gmMeta = db
      .prepare('SELECT COUNT(*) AS count, COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata')
      .get();
    const stepMeta = db
      .prepare('SELECT COUNT(*) AS count, COALESCE(MAX(idx), -1) AS maxIdx FROM steps')
      .get();

    const gmCount = gmMeta?.count || 0;
    const gmMaxIdx = gmMeta?.maxIdx ?? -1;
    const totalSteps = stepMeta?.count || 0;

    // Fast incremental path: gen_metadata unchanged & DB did not shrink
    const canIncremental =
      Boolean(prevCache) &&
      prevCache.gmCount === gmCount &&
      prevCache.gmMaxIdx === gmMaxIdx &&
      totalSteps >= prevCache.stableStepCount;

    if (canIncremental) {
      const tailRows = db
        .prepare('SELECT idx, step_type, status, metadata FROM steps WHERE idx >= ? ORDER BY idx ASC')
        .all(prevCache.tailStartIdx);

      const tailToolEvents = [];
      let activePlannerStep = null;
      const activeToolSteps = [];
      let nextTailStartIdx = prevCache.tailStartIdx;
      let stableLocked = false;
      const newlyStableToolEvents = [];
      let newlyStableCount = 0;

      for (const sr of tailRows) {
        const { info, toolEvent } = stepRowToParsed(sr);
        const isActive = ACTIVE_STATUSES.has(sr.status);

        if (sr.step_type === STEP_TYPE_PLANNER_RESPONSE && isActive) {
          activePlannerStep = info;
        }
        if (toolEvent) {
          if (toolEvent.isRunning) activeToolSteps.push(toolEvent);
          tailToolEvents.push(toolEvent);
        }

        if (!stableLocked) {
          if (isActive) {
            stableLocked = true;
          } else {
            nextTailStartIdx = sr.idx + 1;
            newlyStableCount++;
            if (toolEvent) newlyStableToolEvents.push(toolEvent);
          }
        }
      }

      const { activity, liveTurn } = buildLiveActivity(db, activePlannerStep, activeToolSteps);
      const toolEvents =
        prevCache.stableToolEvents.length > 0
          ? prevCache.stableToolEvents.concat(tailToolEvents)
          : tailToolEvents;

      const nextCache = {
        gmCount,
        gmMaxIdx,
        stableStepCount: prevCache.stableStepCount + newlyStableCount,
        tailStartIdx: nextTailStartIdx,
        stableToolEvents:
          newlyStableToolEvents.length > 0
            ? prevCache.stableToolEvents.concat(newlyStableToolEvents)
            : prevCache.stableToolEvents,
        detectedContextLimit: prevCache.detectedContextLimit,
        promptSnapshot: prevCache.promptSnapshot,
        turns: prevCache.turns,
      };

      return {
        ok: true,
        source: 'sqlite',
        tpsPrecision: 'decode',
        fastPath: true,
        gmCount,
        gmMaxIdx,
        activity,
        liveTurn,
        toolEvents,
        totalSteps,
        detectedContextLimit: prevCache.detectedContextLimit,
        promptSnapshot: prevCache.promptSnapshot,
        turns: prevCache.turns,
        _readerCache: nextCache,
      };
    }

    // Full read path (first load or after gen_metadata added a new completed turn)
    const stepRows = db
      .prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC')
      .all();

    const stepMap = new Map();
    const toolEvents = [];
    const stableToolEvents = [];
    let activePlannerStep = null;
    const activeToolSteps = [];
    let tailStartIdx = 0;
    let stableStepCount = 0;
    let stableLocked = false;

    for (const sr of stepRows) {
      const { info, toolEvent } = stepRowToParsed(sr);
      stepMap.set(sr.idx, info);

      const isActive = ACTIVE_STATUSES.has(sr.status);
      if (sr.step_type === STEP_TYPE_PLANNER_RESPONSE && isActive) {
        activePlannerStep = info;
      }
      if (toolEvent) {
        toolEvents.push(toolEvent);
        if (toolEvent.isRunning) activeToolSteps.push(toolEvent);
      }

      if (!stableLocked) {
        if (isActive) {
          stableLocked = true;
        } else {
          tailStartIdx = sr.idx + 1;
          stableStepCount++;
          if (toolEvent) stableToolEvents.push(toolEvent);
        }
      }
    }

    const { activity, liveTurn } = buildLiveActivity(db, activePlannerStep, activeToolSteps);

    const gmRows = db
      .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC')
      .all();

    const turns = [];
    let latestSnapshot = null;
    let detectedContextLimit = 0;

    for (const row of gmRows) {
      const parsed = parseGenMetadataRow(row.idx, row.data);
      if (!parsed) continue;

      if (parsed.contextLimit > 0) detectedContextLimit = parsed.contextLimit;
      if (parsed.promptSnapshot) latestSnapshot = parsed.promptSnapshot;

      const primaryStepIdx = parsed.stepIndices[0];
      const primaryStep = primaryStepIdx !== undefined ? stepMap.get(primaryStepIdx) : null;

      let toolCount = 0;
      let hasError = false;
      for (const sIdx of parsed.stepIndices) {
        const s = stepMap.get(sIdx);
        if (s?.status === STEP_STATUS_ERROR) hasError = true;
        if (
          sIdx !== primaryStepIdx &&
          s?.stepType !== STEP_TYPE_USER_INPUT &&
          s?.stepType !== STEP_TYPE_PLANNER_RESPONSE
        ) {
          toolCount++;
        }
      }
      if (toolCount === 0 && parsed.stepIndices.length > 1) {
        toolCount = parsed.stepIndices.length - 1;
      }

      turns.push({
        id: turns.length + 1,
        genIdx: parsed.idx,
        stepIndex: primaryStepIdx ?? null,
        timestampMs: primaryStep?.createdAtMs ?? null,
        kind: toolCount > 0 ? 'tool' : 'reply',
        tools: toolCount,
        hasError,
        modelId: parsed.modelId,
        modelDisplay: parsed.modelDisplay,
        inputTokens: parsed.usage.inputTokens,
        cacheReadTokens: parsed.usage.cacheReadTokens,
        cacheCreationTokens: parsed.usage.cacheCreationTokens,
        outputTokens: parsed.usage.outputTokens,
        thinkingTokens: parsed.usage.thinkingTokens,
        responseTokens: parsed.usage.responseTokens,
        ttftSec: parsed.ttftSec,
        decodeSec: parsed.decodeSec,
        contextLimit: parsed.contextLimit,
      });
    }

    const nextCache = {
      gmCount,
      gmMaxIdx,
      stableStepCount,
      tailStartIdx,
      stableToolEvents,
      detectedContextLimit,
      promptSnapshot: latestSnapshot,
      turns,
    };

    return {
      ok: true,
      source: 'sqlite',
      tpsPrecision: 'decode',
      fastPath: false,
      gmCount,
      gmMaxIdx,
      activity,
      liveTurn,
      toolEvents,
      totalSteps,
      detectedContextLimit,
      promptSnapshot: latestSnapshot,
      turns,
      _readerCache: nextCache,
    };
  } catch (err) {
    return {
      ok: false,
      source: 'sqlite',
      error: err instanceof Error ? err.message : String(err),
      turns: [],
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}
