import https from 'node:https';

const ONE_ZERO_API_HOSTS = new Set([
  'identity.tfd-bank.com',
  'mobile.tfd-bank.com',
]);

const REQUEST_TIMEOUT_MS = 30_000;

function isOneZeroApiRequest(input) {
  try {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url);
    return url.protocol === 'https:' && ONE_ZERO_API_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function toRequestBody(body) {
  if (body == null) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

function nodeHttpsFetch(input, init = {}) {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || (typeof input === 'object' && input.method) || 'GET';
  const body = toRequestBody(init.body);

  if (init.body != null && body == null) {
    throw new TypeError('Unsupported ONE ZERO request body');
  }

  const headers = new Headers(
    init.headers || (typeof input === 'object' ? input.headers : undefined)
  );
  // node:https does not transparently decompress responses. Asking for an
  // identity response keeps the returned body compatible with Response.json().
  headers.set('accept-encoding', 'identity');
  if (body != null && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)));
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value != null) {
              responseHeaders.set(name, String(value));
            }
          }

          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode || 500,
              statusText: response.statusMessage || '',
              headers: responseHeaders,
            })
          );
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('ONE ZERO API request timed out'));
    });
    request.on('error', reject);

    if (init.signal) {
      if (init.signal.aborted) {
        request.destroy(init.signal.reason);
      } else {
        init.signal.addEventListener(
          'abort',
          () => request.destroy(init.signal.reason),
          { once: true }
        );
      }
    }

    if (body != null) request.write(body);
    request.end();
  });
}

/**
 * ONE ZERO's Cloudflare configuration currently rejects Node's built-in
 * fetch/Undici TLS fingerprint with HTTP 403. node:https is accepted by the
 * same API. Route only ONE ZERO API traffic through node:https and leave every
 * other scraper on the native fetch implementation.
 */
export function installOneZeroTransport() {
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (input, init) => {
    if (!isOneZeroApiRequest(input)) return nativeFetch(input, init);
    return nodeHttpsFetch(input, init);
  };
}
