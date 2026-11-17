import type { XmppClient } from './types';

/** Wake the client when the browser comes back online or the tab becomes visible. */
export function installLifecycleTriggers(
  client: Pick<XmppClient, 'wake'>,
  win: EventTarget = window,
  doc: EventTarget & { readonly visibilityState: DocumentVisibilityState } = document,
): () => void {
  const onOnline = (): void => {
    client.wake('online');
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') client.wake('visible');
  };
  win.addEventListener('online', onOnline);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('online', onOnline);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
