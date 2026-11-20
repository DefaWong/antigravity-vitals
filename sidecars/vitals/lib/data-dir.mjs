import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const CONV_ID_RE = /^[0-9a-f-]{8,}$/i;

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function safeStat(path) {
  try {
    const s = statSync(path);
    return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: -1 };
  }
}

/**
 * Resolve Antigravity app data directories (e.g. ~/.gemini/antigravity).
 *
 * Mirrors the official built-in Swarm sidecar resolution order:
 * 1. Walk up from ANTIGRAVITY_EXECUTABLE_DATA_DIR to the parent of `sidecar_data`.
 * 2. Use ANTIGRAVITY_APP_DATA_DIR if explicitly provided.
 * 3. Standalone fallback: scan ~/.gemini/* for dirs containing `conversations/` or `brain/`.
 */
export function findAppDataDirs(env = process.env, home = homedir()) {
  const execDataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'conversations')) || existsSync(join(appData, 'brain'))) {
        return [appData];
      }
      return [];
    }
  }

  const explicit = env.ANTIGRAVITY_APP_DATA_DIR;
  if (explicit && (existsSync(join(explicit, 'conversations')) || existsSync(join(explicit, 'brain')))) {
    return [explicit];
  }

  const geminiRoot = join(home, '.gemini');
  const candidates = safeReaddir(geminiRoot)
    .sort()
    .map((name) => join(geminiRoot, name))
    .filter((dir) => existsSync(join(dir, 'conversations')) || existsSync(join(dir, 'brain')));

  // Prefer the standard `antigravity` directory first if multiple products exist.
  candidates.sort((a, b) => {
    const aMain = basename(a) === 'antigravity' ? 0 : 1;
    const bMain = basename(b) === 'antigravity' ? 0 : 1;
    return aMain - bMain || a.localeCompare(b);
  });

  return candidates;
}

/**
 * Locate the SQLite conversation DB and fallback transcript path for a conversation ID.
 */
export function locateConversationFiles(conversationId, appDataDirs) {
  if (!conversationId || !CONV_ID_RE.test(conversationId)) {
    return { dbPath: null, transcriptPath: null, appData: null };
  }

  let dbPath = null;
  let transcriptPath = null;
  let matchedAppData = null;

  for (const appData of appDataDirs) {
    const candidateDb = join(appData, 'conversations', `${conversationId}.db`);
    const candidateTr = join(appData, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');

    if (!dbPath && existsSync(candidateDb)) {
      dbPath = candidateDb;
      matchedAppData = matchedAppData || appData;
    }
    if (!transcriptPath && existsSync(candidateTr)) {
      transcriptPath = candidateTr;
      matchedAppData = matchedAppData || appData;
    }
    if (dbPath && transcriptPath) break;
  }

  return { dbPath, transcriptPath, appData: matchedAppData };
}

/**
 * Compute a lightweight fingerprint for a conversation's backing files,
 * including SQLite WAL sidecar files so live turns invalidate ETags immediately.
 */
export function fingerprintFiles({ dbPath, transcriptPath }) {
  const parts = [];
  if (dbPath) {
    const main = safeStat(dbPath);
    const wal = safeStat(`${dbPath}-wal`);
    const walSize = wal.exists && wal.size > 0 ? wal.size : 0;
    const walMtime = walSize > 0 ? wal.mtimeMs : 0;
    parts.push(`db:${main.mtimeMs}:${main.size}:${walMtime}:${walSize}`);
  }
  if (transcriptPath) {
    const tr = safeStat(transcriptPath);
    parts.push(`tr:${tr.mtimeMs}:${tr.size}`);
  }
  return parts.join('|') || 'empty';
}
