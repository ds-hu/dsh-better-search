/**
 * HTTP helpers for the panel API.
 *
 * The route owns its whole response lifecycle (that is the `dsh-host-webserver`
 * contract), so these are plain `node:http` utilities instead of a framework.
 *
 * @module @ds-hu/dsh-better-search/lib/http
 */

/** Largest JSON body the panel API accepts (bytes). */
export const MAX_JSON_BYTES = 64 * 1024;

/** One request that cannot be answered as asked, carrying its HTTP status. */
export class HttpError extends Error {
  /**
   * @param {number} status - status to send.
   * @param {string} code - stable machine code shown to the panel.
   * @param {string} message - human-readable explanation.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} value - JSON-serializable body.
 * @returns {void}
 */
export function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Write one error envelope.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {HttpError} error - error to report.
 * @returns {void}
 */
export function sendError(res, error) {
  sendJson(res, error.status, { ok: false, code: error.code, error: error.message });
}

/**
 * Read a bounded request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [limit] - byte cap.
 * @returns {Promise<Buffer>} the body.
 */
function readBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.destroy?.();
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'body-too-large', `请求体超过 ${limit} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(new HttpError(400, 'body-read-failed', error?.message ?? String(error))));
  });
}

/**
 * Read one JSON object body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed object.
 */
export async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported-media-type', '写操作需要 Content-Type: application/json');
  }
  const buffer = await readBody(req);
  if (buffer.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new HttpError(400, 'invalid-json', `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid-body', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/**
 * Browser-trust fence for mutations: no `Origin` (curl/tests) or one whose
 * authority equals the request `Host`.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {void}
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let authority;
  try {
    authority = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'cross-origin', '请求 Origin 不是合法来源');
  }
  if (req.headers.host === undefined || authority !== req.headers.host) {
    throw new HttpError(403, 'cross-origin', '请求 Origin 与 Host 不一致');
  }
}

/**
 * Normalize a thrown value into an `HttpError`.
 * @param {unknown} error - thrown value.
 * @returns {HttpError} reportable error.
 */
export function asHttpError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'server-error', error instanceof Error ? error.message : String(error));
}
