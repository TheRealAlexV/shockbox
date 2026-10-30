// Thin fetch wrapper. Every failure becomes an ApiError with the HTTP status and the server's
// message, so callers can never mistake a failed request for a success.

export class ApiError extends Error {
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export function createApi(base = '') {
  async function request(method, path, body, opts = {}) {
    const url = base.replace(/\/$/, '') + path;
    const init = { method, headers: { accept: 'application/json' }, signal: opts.signal };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError(`server unreachable (${method} ${path})`, { status: 0, path });
    }
    const ctype = res.headers.get('content-type') || '';
    let payload = null;
    if (ctype.includes('application/json')) {
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
    } else {
      try {
        payload = await res.text();
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const msg =
        (payload && typeof payload === 'object' && (payload.error || payload.message)) ||
        (typeof payload === 'string' && payload.trim()) ||
        `${res.status} ${res.statusText}`;
      throw new ApiError(String(msg), { status: res.status, path, body: payload });
    }
    if (payload && typeof payload === 'object' && payload.ok === false) {
      throw new ApiError(String(payload.error || 'request failed'), { status: res.status, path, body: payload });
    }
    return payload;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body === undefined ? {} : body, opts),
    patch: (path, body, opts) => request('PATCH', path, body || {}, opts),
    put: (path, body, opts) => request('PUT', path, body || {}, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
  };
}
