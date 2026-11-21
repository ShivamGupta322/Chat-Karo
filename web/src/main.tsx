import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import {
  createCredentialStore,
  createHttp,
  createSessionApi,
  createTokenManager,
} from './api';
import { DEV_SLOT_WARNING, readDevIdentitySlot } from './api/devIdentitySlot';
import { ConfigError } from './components/ConfigError';
import { parseConfig } from './config';
import './index.css';
import { IdentityProvider } from './state/IdentityProvider';
import { createIdentityController } from './state/identityController';
import { createXmppClient, XmppProvider } from './xmpp';
import { createStropheTransport } from './xmpp/strophe/stropheTransport';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const root = createRoot(container);

const result = parseConfig({
  VITE_XMPP_WS_URL: import.meta.env.VITE_XMPP_WS_URL,
  VITE_XMPP_DOMAIN: import.meta.env.VITE_XMPP_DOMAIN,
  VITE_XMPP_MUC_DOMAIN: import.meta.env.VITE_XMPP_MUC_DOMAIN,
  VITE_API_URL: import.meta.env.VITE_API_URL,
  // Dev only: the literal DEV guard folds to undefined in production builds, so the tile URL never ships.
  VITE_MAP_TILE_URL: import.meta.env.DEV ? import.meta.env.VITE_MAP_TILE_URL : undefined,
});

if (!result.ok) {
  root.render(<ConfigError errors={result.errors} />);
} else {
  const { config } = result;
  // Dev only (ADR-014): the literal DEV ternary lets the bundler drop the slot parser from production builds.
  const devSlot = import.meta.env.DEV
    ? readDevIdentitySlot(window.location.search)
    : { slot: null, invalid: false };
  if (import.meta.env.DEV && devSlot.invalid) console.warn(DEV_SLOT_WARNING);

  // Everything long-lived is built once, outside React, so StrictMode cannot create two.
  const client = createXmppClient(createStropheTransport(config.xmppWsUrl), {
    mucDomain: config.mucDomain,
  });
  const http = createHttp({ baseUrl: config.apiUrl });
  const session = createSessionApi(http, { xmppDomain: config.xmppDomain });
  const credentials = createCredentialStore({ xmppDomain: config.xmppDomain, slot: devSlot.slot });
  const tokens = createTokenManager({ renew: session.renew });
  const identity = createIdentityController({ client, credentials, session, tokens });
  // Before the first render: a returning device shows "Signing you in" at once, never a flash of Welcome.
  identity.start();

  root.render(
    <React.StrictMode>
      <XmppProvider client={client}>
        <IdentityProvider controller={identity}>
          <App mucDomain={config.mucDomain} mapTileUrl={config.mapTileUrl} />
        </IdentityProvider>
      </XmppProvider>
    </React.StrictMode>,
  );
}
