import { CONV_ID_RE, findAppDataDirs, fingerprintFiles, locateConversationFiles } from './data-dir.mjs';
import { computeVitals } from './metrics.mjs';
import { readConversationSqlite } from './sqlite-reader.mjs';
import { readConversationTranscript } from './transcript-reader.mjs';

const MAX_CACHE_ENTRIES = 64;

/**
 * Stateful, ETag-cached telemetry service combining Option A (SQLite `gen_metadata`)
 * with automatic fallback to `transcript.jsonl`.
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
    const etag = `${conv}|${fp}`;

    if (clientEtag && clientEtag === etag) {
      return { conversationId: conv, unchanged: true, etag };
    }

    const hit = cache.get(conv);
    if (hit && hit.etag === etag) {
      return { ...hit.payload, etag };
    }

    let rawData = null;
    let sqliteError = null;

    // Option A: primary read-only SQLite gen_metadata reader
    if (files.dbPath) {
      const sqlRes = readConversationSqlite(files.dbPath);
      if (sqlRes.ok && (sqlRes.turns.length > 0 || !files.transcriptPath)) {
        rawData = sqlRes;
      } else if (!sqlRes.ok) {
        sqliteError = sqlRes.error;
      }
    }

    // Automatic fallback: transcript.jsonl
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

    const payload = computeVitals(conv, rawData);
    if (sqliteError && payload.source !== 'sqlite') {
      payload.fallbackReason = sqliteError;
    }

    setCache(conv, { etag, payload });
    return { ...payload, etag };
  }

  return {
    getVitals,
    getAppDataDirs,
    clearCache: () => cache.clear(),
  };
}
