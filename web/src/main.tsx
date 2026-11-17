import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfigError } from './components/ConfigError';
import { parseConfig } from './config';
import './index.css';
import { createXmppClient, XmppProvider } from './xmpp';
import { createStropheTransport } from './xmpp/strophe/stropheTransport';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const root = createRoot(container);

const result = parseConfig(import.meta.env);

if (!result.ok) {
  root.render(<ConfigError errors={result.errors} />);
} else {
  const { config } = result;
  // One client at module level (outside React) so StrictMode cannot create two.
  const client = createXmppClient(createStropheTransport(config.xmppWsUrl), {
    mucDomain: config.mucDomain,
  });
  root.render(
    <React.StrictMode>
      <XmppProvider client={client}>
        <App xmppDomain={config.xmppDomain} mucDomain={config.mucDomain} />
      </XmppProvider>
    </React.StrictMode>,
  );
}
