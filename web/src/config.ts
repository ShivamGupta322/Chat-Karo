// The only file that reads import.meta.env values (via the object main.tsx passes in).
export interface AppConfig {
  xmppWsUrl: string;
  xmppDomain: string;
  mucDomain: string;
}
export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; errors: string[] };

type Env = Record<string, string | boolean | undefined>;

function str(v: string | boolean | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function validDomain(d: string): boolean {
  return d.length > 0 && !/[@/\s]/.test(d);
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

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { xmppWsUrl: ws, xmppDomain: domain, mucDomain: muc } };
}
