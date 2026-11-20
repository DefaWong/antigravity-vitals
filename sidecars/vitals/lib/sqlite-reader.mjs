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

const STEP_STATUS_PENDING = 1;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_ERROR = 7;

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
 * Extract context composition snapshot from a `chat_model` message (typically on the latest row).
 *
 * - `chat.f1`: rendered system prompt text (bytes)
 * - `chat.f2`: repeated ChatMessage (`f2`: role 1=user 2=assistant 3=system 4=tool, `f4`: token count)
 * - `chat.f8`: repeated ToolDefinition (`f1`: name, total message bytes)
 * - `chat.f16`: repeated SystemPromptSection (`f1`: section name, `f2`: body bytes)
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
 * Extract step created_at timestamp (ms) from `steps.metadata` protobuf field 1.
 */
function parseStepCreatedAtMs(metadataBuf) {
  if (!metadataBuf) return null;
  const fields = parseFields(metadataBuf);
  if (!fields) return null;
  const tsField = findField(fields, 1, 2);
  if (!tsField) return null;
  return decodeTimestampMs(tsField.bytes);
}

/**
 * Read conversation telemetry from local Antigravity SQLite DB (Option A).
 * Opens read-only, runs fast indexed queries, and closes immediately so WAL
 * checkpoints in Antigravity are never obstructed.
 */
export function readConversationSqlite(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 500;');

    const stepRows = db
      .prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC')
      .all();

    const stepMap = new Map();
    let latestStep = null;
    for (const sr of stepRows) {
      const info = {
        idx: sr.idx,
        stepType: sr.step_type,
        status: sr.status,
        createdAtMs: parseStepCreatedAtMs(sr.metadata),
      };
      stepMap.set(sr.idx, info);
      latestStep = info;
    }

    let activity = 'idle';
    if (latestStep && (latestStep.status === STEP_STATUS_PENDING || latestStep.status === STEP_STATUS_RUNNING)) {
      activity = latestStep.stepType === STEP_TYPE_PLANNER_RESPONSE ? 'streaming' : 'tool_running';
    }

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

      // Count associated tool/execution steps (everything in stepIndices after planner step).
      let toolCount = 0;
      let hasError = false;
      for (const sIdx of parsed.stepIndices) {
        const s = stepMap.get(sIdx);
        if (s?.status === STEP_STATUS_ERROR) hasError = true;
        if (sIdx !== primaryStepIdx && s?.stepType !== STEP_TYPE_USER_INPUT && s?.stepType !== STEP_TYPE_PLANNER_RESPONSE) {
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

    return {
      ok: true,
      source: 'sqlite',
      tpsPrecision: 'decode',
      activity,
      totalSteps: stepRows.length,
      detectedContextLimit,
      promptSnapshot: latestSnapshot,
      turns,
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
