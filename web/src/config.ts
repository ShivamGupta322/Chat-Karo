// The only file that reads import.meta.env values (via the object main.tsx passes in).
export interface AppConfig {
  xmppWsUrl: string;
  xmppDomain: string;
  mucDomain: string;
  /** Same-origin path of geo_service's HTTP API, e.g. /api. */
  apiUrl: string;
  /** Dev-only map tile URL template, or null when unset. */
  mapTileUrl: string | null;
}
export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; errors: string[] };

type Env = Record<string, string | boolean | undefined>;

function str(v: string | boolean | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function validDomain(d: string): boolean {
  return d.length > 0 && !/[@/\s]/.test(d);
}

const API_URL_ERROR = 'VITE_API_URL must be a same-origin path such as /api';

/** A same-origin absolute path: /a/b with safe segment characters, no trailing slash, no . or .. segment. */
function validApiPath(p: string): boolean {
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(p)) return false;
  return !p.split('/').some((s) => s === '.' || s === '..');
}

const MAP_TILE_ERROR = 'VITE_MAP_TILE_URL must be an http(s) URL template with {z}, {x} and {y}';

/** An http(s) template with {z}, {x}, {y} and optionally {s}/{r}; nothing else in braces; no credentials. */
function validTileTemplate(t: string): boolean {
  if (!t.includes('{z}') || !t.includes('{x}') || !t.includes('{y}')) return false;
  if (/[{}]/.test(t.replace(/{[sxyzr]}/g, ''))) return false;
  try {
    const u = new URL(t.replace(/{s}/g, 'a').replace(/{[zxy]}/g, '0').replace(/{r}/g, ''),);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.hostname !== '' &&
      u.username === '' &&
      u.password === ''
    );
  } catch {
    return false;
  }
}

export function parseConfig(env: Env): ConfigResult {
  const errors: string[] = [];

  const ws = str(env.VITE_XMPP_WS_URL);
  if (ws === '') {
    errors.push('VITE_XMPP_WS_URL is missing');
  } else {
    let ok = false;
    try {
      const u = new URL(ws);
      ok = u.protocol === 'ws:' || u.protocol === 'wss:';
    } catch {
      ok = false;
    }
    if (!ok) errors.push('VITE_XMPP_WS_URL must be a ws:// or wss:// URL');
  }

  const domain = str(env.VITE_XMPP_DOMAIN);
  if (domain === '') errors.push('VITE_XMPP_DOMAIN is missing');
  else if (!validDomain(domain)) errors.push('VITE_XMPP_DOMAIN is invalid');

  const mucRaw = str(env.VITE_XMPP_MUC_DOMAIN);
  const muc = mucRaw !== '' ? mucRaw : `muc.${domain}`;
  if (mucRaw !== '' && !validDomain(mucRaw)) errors.push('VITE_XMPP_MUC_DOMAIN is invalid');

  // Not trimmed: stray whitespace or a newline must be rejected, not silently dropped. Blank means the default.
  const apiRaw = typeof env.VITE_API_URL === 'string' ? env.VITE_API_URL : '';
  const api = apiRaw.trim() === '' ? '/api' : apiRaw;
  if (!validApiPath(api)) errors.push(API_URL_ERROR);

  const tiles = str(env.VITE_MAP_TILE_URL);
  if (tiles !== '' && !validTileTemplate(tiles)) errors.push(MAP_TILE_ERROR);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      xmppWsUrl: ws,
      xmppDomain: domain,
      mucDomain: muc,
      apiUrl: api,
      mapTileUrl: tiles === '' ? null : tiles,
    },
  };
}
