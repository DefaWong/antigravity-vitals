import { CONV_ID_RE, findAppDataDirs, fingerprintFiles, locateConversationFiles } from './data-dir.mjs';
import { computeVitals } from './metrics.mjs';
import { readConversationSqlite } from './sqlite-reader.mjs';
import { readConversationTranscript } from './transcript-reader.mjs';

const MAX_CACHE_ENTRIES = 64;

/**
 * Stateful, ETag-cached telemetry service combining Option A (SQLite `gen_metadata`
 * + live `steps`) with automatic fallback to `transcript.jsonl`.
 *
 * When a conversation is actively streaming (`waiting_ttft` / `streaming` /
 * `tool_running`), the service bypasses idle ETag caching so sub-second polls
 * pick up live WAL commits and partial output growth immediately.
 */
export function createVitalsService(options = {}) {
  const getAppDataDirs = options.getAppDataDirs || (() => findAppDataDirs());
  const cache = new Map(); // convId -> { etag, payload }

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

    if (files.dbPath) {
      const sqlRes = readConversationSqlite(files.dbPath);
      if (sqlRes.ok && (sqlRes.turns.length > 0 || sqlRes.activity !== 'idle' || !files.transcriptPath)) {
        rawData = sqlRes;
      } else if (!sqlRes.ok) {
        sqliteError = sqlRes.error;
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
    const payload = computeVitals(conv, rawData, nowMs);
    if (sqliteError && payload.source !== 'sqlite') {
      payload.fallbackReason = sqliteError;
    }

    const finalFp = fingerprintFiles(files);
    const isActive = payload.activity !== 'idle';
    const etag = isActive ? `${conv}|live|${nowMs}` : `${conv}|${finalFp}`;

    setCache(conv, { etag, payload });
    return { ...payload, etag };
  }

  return {
    getVitals,
    getAppDataDirs,
    clearCache: () => cache.clear(),
  };
}
