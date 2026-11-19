import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindXmppToStores } from '../../src/state/bindXmpp';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { planRoomActions, useAreaRoom } from '../../src/state/useAreaRoom';
import { createXmppClient } from '../../src/xmpp/client';
import { presence } from '../fixtures/stanzas';
import { createFakeTransport, type FakeTransport } from '../helpers/fakeTransport';

const MUC = 'muc.chaterl.localhost';
const R1 = `g7_u4pruyd@${MUC}`;
const R2 = `g7_u4pruye@${MUC}`;

describe('planRoomActions', () => {
  const none = { roomJid: null, status: 'none' } as const;

  it('first join: nothing current, connected -> join', () => {
    expect(planRoomActions({ desired: R1, connected: true, current: none })).toEqual([
      { kind: 'join', roomJid: R1 },
    ]);
  });

  it('never joins while disconnected', () => {
    expect(planRoomActions({ desired: R1, connected: false, current: none })).toEqual([]);
  });

  it.each(['joining', 'joined', 'reconnecting'] as const)(
    'switch from a %s room: leave then join, in that order',
    (status) => {
      expect(
        planRoomActions({ desired: R2, connected: true, current: { roomJid: R1, status } }),
      ).toEqual([
        { kind: 'leave', roomJid: R1 },
        { kind: 'join', roomJid: R2 },
      ]);
    },
  );

  it('switch while disconnected: leave now, join later', () => {
    expect(
      planRoomActions({
        desired: R2,
        connected: false,
        current: { roomJid: R1, status: 'reconnecting' },
      }),
    ).toEqual([{ kind: 'leave', roomJid: R1 }]);
  });

  it.each(['joining', 'joined', 'reconnecting', 'failed', 'left'] as const)(
    'the same desired room (%s) needs no action',
    (status) => {
      expect(
        planRoomActions({ desired: R1, connected: true, current: { roomJid: R1, status } }),
      ).toEqual([]);
    },
  );

  it.each(['failed', 'left'] as const)('a %s other room is not left again, only the new one joined', (status) => {
    expect(
      planRoomActions({ desired: R2, connected: true, current: { roomJid: R1, status } }),
    ).toEqual([{ kind: 'join', roomJid: R2 }]);
  });

  it('desired null leaves an active room and nothing else', () => {
    expect(
      planRoomActions({ desired: null, connected: true, current: { roomJid: R1, status: 'joined' } }),
    ).toEqual([{ kind: 'leave', roomJid: R1 }]);
    expect(
      planRoomActions({ desired: null, connected: true, current: { roomJid: R1, status: 'left' } }),
    ).toEqual([]);
    expect(planRoomActions({ desired: null, connected: true, current: none })).toEqual([]);
  });
});

describe('useAreaRoom', () => {
  let t: FakeTransport;
  let client: ReturnType<typeof createXmppClient>;
  let unbind: () => void;

  const joinTargets = (): string[] =>
    t.sent
      .filter(
        (e) =>
          e.localName === 'presence' && e.getAttribute('type') === null && e.hasAttribute('to'),
      )
      .map((e) => e.getAttribute('to') ?? '');
  const leaveTargets = (): string[] =>
    t.sent
      .filter((e) => e.localName === 'presence' && e.getAttribute('type') === 'unavailable')
      .map((e) => e.getAttribute('to') ?? '');
  const connect = (resource = 'r1'): void => {
    client.connect('alice@chaterl.localhost', 'pw');
    act(() => {
      t.pushStatus({ kind: 'connecting' });
      t.pushStatus({ kind: 'connected', jid: `alice@chaterl.localhost/${resource}` });
    });
  };
  const selfJoined = (room: string): void => {
    act(() => {
      t.pushStanza(presence('alice', ['110'], undefined, room));
    });
  };
  const mount = (desired: string | null, strict = false): ReturnType<typeof renderHook<{ retry: () => void }, { desired: string | null }>> => {
    const wrapper = strict
      ? ({ children }: { children: ReactNode }): React.JSX.Element => <StrictMode>{children}</StrictMode>
      : undefined;
    return renderHook(({ desired: d }) => useAreaRoom(client, d, 'alice'), {
      initialProps: { desired },
      ...(wrapper ? { wrapper } : {}),
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useSessionStore.setState({ connection: { status: 'idle' } });
    useRoomStore.setState({ ...initialRoomState });
    t = createFakeTransport();
    client = createXmppClient(t, { mucDomain: MUC, random: () => 0.5 });
    unbind = bindXmppToStores(client);
  });

  afterEach(() => {
    unbind();
    vi.useRealTimers();
  });

  it('first join: exactly one join presence to the cell room with the nick', () => {
    connect();
    mount(R1);
    expect(joinTargets()).toEqual([`${R1}/alice`]);
  });

  it('waits for the connection before joining', () => {
    mount(R1);
    expect(joinTargets()).toEqual([]);
    connect();
    expect(joinTargets()).toEqual([`${R1}/alice`]);
  });

  it('switch: one unavailable presence to the old room, then one join to the new, in order', () => {
    connect();
    const hook = mount(R1);
    selfJoined(R1);
    const before = t.sent.length;
    hook.rerender({ desired: R2 });
    const after = t.sent.slice(before);
    expect(after.map((e) => `${e.getAttribute('type') ?? 'join'}:${e.getAttribute('to') ?? ''}`)).toEqual([
      `unavailable:${R1}/alice`,
      `join:${R2}/alice`,
    ]);
    expect(leaveTargets()).toHaveLength(1);
    expect(useRoomStore.getState().roomJid).toBe(R2);
    expect(useRoomStore.getState().status).toBe('joining');
  });

  it('switching back to the first room starts it fresh', () => {
    connect();
    const hook = mount(R1);
    selfJoined(R1);
    hook.rerender({ desired: R2 });
    selfJoined(R2);
    hook.rerender({ desired: R1 });
    expect(joinTargets()).toEqual([`${R1}/alice`, `${R2}/alice`, `${R1}/alice`]);
    expect(useRoomStore.getState().timeline).toEqual([]);
  });

  it('switch while reconnecting: no stanza, the old room is untracked, one join to the new room on connect', () => {
    connect();
    const hook = mount(R1);
    selfJoined(R1);
    act(() => {
      t.pushStatus({ kind: 'disconnected' });
    });
    expect(useSessionStore.getState().connection.status).toBe('reconnecting');
    const before = t.sent.length;
    hook.rerender({ desired: R2 });
    expect(t.sent).toHaveLength(before);
    expect(useRoomStore.getState().status).toBe('left');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    connect('r2');
    expect(joinTargets().filter((to) => to === `${R1}/alice`)).toHaveLength(1);
    expect(joinTargets().filter((to) => to === `${R2}/alice`)).toHaveLength(1);
    expect(joinTargets().at(-1)).toBe(`${R2}/alice`);
  });

  it('retry after a join timeout joins again', () => {
    connect();
    const hook = mount(R1);
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(useRoomStore.getState().status).toBe('failed');
    expect(joinTargets()).toHaveLength(1);
    // No automatic retry.
    expect(joinTargets()).toHaveLength(1);
    act(() => {
      hook.result.current.retry();
    });
    expect(joinTargets()).toEqual([`${R1}/alice`, `${R1}/alice`]);
    expect(useRoomStore.getState().status).toBe('joining');
  });

  it('retry does nothing without a desired room or a connection', () => {
    const hook = mount(null);
    act(() => {
      hook.result.current.retry();
    });
    expect(joinTargets()).toEqual([]);
    const hook2 = mount(R1);
    act(() => {
      hook2.result.current.retry();
    });
    expect(joinTargets()).toEqual([]);
  });

  it('desired null leaves the room', () => {
    connect();
    const hook = mount(R1);
    selfJoined(R1);
    hook.rerender({ desired: null });
    expect(leaveTargets()).toEqual([`${R1}/alice`]);
    expect(joinTargets()).toHaveLength(1);
  });

  it('StrictMode sends one join presence', () => {
    connect();
    mount(R1, true);
    expect(joinTargets()).toEqual([`${R1}/alice`]);
  });

  it('re-rendering with the same desired room sends nothing', () => {
    connect();
    const hook = mount(R1);
    selfJoined(R1);
    const before = t.sent.length;
    hook.rerender({ desired: R1 });
    hook.rerender({ desired: R1 });
    expect(t.sent).toHaveLength(before);
  });
});
