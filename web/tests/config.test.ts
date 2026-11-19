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
        mapTileUrl: null,
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

  describe('VITE_MAP_TILE_URL', () => {
    const MSG = 'VITE_MAP_TILE_URL must be an http(s) URL template with {z}, {x} and {y}';
    const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

    it.each([undefined, '', '   '])('unset (%j) means no map and no error', (v) => {
      const r = parseConfig({ ...base, VITE_MAP_TILE_URL: v });
      expect(r.ok && r.config.mapTileUrl).toBeNull();
    });

    it.each([
      [OSM, OSM],
      ['  ' + OSM + '  ', OSM],
      ['https://{s}.tile.example.org/{z}/{x}/{y}{r}.png', 'https://{s}.tile.example.org/{z}/{x}/{y}{r}.png'],
      ['http://localhost:8080/tiles/{z}/{x}/{y}.png', 'http://localhost:8080/tiles/{z}/{x}/{y}.png'],
    ])('accepts %j', (input, expected) => {
      const r = parseConfig({ ...base, VITE_MAP_TILE_URL: input });
      expect(r.ok && r.config.mapTileUrl).toBe(expected);
    });

    it.each([
      'https://tile.example.org/{z}/{x}.png',
      'ftp://h/{z}/{x}/{y}',
      'javascript:{z}{x}{y}',
      '/{z}/{x}/{y}.png',
      'not a url {z}/{x}/{y}',
      'https://h/{z}/{x}/{y}?key={apikey}',
      'https://u:p@h/{z}/{x}/{y}.png',
    ])('rejects %j with exactly the one error', (input) => {
      expect(parseConfig({ ...base, VITE_MAP_TILE_URL: input })).toEqual({ ok: false, errors: [MSG] });
    });

    it('never echoes the value in an error', () => {
      const r = parseConfig({ ...base, VITE_MAP_TILE_URL: 'ftp://SECRET123/{z}/{x}/{y}' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join()).not.toContain('SECRET123');
    });

    it('keeps error order: ws, domain, muc, tiles', () => {
      const r = parseConfig({
        VITE_XMPP_WS_URL: 'http://x',
        VITE_XMPP_DOMAIN: 'a@b',
        VITE_MAP_TILE_URL: 'nope',
      });
      expect(r).toEqual({
        ok: false,
        errors: ['VITE_XMPP_WS_URL must be a ws:// or wss:// URL', 'VITE_XMPP_DOMAIN is invalid', MSG],
      });
    });
  });
});
