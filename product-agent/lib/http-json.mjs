/**
 * Function: Reads and parses a JSON HTTP request body.
 * Inputs:
 * - req: Node HTTP IncomingMessage.
 * - options.maxBytes: Maximum accepted body size in bytes.
 * Output:
 * - Parsed JSON value.
 * Side effects:
 * - Consumes the request stream.
 * Errors:
 * - Throws when the body is too large or not valid JSON.
 */
export async function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes || 1024 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    throw new Error("request body is empty");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

/**
 * Function: Sends a JSON HTTP response.
 * Inputs:
 * - res: Node HTTP ServerResponse.
 * - status: HTTP status code.
 * - payload: JSON-serializable response body.
 * Output:
 * - None.
 * Side effects:
 * - Writes response headers and body.
 * Errors:
 * - Does not throw for ordinary JSON-serializable payloads.
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
