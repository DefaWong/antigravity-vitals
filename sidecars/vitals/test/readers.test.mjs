import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findAppDataDirs, fingerprintFiles, locateConversationFiles } from '../lib/data-dir.mjs';
import { readConversationSqlite } from '../lib/sqlite-reader.mjs';
import { readConversationTranscript } from '../lib/transcript-reader.mjs';
import {
  encodeDuration,
  encodeMessage,
  encodePackedVarints,
  encodeTimestampMs,
  fieldBytes,
  fieldString,
  fieldVarint,
} from './proto-helper.mjs';

function makeGenMetadataBlob({
  steps,
  inputTokens,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
  outputTokens,
  thinkingTokens = 0,
  responseTokens = 0,
  ttftSec,
  decodeSec,
  contextLimit = 512000,
  modelId = 'gemini-4-neon',
  modelDisplay = 'Gemini 4 Neon (XHigh)',
  includeSnapshot = false,
}) {
  const usage = encodeMessage([
    fieldVarint(1, 1535),
    fieldVarint(2, inputTokens),
    fieldVarint(3, outputTokens),
    cacheCreationTokens ? fieldVarint(4, cacheCreationTokens) : null,
    cacheReadTokens ? fieldVarint(5, cacheReadTokens) : null,
    thinkingTokens ? fieldVarint(9, thinkingTokens) : null,
    responseTokens ? fieldVarint(10, responseTokens) : null,
  ]);

  const budget = encodeMessage([
    fieldBytes(10, encodeMessage([fieldVarint(1, inputTokens + cacheReadTokens), fieldVarint(4, contextLimit)])),
  ]);

  const chatParts = [
    fieldVarint(3, 1535),
    fieldBytes(4, usage),
    fieldBytes(9, budget),
    ttftSec != null ? fieldBytes(11, encodeDuration(ttftSec)) : null,
    decodeSec != null ? fieldBytes(12, encodeDuration(decodeSec)) : null,
    fieldString(19, modelId),
    fieldString(21, modelDisplay),
  ];

  if (includeSnapshot) {
    // chat.f1 system prompt
    chatParts.push(fieldString(1, '<identity>Antigravity</identity>'));
    // chat.f2 messages: user, assistant, tool
    chatParts.push(fieldBytes(2, encodeMessage([fieldVarint(2, 1), fieldVarint(4, 500)])));
    chatParts.push(fieldBytes(2, encodeMessage([fieldVarint(2, 2), fieldVarint(4, 1800)])));
    chatParts.push(fieldBytes(2, encodeMessage([fieldVarint(2, 4), fieldVarint(4, 6200)])));
    // chat.f8 tool defs
    chatParts.push(fieldBytes(8, encodeMessage([fieldString(1, 'read_file'), fieldString(2, 'Read a file')])));
    chatParts.push(fieldBytes(8, encodeMessage([fieldString(1, 'run_command'), fieldString(2, 'Run command')])));
    // chat.f16 system sections
    chatParts.push(fieldBytes(16, encodeMessage([fieldString(1, 'identity'), fieldString(2, 'x'.repeat(300))])));
    chatParts.push(fieldBytes(16, encodeMessage([fieldString(1, 'skills'), fieldString(2, 'y'.repeat(1200))])));
  }

  return encodeMessage([
    fieldBytes(2, encodePackedVarints(steps)),
    fieldBytes(1, encodeMessage(chatParts)),
  ]);
}

function makeStepMeta(tsMs, opts = {}) {
  const parts = [fieldBytes(1, encodeTimestampMs(tsMs))];
  if (opts.toolName) {
    parts.push(fieldBytes(4, encodeMessage([fieldString(1, 'call_1'), fieldString(2, opts.toolName)])));
  }
  if (opts.transitions?.length) {
    const trParts = opts.transitions.map(([st, at]) =>
      fieldBytes(1, encodeMessage([fieldVarint(1, st), fieldBytes(2, encodeTimestampMs(at))]))
    );
    parts.push(fieldBytes(26, encodeMessage(trParts)));
  }
  return encodeMessage(parts);
}

describe('data-dir and readers', () => {
  it('resolves ANTIGRAVITY_EXECUTABLE_DATA_DIR and fingerprints WAL updates', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-vital-dir-'));
    try {
      const appData = join(tmp, 'antigravity');
      const convId = '0c0859ce-44cc-467d-9cd3-3085a8ca855d';
      const execDir = join(appData, 'sidecar_data', 'antigravity-vital', 'vitals', 'data');
      mkdirSync(join(appData, 'conversations'), { recursive: true });
      mkdirSync(join(appData, 'brain', convId, '.system_generated', 'logs'), { recursive: true });
      mkdirSync(execDir, { recursive: true });

      const dbPath = join(appData, 'conversations', `${convId}.db`);
      const trPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      writeFileSync(dbPath, '');
      writeFileSync(trPath, '');

      const dirs = findAppDataDirs({ ANTIGRAVITY_EXECUTABLE_DATA_DIR: execDir }, tmp);
      assert.deepEqual(dirs, [appData]);

      const located = locateConversationFiles(convId, dirs);
      assert.equal(located.dbPath, dbPath);
      assert.equal(located.transcriptPath, trPath);

      const fp1 = fingerprintFiles(located);
      writeFileSync(`${dbPath}-wal`, 'wal-change-bytes');
      const fp2 = fingerprintFiles(located);
      assert.notEqual(fp1, fp2);

      // Path traversal rejected
      const bad = locateConversationFiles('../evil', dirs);
      assert.equal(bad.dbPath, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads Option A SQLite gen_metadata, WAL live status, timings, and prompt snapshot', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-vital-db-'));
    try {
      const dbPath = join(tmp, 'conv.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
      `);

      const t0 = Date.parse('2026-11-20T13:10:00.000Z');
      const t1 = Date.parse('2026-11-20T13:10:15.500Z');

      const insStep = db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)'
      );
      insStep.run(0, 14, 3, makeStepMeta(t0), null);
      insStep.run(1, 15, 3, makeStepMeta(t0 + 20), null);
      insStep.run(
        2,
        132,
        3,
        makeStepMeta(t0 + 4000, {
          toolName: 'run_command',
          transitions: [
            [2, t0 + 4050],
            [3, t0 + 5250],
          ],
        }),
        null
      );
      insStep.run(
        3,
        132,
        7,
        makeStepMeta(t0 + 4100, {
          toolName: 'read_file',
          transitions: [
            [2, t0 + 4110],
            [7, t0 + 4310],
          ],
        }),
        null
      );
      // Active streaming planner step (status = 8 GENERATING) with partial payload!
      const partialPayload = encodeMessage([
        fieldBytes(
          20,
          encodeMessage([
            fieldString(3, 'thinking... '.repeat(40)),
            fieldString(1, 'streaming output '.repeat(50)),
          ])
        ),
      ]);
      insStep.run(
        4,
        15,
        8,
        makeStepMeta(t1, { transitions: [[8, t1 + 1200]] }),
        partialPayload
      );

      const insGm = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
      insGm.run(
        0,
        makeGenMetadataBlob({
          steps: [1, 2, 3],
          inputTokens: 13566,
          cacheReadTokens: 0,
          outputTokens: 621,
          thinkingTokens: 433,
          responseTokens: 188,
          ttftSec: 4.146,
          decodeSec: 3.882,
          contextLimit: 512000,
        })
      );
      insGm.run(
        1,
        makeGenMetadataBlob({
          steps: [4],
          inputTokens: 2829,
          cacheReadTokens: 134994,
          outputTokens: 1512,
          thinkingTokens: 757,
          responseTokens: 755,
          ttftSec: 0.52,
          decodeSec: 12.6,
          contextLimit: 512000,
          includeSnapshot: true,
        })
      );
      db.close();

      const res = readConversationSqlite(dbPath);
      assert.equal(res.ok, true);
      assert.equal(res.source, 'sqlite');
      assert.equal(res.tpsPrecision, 'decode');
      assert.equal(res.activity, 'streaming');
      assert.ok(res.liveTurn);
      assert.equal(res.liveTurn.phase, 'streaming');
      assert.equal(res.liveTurn.streamingStartedAtMs, t1 + 1200);
      assert.ok(res.liveTurn.totalBytes > 1000);
      assert.equal(res.toolEvents.length, 2);
      assert.equal(res.toolEvents[0].name, 'run_command');
      assert.ok(Math.abs(res.toolEvents[0].durationSec - 1.2) < 0.01);
      assert.equal(res.toolEvents[1].name, 'read_file');
      assert.equal(res.toolEvents[1].isError, true);
      assert.equal(res.detectedContextLimit, 512000);
      assert.equal(res.turns.length, 2);

      assert.equal(res.turns[0].kind, 'tool');
      assert.equal(res.turns[0].tools, 2);
      assert.equal(res.turns[0].inputTokens, 13566);
      assert.equal(res.turns[0].thinkingTokens, 433);
      assert.equal(res.turns[0].responseTokens, 188);
      assert.ok(Math.abs(res.turns[0].ttftSec - 4.146) < 1e-3);
      assert.ok(Math.abs(res.turns[0].decodeSec - 3.882) < 1e-3);

      assert.equal(res.turns[1].kind, 'reply');
      assert.equal(res.turns[1].cacheReadTokens, 134994);
      assert.equal(res.turns[1].modelDisplay, 'Gemini 4 Neon (XHigh)');
      assert.ok(res.promptSnapshot);
      assert.equal(res.promptSnapshot.byRole.tool.tokens, 6200);
      assert.equal(res.promptSnapshot.toolCount, 2);
      assert.equal(res.promptSnapshot.sections.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back cleanly to transcript.jsonl when SQLite is unavailable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-vital-tr-'));
    try {
      const trPath = join(tmp, 'transcript.jsonl');
      const lines = [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T13:03:50Z' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T13:03:50Z',
          model: 'gemini-4-neon-high',
          input_tokens: 10000,
          cache_read_tokens: 0,
          output_tokens: 500,
          tool_calls: [{ name: 'read_file' }],
        }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-20T13:03:55Z' }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T13:03:56Z',
          model: 'gemini-4-neon-high',
          input_tokens: 2000,
          cache_read_tokens: 10500,
          output_tokens: 800,
        }),
        '{"torn_json_line": ',
      ];
      writeFileSync(trPath, lines.join('\n'));

      const res = readConversationTranscript(trPath);
      assert.equal(res.ok, true);
      assert.equal(res.source, 'transcript');
      assert.equal(res.tpsPrecision, 'e2e_fallback');
      assert.equal(res.turns.length, 2);
      assert.equal(res.turns[0].tools, 1);
      assert.equal(res.turns[0].decodeSec, 5);
      assert.equal(res.turns[1].cacheReadTokens, 10500);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
