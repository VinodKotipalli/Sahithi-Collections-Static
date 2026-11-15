type ClientResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string; code?: string };

type ClientHandler = (path: string, method: string, body?: unknown) => Promise<ClientResult>;

/** Select the deployment's transport before sending credentials or mutations. */
export function createApiTransport(
  mode: 'server' | 'firebase',
  clientHandler: ClientHandler,
  serverFetch: typeof fetch = globalThis.fetch
): (path: string, options?: RequestInit) => Promise<Response> {
  return async (path, options = {}) => {
    if (mode === 'server') return serverFetch(path, options);

    // Never turn an arbitrary URL into a Firebase operation.
    if (!path.startsWith('/api/')) {
      throw new Error('Firebase transport accepts only relative /api/ paths.');
    }
    const result = await clientHandler(path, (options.method || 'GET').toUpperCase(), options.body);
    const status = result.ok ? 200 : (result.status >= 400 && result.status <= 599 ? result.status : 503);
    return new Response(JSON.stringify(result.ok ? result.data : result), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Sahithi-Transport': 'firebase',
      },
    });
  };
}
