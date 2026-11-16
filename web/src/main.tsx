import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { parseConfig } from './config';
import './index.css';
import { createXmppClient, XmppProvider } from './xmpp';
import { createStropheTransport } from './xmpp/strophe/stropheTransport';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const root = createRoot(container);

const result = parseConfig(import.meta.env);

if (!result.ok) {
  root.render(
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-2 text-xl font-semibold">Configuration error</h1>
      <p className="mb-2 text-sm">Fix these settings in the repo-root .env and restart:</p>
      <ul className="list-disc pl-5 text-sm text-red-700">
        {result.errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </main>,
  );
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
