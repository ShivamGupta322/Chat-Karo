import { describe, expect, it } from 'vitest';
import { apiProxyTarget } from '../vite.apiProxy';

describe('apiProxyTarget', () => {
  it('defaults to port 8080 when unset or empty', () => {
    expect(apiProxyTarget(undefined)).toBe('http://127.0.0.1:8080');
    expect(apiProxyTarget('')).toBe('http://127.0.0.1:8080');
  });
  it('accepts a port number', () => {
    expect(apiProxyTarget('8090')).toBe('http://127.0.0.1:8090');
    expect(apiProxyTarget('1')).toBe('http://127.0.0.1:1');
    expect(apiProxyTarget('65535')).toBe('http://127.0.0.1:65535');
  });
  it.each(['abc', '0', '70000', ' 8080', '8080 ', '-1', '80.5', '0x50', '65536', '123456'])(
    'rejects %j',
    (value) => {
      expect(() => apiProxyTarget(value)).toThrow('GEO_HTTP_PORT must be a port number (1-65535)');
    },
  );
});
