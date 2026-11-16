import type { XmppClient } from './types';

/**
 * Close the stream cleanly on reload/close. Otherwise the old session stays resumable on the
 * server for a while and the nickname stays occupied (join fails with <conflict/>).
 */
export function installPageHideClose(
  client: XmppClient,
  target: EventTarget = window,
): () => void {
  const onHide = (): void => {
    const s = client.getState().status;
    if (s === 'connected' || s === 'connecting') client.disconnect();
  };
  target.addEventListener('pagehide', onHide);
  return () => {
    target.removeEventListener('pagehide', onHide);
  };
}
