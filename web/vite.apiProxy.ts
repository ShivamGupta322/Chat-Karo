// The dev/preview proxy target for /api/ (see ADR-017). 127.0.0.1, not localhost: Node on
// Windows resolves localhost to ::1 first, but geo_service is published on IPv4 only.
const DEFAULT_PORT = 8080;

export function apiProxyTarget(port: string | undefined): string {
  if (port === undefined || port === '') return `http://127.0.0.1:${DEFAULT_PORT}`;
  const n = /^[0-9]{1,5}$/.test(port) ? Number(port) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('GEO_HTTP_PORT must be a port number (1-65535)');
  }
  return `http://127.0.0.1:${n}`;
}
