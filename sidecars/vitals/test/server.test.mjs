import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FallbackResponse, StandaloneSidecarApp, registerRoutes } from '../main.mjs';
import { createVitalsService } from '../lib/vitals-service.mjs';
import {
  encodeDuration,
  encodeMessage,
  encodePackedVarints,
  encodeTimestampMs,
  fieldBytes,
  fieldString,
  fieldVarint,
} from './proto-helper.mjs';

function seedConversationDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
  `);
  const now = Date.now();
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
    1,
    15,
    3,
    encodeMessage([fieldBytes(1, encodeTimestampMs(now))])
  );

  const usage = encodeMessage([
    fieldVarint(2, 2400),
    fieldVarint(3, 1200),
    fieldVarint(5, 48000),
    fieldVarint(9, 400),
    fieldVarint(10, 800),
  ]);
  const budget = encodeMessage([fieldBytes(10, encodeMessage([fieldVarint(1, 50400), fieldVarint(4, 512000)]))]);
  const chat = encodeMessage([
    fieldBytes(4, usage),
    fieldBytes(9, budget),
    fieldBytes(11, encodeDuration(0.45)),
    fieldBytes(12, encodeDuration(10.0)),
    fieldString(19, 'gemini-4-neon'),
    fieldString(21, 'Gemini 4 Neon (XHigh)'),
  ]);
  const outer = encodeMessage([fieldBytes(2, encodePackedVarints([1])), fieldBytes(1, chat)]);
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, outer);
  db.close();
}

describe('vitals sidecar HTTP API', () => {
  it('serves /api/vitals with ETag short-circuiting and /api/health', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-vital-srv-'));
    const convId = '2774810e-4656-4f01-aef5-c9f0f315c908';
    const appData = join(tmp, 'antigravity');
    mkdirSync(join(appData, 'conversations'), { recursive: true });
    seedConversationDb(join(appData, 'conversations', `${convId}.db`));

    const app = new StandaloneSidecarApp();
    const service = createVitalsService({ getAppDataDirs: () => [appData] });

    registerRoutes(app, FallbackResponse, service);

    try {
      const healthRes = await app.dispatch('GET', '/api/health');
      assert.equal(healthRes.status, 200);
      const health = JSON.parse(healthRes.body);
      assert.equal(health.ok, true);
      assert.equal(health.service, 'antigravity-vital');

      const firstRes = await app.dispatch('GET', `/api/vitals?conversationId=${convId}`);
      assert.equal(firstRes.status, 200);
      const first = JSON.parse(firstRes.body);
      assert.equal(first.hasData, true);
      assert.equal(first.source, 'sqlite');
      assert.equal(first.model.display, 'Gemini 4 Neon (XHigh)');
      assert.equal(first.summary.headlineDecodeTps, 120.0);
      assert.ok(first.etag);

      // Polling again with the same etag returns unchanged=true cleanly
      const secondRes = await app.dispatch(
        'GET',
        `/api/vitals?conversationId=${convId}&etag=${encodeURIComponent(first.etag)}`
      );
      const second = JSON.parse(secondRes.body);
      assert.equal(second.unchanged, true);
      assert.equal(second.etag, first.etag);

      // Missing conversation returns safe empty payload
      const missingRes = await app.dispatch(
        'GET',
        '/api/vitals?conversationId=deadbeef-0000-0000-0000-000000000000'
      );
      const missing = JSON.parse(missingRes.body);
      assert.equal(missing.hasData, false);

      // Standalone /preload.js stub and static frontend assets respond 200
      const preloadRes = await app.dispatch('GET', '/preload.js');
      assert.equal(preloadRes.status, 200);

      const indexRes = await app.dispatch('GET', '/');
      assert.equal(indexRes.status, 200);
      assert.match(indexRes.body, /<script src="\/preload\.js"><\/script>/);

      const cssRes = await app.dispatch('GET', '/styles.css');
      assert.equal(cssRes.status, 200);
      assert.match(cssRes.headers['Content-Type'], /text\/css/);

      const jsRes = await app.dispatch('GET', '/app.js');
      assert.equal(jsRes.status, 200);
      assert.match(jsRes.headers['Content-Type'], /javascript/);

      // Unknown route returns 404
      const notFoundRes = await app.dispatch('GET', '/nonexistent');
      assert.equal(notFoundRes.status, 404);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('automatically falls back to transcript.jsonl when SQLite file is corrupt', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-vital-fb-'));
    try {
      const convId = '1ff04149-ad68-4f48-bca5-35e7d67b6ee8';
      const appData = join(tmp, 'antigravity');
      mkdirSync(join(appData, 'conversations'), { recursive: true });
      mkdirSync(join(appData, 'brain', convId, '.system_generated', 'logs'), { recursive: true });

      writeFileSync(join(appData, 'conversations', `${convId}.db`), 'not-a-valid-sqlite-header');
      writeFileSync(
        join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'),
        [
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '2026-11-20T13:10:00Z',
            model: 'gemini-4-neon-high',
            input_tokens: 3000,
            cache_read_tokens: 27000,
            output_tokens: 600,
          }),
          JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-20T13:10:06Z' }),
        ].join('\n')
      );

      const service = createVitalsService({ getAppDataDirs: () => [appData] });
      const res = service.getVitals(convId);
      assert.equal(res.hasData, true);
      assert.equal(res.source, 'transcript');
      assert.equal(res.tpsPrecision, 'e2e_fallback');
      assert.equal(res.summary.overallCacheRate, 90.0);
      assert.equal(res.summary.avgE2eTps, 100.0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
