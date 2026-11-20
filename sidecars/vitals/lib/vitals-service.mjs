import { CONV_ID_RE, findAppDataDirs, fingerprintFiles, locateConversationFiles } from './data-dir.mjs';
import { computeVitals } from './metrics.mjs';
import { readConversationSqlite } from './sqlite-reader.mjs';
import { readConversationTranscript } from './transcript-reader.mjs';

const MAX_CACHE_ENTRIES = 64;

/**
 * Stateful, ETag-cached telemetry service combining Option A (SQLite `gen_metadata`
 * + incremental live `steps` fast-path) with automatic fallback to `transcript.jsonl`.
 *
 * - Idle conversations: 0 SQLite opens (48-byte `-shm` WAL header fingerprint).
 * - Active streaming / tool execution: incremental fast-path skips historical
 *   `gen_metadata` blobs and completed `steps` prefix, reading only tail steps
 *   and the single active `step_payload` (< 0.3ms).
 */
export function createVitalsService(options = {}) {
  const getAppDataDirs = options.getAppDataDirs || (() => findAppDataDirs());
  const cache = new Map(); // convId -> { etag, payload, readerCache, dbPath }

  function setCache(convId, entry) {
    if (cache.has(convId)) cache.delete(convId);
    cache.set(convId, entry);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  function getVitals(conversationId, clientEtag = '') {
    const conv = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!conv || !CONV_ID_RE.test(conv)) {
      return {
        conversationId: conv || null,
        hasData: false,
        source: 'none',
        tpsPrecision: 'none',
        activity: 'idle',
        etag: 'none',
      };
    }

    const dirs = getAppDataDirs();
    const files = locateConversationFiles(conv, dirs);
    const fp = fingerprintFiles(files);
    const cached = cache.get(conv);
    const wasActive = Boolean(cached && cached.payload?.activity && cached.payload.activity !== 'idle');
    const idleEtag = `${conv}|${fp}`;

    // Only short-circuit when the conversation was idle AND files/SHM header did not change.
    if (!wasActive && clientEtag && clientEtag === idleEtag) {
      return { conversationId: conv, unchanged: true, etag: idleEtag };
    }

    if (!wasActive && cached && cached.etag === idleEtag) {
      return { ...cached.payload, etag: idleEtag };
    }

    let rawData = null;
    let sqliteError = null;
    let readerCache = cached?.dbPath === files.dbPath ? cached?.readerCache || null : null;

    if (files.dbPath) {
      const sqlRes = readConversationSqlite(files.dbPath, readerCache);
      if (sqlRes.ok && (sqlRes.turns.length > 0 || sqlRes.activity !== 'idle' || !files.transcriptPath)) {
        rawData = sqlRes;
        readerCache = sqlRes._readerCache || null;
      } else if (!sqlRes.ok) {
        sqliteError = sqlRes.error;
        readerCache = null;
      }
    }

    if (!rawData && files.transcriptPath) {
      const trRes = readConversationTranscript(files.transcriptPath);
      if (trRes.ok) {
        rawData = trRes;
      }
    }

    if (!rawData) {
      rawData = {
        ok: true,
        source: files.dbPath ? 'sqlite' : 'none',
        tpsPrecision: files.dbPath ? 'decode' : 'none',
        activity: 'idle',
        turns: [],
      };
    }

    const nowMs = Date.now();
    let payload;
    // If incremental fast-path kept historical turns/breakdown identical, we still
    // compute fresh liveTurn & toolStats cleanly while avoiding duplicate work if needed.
    if (
      rawData.fastPath &&
      cached?.payload?.hasData &&
      cached.payload.source === 'sqlite' &&
      cached.payload.turns?.length === rawData.turns.length
    ) {
      // Reuse heavy breakdown + turns from cached payload; refresh only liveTurn/toolStats/activity!
      const freshLive = computeVitals(conv, {
        ...rawData,
        turns: [], // skip recomputing turns/breakdown!
      }, nowMs);
      payload = {
        ...cached.payload,
        serverNowMs: nowMs,
        activity: freshLive.activity,
        liveTurn: freshLive.liveTurn,
        toolStats: freshLive.toolStats,
        toolsRev: `${freshLive.toolStats.totalCalls}:${freshLive.toolStats.errorCalls}:${freshLive.toolStats.totalDurationSec}:${freshLive.toolStats.activeTools
          .map((t) => `${t.stepIndex}:${t.name}`)
          .join(',')}`,
      };
    } else {
      payload = computeVitals(conv, rawData, nowMs);
    }

    if (sqliteError && payload.source !== 'sqlite') {
      payload.fallbackReason = sqliteError;
    }

    const finalFp = fingerprintFiles(files);
    const isActive = payload.activity !== 'idle';
    const etag = isActive ? `${conv}|live|${nowMs}` : `${conv}|${finalFp}`;

    setCache(conv, { etag, payload, readerCache, dbPath: files.dbPath });
    return { ...payload, etag, fastPath: Boolean(rawData.fastPath) };
  }

  return {
    getVitals,
    getAppDataDirs,
    clearCache: () => cache.clear(),
  };
}
