import { describe, expect, it, vi } from 'vitest';
import { installPageHideClose } from '../../src/xmpp/pageHide';
import type { ConnectionState, SendResult, XmppClient } from '../../src/xmpp/types';

function fakeClient(state: ConnectionState): { client: XmppClient; disconnect: () => void } {
  const disconnect = vi.fn();
  const client: XmppClient = {
    getState: () => state,
    connect: vi.fn(),
    disconnect,
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    sendGroupchat: (): SendResult => ({ ok: false, error: 'not-joined' }),
    subscribe: vi.fn(() => () => undefined),
  };
  return { client, disconnect };
}

describe('installPageHideClose', () => {
  it('disconnects when connected or connecting', () => {
    const states: ConnectionState[] = [{ status: 'connected', jid: 'a@b/c' }, { status: 'connecting' }];
    for (const state of states) {
      const { client, disconnect } = fakeClient(state);
      const target = new EventTarget();
      installPageHideClose(client, target);
      target.dispatchEvent(new Event('pagehide'));
      expect(disconnect).toHaveBeenCalledTimes(1);
    }
  });
  it('does nothing when idle or disconnected', () => {
    const states: ConnectionState[] = [{ status: 'idle' }, { status: 'disconnected' }];
    for (const state of states) {
      const { client, disconnect } = fakeClient(state);
      const target = new EventTarget();
      installPageHideClose(client, target);
      target.dispatchEvent(new Event('pagehide'));
      expect(disconnect).not.toHaveBeenCalled();
    }
  });
  it('does nothing after cleanup', () => {
    const { client, disconnect } = fakeClient({ status: 'connected', jid: 'a@b/c' });
    const target = new EventTarget();
    const off = installPageHideClose(client, target);
    off();
    target.dispatchEvent(new Event('pagehide'));
    expect(disconnect).not.toHaveBeenCalled();
  });
});
