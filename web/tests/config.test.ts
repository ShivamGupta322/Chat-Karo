import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';

const base = { VITE_XMPP_WS_URL: 'ws://localhost:5280/ws-xmpp', VITE_XMPP_DOMAIN: 'chaterl.localhost' };

describe('parseConfig', () => {
  it('defaults the MUC domain', () => {
    expect(parseConfig(base)).toEqual({
      ok: true,
      config: {
        xmppWsUrl: 'ws://localhost:5280/ws-xmpp',
        xmppDomain: 'chaterl.localhost',
        mucDomain: 'muc.chaterl.localhost',
      },
    });
  });
  it('uses an explicit MUC domain', () => {
    const r = parseConfig({ ...base, VITE_XMPP_MUC_DOMAIN: 'rooms.example' });
    expect(r.ok && r.config.mucDomain).toBe('rooms.example');
  });
  it('reports a missing WS URL by name', () => {
    const r = parseConfig({ VITE_XMPP_DOMAIN: 'x.y' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('VITE_XMPP_WS_URL');
  });
  it('rejects http URLs', () => {
    expect(parseConfig({ ...base, VITE_XMPP_WS_URL: 'http://localhost:5280' }).ok).toBe(false);
  });
  it('rejects a domain containing @', () => {
    expect(parseConfig({ ...base, VITE_XMPP_DOMAIN: 'a@b' }).ok).toBe(false);
  });
  it('reports several errors and never echoes values', () => {
    const r = parseConfig({ VITE_XMPP_WS_URL: 'http://secret-host', VITE_XMPP_DOMAIN: 'a@b' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(2);
      expect(r.errors.join()).not.toContain('secret-host');
    }
  });
});
