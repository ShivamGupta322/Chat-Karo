// The only file that reads import.meta.env values (via the object main.tsx passes in).
export interface AppConfig {
  xmppWsUrl: string;
  xmppDomain: string;
  mucDomain: string;
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

  const tiles = str(env.VITE_MAP_TILE_URL);
  if (tiles !== '' && !validTileTemplate(tiles)) errors.push(MAP_TILE_ERROR);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      xmppWsUrl: ws,
      xmppDomain: domain,
      mucDomain: muc,
      mapTileUrl: tiles === '' ? null : tiles,
    },
  };
}
