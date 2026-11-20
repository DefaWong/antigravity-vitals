/**
 * Antigravity Vitals Sidecar Backend.
 *
 * Uses Antigravity's built-in `sidecar_sdk` when launched by the host, and
 * falls back to a minimal `node:http` shim when run standalone for local dev
 * or automated tests. Read-only: never modifies any conversation or config file.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitalsService } from './lib/vitals-service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

class FallbackResponse {
  constructor(body, opts = {}) {
    this.body = body;
    this.status = opts.status || 200;
    this.contentType = opts.contentType || 'text/plain; charset=utf-8';
    this.headers = opts.headers || {};
  }
}

/**
 * Minimal standalone HTTP shim mimicking `SidecarApp` for local preview & tests.
 */
export class StandaloneSidecarApp {
  constructor(opts = {}) {
    this.config = { conversationId: opts.conversationId || process.env.VITALS_CONVERSATION_ID || '' };
    this._pages = new Map();
    this._apis = new Map();
    this.server = null;
  }

  page(route, handler) {
    this._pages.set(route, handler);
  }

  api(route, handler, method = 'GET') {
    this._apis.set(`${method.toUpperCase()} ${route}`, handler);
  }

  async dispatch(method, urlStr) {
    const url = new URL(urlStr || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const upperMethod = (method || 'GET').toUpperCase();

    // Provide an empty /preload.js stub in standalone mode to avoid 404s.
    if (upperMethod === 'GET' && pathname === '/preload.js') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
        body: '// Standalone mode stub (host injects real /preload.js inside Antigravity)\n',
      };
    }

    const pageHandler = upperMethod === 'GET' ? this._pages.get(pathname) : null;
    if (pageHandler) {
      const html = await pageHandler();
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        body: html,
      };
    }

    const apiHandler = this._apis.get(`${upperMethod} ${pathname}`);
    if (apiHandler) {
      const data = Object.fromEntries(url.searchParams.entries());
      const out = await apiHandler(data);
      if (out instanceof FallbackResponse) {
        return {
          status: out.status,
          headers: { 'Content-Type': out.contentType, ...out.headers },
          body: out.body,
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: JSON.stringify(out),
      };
    }

    return {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'Not Found',
    };
  }

  createHttpServer() {
    return createServer(async (req, res) => {
      try {
        const result = await this.dispatch(req.method || 'GET', req.url || '/');
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
  }

  run(port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 4321)) {
    this.server = this.createHttpServer();
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`[vitals] standalone server listening on http://127.0.0.1:${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  close() {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export function registerRoutes(app, ResponseCtor, service = createVitalsService()) {
  app.page('/', () => readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8'));

  for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
    app.api(
      route,
      () =>
        new ResponseCtor(readFileSync(join(PUBLIC_DIR, file), 'utf-8'), {
          contentType,
          headers: { 'Cache-Control': 'no-cache' },
        }),
      'GET'
    );
  }

  app.api(
    '/api/vitals',
    (data = {}) => {
      const conv = data.conversationId || app.config?.conversationId || '';
      const etag = typeof data.etag === 'string' ? data.etag : '';
      return service.getVitals(conv, etag);
    },
    'GET'
  );

  app.api(
    '/api/health',
    () => ({
      ok: true,
      service: 'antigravity-vital',
      appDataDirs: service.getAppDataDirs(),
    }),
    'GET'
  );

  return service;
}

async function start() {
  let SidecarAppCtor = StandaloneSidecarApp;
  let ResponseCtor = FallbackResponse;
  let mode = 'standalone';

  try {
    const sdk = await import('sidecar_sdk');
    if (sdk?.SidecarApp && sdk?.Response) {
      SidecarAppCtor = sdk.SidecarApp;
      ResponseCtor = sdk.Response;
      mode = 'sidecar_sdk';
    }
  } catch {
    // Running outside Antigravity host; use standalone fallback.
  }

  const app = new SidecarAppCtor();
  const service = registerRoutes(app, ResponseCtor);
  console.log(`[vitals] starting (${mode}), appDataDirs: ${service.getAppDataDirs().join(', ') || '(none)'}`);
  app.run();
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  start();
}
