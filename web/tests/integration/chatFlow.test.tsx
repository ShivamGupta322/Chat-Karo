import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createCredentialStore,
  createHttp,
  createSessionApi,
  createTokenManager,
  type DeviceCredential,
  type HttpResponseLike,
  type OnlineSource,
  type TimerHandle,
  type Timers,
} from '../../src/api';
import { createLocateApi } from '../../src/api/locate';
import { App } from '../../src/App';
import { RoomAssignerProvider, createRoomAssigner } from '../../src/geo';
import { initialIdentityState, useIdentityStore } from '../../src/state/identity';
import { IdentityProvider } from '../../src/state/IdentityProvider';
import { createIdentityController } from '../../src/state/identityController';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { AREA_TEXT, IDENTITY_TEXT } from '../../src/ui/text';
import { XmppProvider, createXmppClient } from '../../src/xmpp';
import {
  CELL_ROOM,
  groupchat as groupchatIn,
  mamResult,
  parse,
  presence as presenceIn,
  presenceError,
} from '../fixtures/stanzas';
import {
  createFakeGeolocation,
  createFakePermissions,
  installGeo,
  uninstallGeo,
  type FakeGeolocation,
} from '../helpers/fakeGeolocation';
import { createFakeTransport } from '../helpers/fakeTransport';
import { createMemoryStorage, type MemoryStorage } from '../helpers/memoryStorage';

const presence = (nick: string, codes: string[] = [], type?: string, room = CELL_ROOM): Element =>
  presenceIn(nick, codes, type, room);
const groupchat = (
  nick: string | null,
  body: string,
  extra = '',
  id = 'm1',
  room = CELL_ROOM,
): Element => groupchatIn(nick, body, extra, id, room);

const CELL_ROOM_B = 'g7_u4pruye@muc.chaterl.localhost';
const SPOT_A = { lat: 57.64911, lng: 10.40744 };
const MUC = 'muc.chaterl.localhost';
// What the browser must send: the centre of each cell (hard-coded geo_service values), never the raw spot.
const BODY_A = '{"lat":57.64869689941406,"lng":10.407485961914062}';
const BODY_B = '{"lat":57.64869689941406,"lng":10.408859252929688}';
const BODY_C = '{"lat":51.50733947753906,"lng":-0.1284027099609375}';
const CELL_ROOM_C = 'g7_gcpvj0d@muc.chaterl.localhost';
const CELL_OF_BODY: Record<string, string> = {
  [BODY_A]: 'u4pruyd',
  [BODY_B]: 'u4pruye',
  [BODY_C]: 'gcpvj0d',
};
const LOCATE_URL = '/api/locate';

const DOMAIN = 'chaterl.localhost';
const KEY = 'nearby.identity.v1';
/** The device credential a returning user has stored; its nickname is the MUC nick in the area tests. */
const STORED: DeviceCredential = {
  jid: `u${'a'.repeat(32)}@${DOMAIN}`,
  xmppPassword: `xp1_${'S'.repeat(32)}`,
  nickname: 'alice',
};
/** The identity the fake server hands out on POST /api/session. */
const NEW_JID = `u${'b'.repeat(32)}@${DOMAIN}`;
const NEW_PASSWORD = `xp1_${'N'.repeat(32)}`;
const TOKEN_CREATE = 'tokenCreate.payload.signature';
const TOKEN_RENEW = 'tokenRenew.payload.signature';

type Reply = HttpResponseLike | Promise<HttpResponseLike>;
interface Req {
  url: string;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}
type Route = (req: Req) => Reply;

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseLike => ({
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  text: () => Promise.resolve(JSON.stringify(body)),
});

/** The server's answer for the cell whose centre is in the body; a raw point (or anything else) is a 400. */
const locateAnswer = (req: Req): HttpResponseLike => {
  const cell = CELL_OF_BODY[req.body];
  if (cell === undefined) return reply(400, { error: 'invalid_location' });
  return reply(200, { cell, precision: 7, range: 'block', room_jid: `g7_${cell}@${MUC}` });
};

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A timer set the tests advance by hand, so userEvent keeps working on real timers. */
function manualTimers(): Timers & { advance(ms: number): Promise<void> } {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };
  return {
    set(fn, ms) {
      nextId += 1;
      pending.set(nextId, { at: now + ms, fn });
      return nextId as unknown as TimerHandle;
    },
    clear(h) {
      pending.delete(h as unknown as number);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

interface MountOptions {
  stored?: boolean;
  routes?: Partial<Record<'/api/session' | '/api/session/renew' | '/api/locate', Route>>;
  client?: Partial<Parameters<typeof createXmppClient>[1]>;
  failStorageWrites?: boolean;
}

interface Mounted {
  t: ReturnType<typeof createFakeTransport>;
  storage: MemoryStorage;
  requests: Req[];
  timers: ReturnType<typeof manualTimers>;
  net: { online: boolean; fire(): void };
}

describe('chat flow', () => {
  let geo: FakeGeolocation;
  let controller: ReturnType<typeof createIdentityController> | null = null;
  let assigner: ReturnType<typeof createRoomAssigner> | null = null;

  /** Lets the (granted) permission query settle, then delivers a device fix. */
  async function locate(point: { lat: number; lng: number } = SPOT_A): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      geo.emit(point.lat, point.lng);
    });
    await settle();
  }

  /** Lets the locate request, its answer and the resulting join/leave run to the end. */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 60; i += 1) await Promise.resolve();
    });
  }

  const locateRequests = (requests: Req[]): Req[] => requests.filter((r) => r.url === LOCATE_URL);

  /** The whole app on a fake transport, a fake network and an in-memory device store. */
  function mountApp(o: MountOptions = {}): Mounted {
    const t = createFakeTransport();
    const client = createXmppClient(t, {
      mucDomain: 'muc.chaterl.localhost',
      random: () => 0.5,
      ...o.client,
    });
    const storage = createMemoryStorage();
    const credentials = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => storage });
    if (o.stored === true) credentials.save(STORED);
    if (o.failStorageWrites === true) storage.failWrites();

    const requests: Req[] = [];
    const routes: Record<string, Route> = {
      '/api/session': (req) => {
        const nickname = (JSON.parse(req.body) as { nickname: string }).nickname;
        return reply(201, {
          jid: NEW_JID,
          xmpp_password: NEW_PASSWORD,
          nickname,
          token: TOKEN_CREATE,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      },
      '/api/session/renew': () =>
        reply(200, { nickname: STORED.nickname, token: TOKEN_RENEW, token_type: 'Bearer', expires_in: 3600 }),
      [LOCATE_URL]: locateAnswer,
      ...o.routes,
    };
    const timers = manualTimers();
    const http = createHttp({
      baseUrl: '/api',
      timers,
      fetch: (url, init) => {
        requests.push({
          url,
          body: typeof init.body === 'string' ? init.body : '',
          headers: init.headers as Record<string, string>,
          signal: init.signal ?? undefined,
        });
        const route = routes[url];
        if (!route) return Promise.resolve(reply(404, {}));
        try {
          return Promise.resolve(route(requests[requests.length - 1] as Req));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error('route failed'));
        }
      },
    });
    const session = createSessionApi(http, { xmppDomain: DOMAIN });
    const tokens = createTokenManager({ renew: session.renew, timers });
    controller = createIdentityController({ client, credentials, session, tokens });
    controller.start();
    const net = { online: true, listeners: new Set<() => void>(), fire: () => undefined as void };
    net.fire = () => {
      for (const l of [...net.listeners]) l();
    };
    const online: OnlineSource = {
      isOnline: () => net.online,
      subscribe: (cb) => {
        net.listeners.add(cb);
        return () => {
          net.listeners.delete(cb);
        };
      },
    };
    const locateApi = createLocateApi({ http, tokens, mucDomain: MUC });
    assigner = createRoomAssigner({ locate: locateApi, timers, online });
    render(
      <XmppProvider client={client}>
        <IdentityProvider controller={controller}>
          <RoomAssignerProvider assigner={assigner}>
            <App mapTileUrl={null} />
          </RoomAssignerProvider>
        </IdentityProvider>
      </XmppProvider>,
    );
    return { t, storage, requests, timers, net };
  }

  /** Reports the stored identity's connection as up and waits for the chat. */
  async function connectStored(t: ReturnType<typeof createFakeTransport>): Promise<void> {
    act(() => {
      t.pushStatus({ kind: 'connected', jid: `${STORED.jid}/r1` });
    });
    await screen.findByRole('button', { name: IDENTITY_TEXT.signOut });
  }

  async function signInAndJoin(t: ReturnType<typeof createFakeTransport>): Promise<void> {
    await connectStored(t);
    await locate();
    act(() => {
      t.pushStanza(presence('alice', ['110']));
    });
  }

  const typeName = async (
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ): Promise<void> => {
    await user.type(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel), name);
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
  };

  beforeEach(() => {
    useSessionStore.setState({ connection: { status: 'idle' } });
    useRoomStore.setState({ ...initialRoomState });
    useIdentityStore.setState({ ...initialIdentityState });
    geo = createFakeGeolocation();
    installGeo({ geolocation: geo, permissions: createFakePermissions('granted'), secure: true });
  });

  afterEach(() => {
    controller?.dispose();
    controller = null;
    assigner?.dispose();
    assigner = null;
    vi.useRealTimers();
    uninstallGeo();
  });

  describe('identity', () => {
    it('onboards a new name, stores it before connecting, joins with the nickname and chats', async () => {
      const { t, storage, requests } = mountApp();
      const user = userEvent.setup({ delay: null });
      // Welcome: no stored identity, so a name form and no connection.
      expect(screen.getByRole('heading', { level: 2, name: IDENTITY_TEXT.heading })).toBeInTheDocument();
      expect(t.connectCalls).toHaveLength(0);
      await typeName(user, 'Alice_1');

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('/api/session');
      expect(requests[0]?.body).toBe('{"nickname":"Alice_1"}');
      expect(storage.getItem(KEY)).toBe(
        `{"v":1,"jid":"${NEW_JID}","xmppPassword":"${NEW_PASSWORD}","nickname":"Alice_1"}`,
      );
      expect(storage.getItem(KEY)).not.toContain(TOKEN_CREATE);
      expect(t.connectCalls).toEqual([{ jid: NEW_JID, password: NEW_PASSWORD }]);
      // The first token was adopted, so there is no renew yet.
      expect(requests.filter((r) => r.url === '/api/session/renew')).toHaveLength(0);

      act(() => {
        t.pushStatus({ kind: 'connected', jid: `${NEW_JID}/r1` });
      });
      const signOut = await screen.findByRole('button', { name: 'Sign out' });
      const header = signOut.closest('header');
      expect(header).not.toBeNull();
      if (header) expect(within(header).getByText('Alice_1')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(NEW_JID.split('@')[0]);

      await locate();
      expect(screen.getByText(/You're in|Joining/)).toBeInTheDocument();
      // The MUC nick is the profile nickname, not the account's localpart.
      expect(t.sent.find((e) => e.getAttribute('to') === `${CELL_ROOM}/Alice_1`)).toBeDefined();
      expect(t.sent.some((e) => (e.getAttribute('to') ?? '').includes(NEW_JID.split('@')[0] ?? '?'))).toBe(false);
      act(() => {
        t.pushStanza(presence('bob'));
        t.pushStanza(presence('Alice_1', ['110']));
      });
      const occupants = await screen.findByRole('heading', { name: /People here/ });
      expect(occupants).toHaveTextContent(/People here.*2/);
      const section = occupants.closest('section');
      expect(section).not.toBeNull();
      if (section) {
        expect(within(section).getByText('bob')).toBeInTheDocument();
        expect(within(section).getByText('(you)', { exact: false })).toBeInTheDocument();
      }

      // send and see the echo
      await user.type(screen.getByLabelText('Message'), 'hello world{Enter}');
      const sent = t.sent.at(-1);
      expect(sent?.getAttribute('type')).toBe('groupchat');
      expect(sent?.querySelector('body')?.textContent).toBe('hello world');
      expect(within(screen.getByRole('log')).queryByText('hello world')).toBeNull();
      act(() => {
        t.pushStanza(groupchat('Alice_1', 'hello world', '', 'echo1'));
      });
      expect(within(screen.getByRole('log')).getByText('hello world')).toBeInTheDocument();

      // a rejected message produces a notice (server text is not rendered)
      act(() => {
        t.pushStanza(
          parse(
            `<message from="${CELL_ROOM}" type="error" id="x"><body>again</body><error code="404" type="cancel"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/><text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">This room is locked</text></error></message>`,
          ),
        );
      });
      const log = screen.getByRole('log');
      expect(
        within(log).getByText('Message not delivered: the room is unavailable or locked'),
      ).toBeInTheDocument();
      expect(within(log).queryByText(/This room is locked/)).toBeNull();
    }, 20_000);

    it('a returning device shows no form: it connects and renews before any user action', () => {
      const { t, requests } = mountApp({ stored: true });
      expect(screen.queryByLabelText(IDENTITY_TEXT.nicknameLabel)).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Signing you in as alice…');
      expect(t.connectCalls).toEqual([{ jid: STORED.jid, password: STORED.xmppPassword }]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('/api/session/renew');
      expect(requests[0]?.body).toBe(`{"jid":"${STORED.jid}","xmpp_password":"${STORED.xmppPassword}"}`);
      expect(requests[0]?.headers).not.toHaveProperty('authorization');
    });

    it('sign out, then "Continue as" reconnects with the same credential', async () => {
      const { t, storage } = mountApp({ stored: true });
      const user = userEvent.setup({ delay: null });
      await connectStored(t);
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(t.disconnectCalls).toEqual(['user']);
      expect(screen.getByRole('heading', { level: 2, name: IDENTITY_TEXT.returningHeading })).toHaveFocus();
      // Still closing: the choice is shown but cannot be used yet.
      expect(screen.getByRole('button', { name: 'Continue as alice' })).toHaveAttribute('aria-disabled', 'true');
      act(() => {
        t.pushStatus({ kind: 'disconnected' });
      });
      expect(screen.getByRole('button', { name: 'Continue as alice' })).toHaveAttribute('aria-disabled', 'false');
      expect(storage.getItem(KEY)).not.toBeNull();

      await user.click(screen.getByRole('button', { name: 'Continue as alice' }));
      expect(t.connectCalls).toHaveLength(2);
      expect(t.connectCalls[1]).toEqual({ jid: STORED.jid, password: STORED.xmppPassword });
      await connectStored(t);
      expect(screen.getByLabelText('Message')).toBeInTheDocument();
    }, 20_000);

    it('start over asks first: Escape cancels, confirming clears the stored name and shows the form', async () => {
      const { t, storage } = mountApp({ stored: true });
      const user = userEvent.setup({ delay: null });
      await connectStored(t);
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      act(() => {
        t.pushStatus({ kind: 'disconnected' });
      });
      const trigger = screen.getByRole('button', { name: IDENTITY_TEXT.startOver });
      await user.click(trigger);
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: IDENTITY_TEXT.cancel })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(trigger).toHaveFocus();
      expect(storage.getItem(KEY)).not.toBeNull();

      await user.click(trigger);
      await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.confirmAction }));
      expect(storage.getItem(KEY)).toBeNull();
      expect(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel)).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: IDENTITY_TEXT.heading })).toHaveFocus();
      expect(t.connectCalls).toHaveLength(1);
    }, 20_000);

    it('a taken name shows the field error and stores and connects nothing', async () => {
      const { t, storage } = mountApp({
        routes: { '/api/session': () => reply(409, { error: 'nickname_taken' }) },
      });
      const user = userEvent.setup({ delay: null });
      await typeName(user, 'Alice_1');
      expect(await screen.findByText(IDENTITY_TEXT.errorTaken)).toBeInTheDocument();
      expect(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel)).toHaveAttribute('aria-invalid', 'true');
      expect(storage.getItem(KEY)).toBeNull();
      expect(t.connectCalls).toHaveLength(0);
    }, 20_000);

    it.each<[string, NonNullable<MountOptions['routes']>]>([
      ['a 503', { '/api/session': () => reply(503, { error: 'service_unavailable' }) }],
      [
        'a rejected fetch',
        {
          '/api/session': () => {
            throw new TypeError('Failed to fetch');
          },
        },
      ],
    ])('%s shows the unavailable alert', async (_name, routes) => {
      const { t, storage } = mountApp({ routes });
      const user = userEvent.setup({ delay: null });
      await typeName(user, 'Alice_1');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Nearby can't create names right now. Try again in a few seconds.",
      );
      expect(storage.getItem(KEY)).toBeNull();
      expect(t.connectCalls).toHaveLength(0);
    }, 20_000);

    it('a create request that hangs for 15 s shows the unavailable alert', async () => {
      const { t, timers } = mountApp({
        routes: { '/api/session': () => new Promise<HttpResponseLike>(() => undefined) },
      });
      const user = userEvent.setup({ delay: null });
      await typeName(user, 'Alice_1');
      expect(screen.getByRole('button', { name: IDENTITY_TEXT.creating })).toHaveAttribute('aria-disabled', 'true');
      await act(async () => {
        await timers.advance(14_999);
      });
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => {
        await timers.advance(1);
      });
      expect(screen.getByRole('alert')).toHaveTextContent("Nearby can't create names right now.");
      expect(t.connectCalls).toHaveLength(0);
    }, 20_000);

    it('an auth failure for a stored name shows the error, Try again and Start over, and wipes nothing', async () => {
      const { t, storage } = mountApp({ stored: true });
      const user = userEvent.setup({ delay: null });
      act(() => {
        t.pushStatus({ kind: 'failed', reason: 'auth-failed' });
      });
      expect(screen.getByRole('alert')).toHaveTextContent("Nearby couldn't sign you in with this name.");
      expect(screen.getByRole('button', { name: IDENTITY_TEXT.startOver })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.tryAgain }));
      expect(t.connectCalls).toHaveLength(2);
      expect(storage.getItem(KEY)).not.toBeNull();
    }, 20_000);

    it('a renew 401 while connected keeps the chat, shows the notice and wipes nothing', async () => {
      const { t, storage } = mountApp({
        stored: true,
        routes: { '/api/session/renew': () => reply(401, { error: 'invalid_credentials' }) },
      });
      await connectStored(t);
      expect(await screen.findByRole('alert')).toHaveTextContent(IDENTITY_TEXT.identityInvalid);
      expect(screen.getByRole('button', { name: IDENTITY_TEXT.identityInvalidAction })).toBeInTheDocument();
      expect(t.disconnectCalls).toEqual([]);
      expect(screen.getByLabelText('Message')).toBeInTheDocument();
      expect(storage.getItem(KEY)).not.toBeNull();
    }, 20_000);

    it('a renew 503 while connected is silent, keeps XMPP up and retries after 5 s', async () => {
      const { t, requests, timers } = mountApp({
        stored: true,
        routes: { '/api/session/renew': () => reply(503, { error: 'service_unavailable' }) },
      });
      await connectStored(t);
      await act(async () => {
        await timers.advance(0);
      });
      const renews = (): number => requests.filter((r) => r.url === '/api/session/renew').length;
      expect(renews()).toBe(1);
      expect(screen.queryByText(IDENTITY_TEXT.identityInvalid)).toBeNull();
      expect(screen.queryByText(IDENTITY_TEXT.notRemembered)).toBeNull();
      await act(async () => {
        await timers.advance(4_999);
      });
      expect(renews()).toBe(1);
      await act(async () => {
        await timers.advance(1);
      });
      expect(renews()).toBe(2);
      expect(t.disconnectCalls).toEqual([]);
      expect(screen.getByLabelText('Message')).toBeInTheDocument();
    }, 20_000);

    it('a failed storage write still connects and says the name will not be remembered', async () => {
      const { t } = mountApp({ failStorageWrites: true });
      const user = userEvent.setup({ delay: null });
      await typeName(user, 'Alice_1');
      expect(t.connectCalls).toEqual([{ jid: NEW_JID, password: NEW_PASSWORD }]);
      act(() => {
        t.pushStatus({ kind: 'connected', jid: `${NEW_JID}/r1` });
      });
      expect(await screen.findByText(IDENTITY_TEXT.notRemembered)).toBeInTheDocument();
    }, 20_000);

    describe('privacy', () => {
      const spies = (): MockInstance[] =>
        (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
          vi.spyOn(console, m).mockImplementation(() => undefined),
        );
      const printed = (all: MockInstance[]): string =>
        all
          .flatMap((s) => s.mock.calls as unknown[][])
          .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
          .join('\n');
      const SECRETS = [NEW_PASSWORD, STORED.xmppPassword, TOKEN_CREATE, TOKEN_RENEW, 'Bearer'];

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('onboarding never logs the password or a token, and never stores a token', async () => {
        const all = spies();
        const { t, storage } = mountApp();
        const user = userEvent.setup({ delay: null });
        await typeName(user, 'Alice_1');
        act(() => {
          t.pushStatus({ kind: 'connected', jid: `${NEW_JID}/r1` });
        });
        await screen.findByRole('button', { name: 'Sign out' });
        const out = printed(all);
        for (const s of SECRETS) expect(out).not.toContain(s);
        expect(storage.getItem(KEY)).not.toContain(TOKEN_CREATE);
        expect(JSON.stringify(useIdentityStore.getState())).not.toMatch(/xp1_|tokenCreate|jid/);
      }, 20_000);

      it('a returning device never logs the password or a token', async () => {
        const all = spies();
        const { t, storage } = mountApp({ stored: true });
        await connectStored(t);
        for (const s of SECRETS) expect(printed(all)).not.toContain(s);
        expect(storage.getItem(KEY)).not.toContain(TOKEN_RENEW);
        expect(JSON.stringify(useIdentityStore.getState())).not.toMatch(/xp1_|tokenRenew|jid/);
      }, 20_000);

      it('a renew 401 never logs the password', async () => {
        const all = spies();
        const { t } = mountApp({
          stored: true,
          routes: { '/api/session/renew': () => reply(401, { error: 'invalid_credentials' }) },
        });
        await connectStored(t);
        await screen.findByRole('alert');
        for (const s of SECRETS) expect(printed(all)).not.toContain(s);
      }, 20_000);
    });
  });

  it('survives a dropped connection: banner, disabled composer, then rejoin keeps the timeline', async () => {
    const { t, timers } = mountApp({ stored: true });
    await signInAndJoin(t);
    act(() => {
      t.pushStanza(groupchat('bob', 'still here', '', 'm-keep'));
    });
    expect(within(screen.getByRole('log')).getByText('still here')).toBeInTheDocument();
    // The renew fired on start-up: the token is valid, and a dropped connection must not stop it.
    await act(async () => {
      await timers.advance(0);
    });
    expect(useIdentityStore.getState().token).toBe('valid');

    vi.useFakeTimers();
    act(() => {
      t.pushStatus({ kind: 'disconnected' });
    });
    // Chat stays mounted (no bounce to Welcome).
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByText('Connection lost.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try now' })).toBeInTheDocument();
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(within(screen.getByRole('log')).getByText('still here')).toBeInTheDocument();
    expect(useIdentityStore.getState().token).toBe('valid');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      t.pushStatus({ kind: 'connecting' });
      t.pushStatus({ kind: 'connected', jid: `${STORED.jid}/r2` });
    });
    act(() => {
      t.pushStanza(presence('alice', ['110']));
    });
    expect(screen.queryByText('Connection lost.')).toBeNull();
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(within(screen.getByRole('log')).getByText('still here')).toBeInTheDocument();
  }, 20_000);

  it('signing out while reconnecting shows the returning card and the next session starts clean', async () => {
    const { t } = mountApp({ stored: true });
    const user = userEvent.setup({ delay: null });
    await signInAndJoin(t);
    act(() => {
      t.pushStanza(presence('carol'));
      t.pushStanza(groupchat('bob', 'old message', '', 'm-old'));
    });
    const log = screen.getByRole('log');
    expect(within(log).getByText('carol joined')).toBeInTheDocument();

    act(() => {
      t.pushStatus({ kind: 'disconnected' });
    });
    expect(screen.getByText('Connection lost.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('button', { name: 'Continue as alice' })).toBeInTheDocument();
    expect(t.connectCalls).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Continue as alice' }));
    expect(t.connectCalls).toHaveLength(2);
    await signInAndJoin(t);
    expect(screen.queryByText('carol joined')).toBeNull();
    expect(screen.queryByText('old message')).toBeNull();
  }, 20_000);

  describe('area rooms', () => {
    const joinsTo = (t: ReturnType<typeof createFakeTransport>): string[] =>
      t.sent
        .filter(
          (e) =>
            e.localName === 'presence' && e.getAttribute('type') === null && e.hasAttribute('to'),
        )
        .map((e) => e.getAttribute('to') ?? '');
    const leavesTo = (t: ReturnType<typeof createFakeTransport>): string[] =>
      t.sent
        .filter((e) => e.localName === 'presence' && e.getAttribute('type') === 'unavailable')
        .map((e) => e.getAttribute('to') ?? '');
    const pick = async (name: string): Promise<void> => {
      act(() => {
        screen.getByRole('button', { name }).click();
      });
      await settle();
    };
    const pickSpotB = (): Promise<void> => pick('Test spot B (next to A)');
    const recent = (): string => new Date(Date.now() - 3_600_000).toISOString();
    const rsmFin = (complete: boolean, first: string, last: string): Element =>
      parse(
        `<iq type="result"><fin xmlns="urn:xmpp:mam:2" complete="${String(complete)}"><set xmlns="http://jabber.org/protocol/rsm"><first index="0">${first}</first><last>${last}</last></set></fin></iq>`,
      );

    it('placing the user in a located area joins that cell room and says so', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
      expect(screen.getByText(/You're in/)).toHaveTextContent("You're in Area u4pruyd as alice");
      expect(document.body.textContent).not.toContain('@muc');
    }, 20_000);

    it('a test spot in another cell leaves the old room and joins the new one with nothing carried over', async () => {
      const { t } = mountApp({ stored: true, client: { mamPageSize: 2 } });
      await signInAndJoin(t);
      act(() => {
        t.pushStanza(presence('bob'));
        t.pushStanza(
          mamResult({
            queryId: t.iqs[0]?.querySelector('query')?.getAttribute('queryid') ?? '',
            id: 'H3',
            stamp: recent(),
            from: CELL_ROOM,
            inner: `<message from="${CELL_ROOM}/bob" type="groupchat"><body>old message</body></message>`,
          }),
        );
      });
      await act(async () => {
        t.resolveIq(0, { ok: true, stanza: rsmFin(false, 'H3', 'H3') });
        await Promise.resolve();
      });
      expect(within(screen.getByRole('log')).getByText('old message')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument();

      await pickSpotB();

      expect(leavesTo(t)).toEqual([`${CELL_ROOM}/alice`]);
      expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM_B}/alice`]);
      expect(screen.queryByText('old message')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
      expect(screen.getByRole('heading', { name: /People here/ })).toHaveTextContent(
        /People here.*0/,
      );
      expect(screen.getByLabelText('Message')).toBeDisabled();
      expect(screen.getByText('Test spot')).toBeInTheDocument();
      expect(screen.getByText('Area u4pruye')).toBeInTheDocument();

      act(() => {
        t.pushStanza(presence('alice', ['110'], undefined, CELL_ROOM_B));
      });
      expect(screen.getByText(/You're in/)).toHaveTextContent("You're in Area u4pruye as alice");
      expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
      expect(screen.queryByText('old message')).toBeNull();

      // The new room's own history query targets the new room and decides about "Load earlier".
      await vi.waitFor(
        () => {
          expect(t.iqs).toHaveLength(2);
        },
        { timeout: 3_000 },
      );
      expect(t.iqs[1]?.getAttribute('to')).toBe(CELL_ROOM_B);
      act(() => {
        t.pushStanza(
          mamResult({
            queryId: t.iqs[1]?.querySelector('query')?.getAttribute('queryid') ?? '',
            id: 'B2',
            stamp: recent(),
            from: CELL_ROOM_B,
            inner: `<message from="${CELL_ROOM_B}/carol" type="groupchat"><body>new room message</body></message>`,
          }),
        );
      });
      await act(async () => {
        t.resolveIq(1, { ok: true, stanza: rsmFin(false, 'B2', 'B2') });
        await Promise.resolve();
      });
      expect(within(screen.getByRole('log')).getByText('new room message')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument();
    }, 20_000);

    it('a switch while reconnecting joins only the new room, once, after the connection is back', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      vi.useFakeTimers();
      act(() => {
        t.pushStatus({ kind: 'disconnected' });
      });
      const sentBefore = t.sent.length;
      await pickSpotB();
      expect(t.sent).toHaveLength(sentBefore);
      expect(screen.getByText('Reconnecting to the room…')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => {
        t.pushStatus({ kind: 'connecting' });
        t.pushStatus({ kind: 'connected', jid: `${STORED.jid}/r2` });
      });
      expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM_B}/alice`]);
      expect(leavesTo(t)).toEqual([]);
    }, 20_000);

    it('denied permission shows how to fix it, offers a test location, disables the composer and joins nothing', async () => {
      uninstallGeo();
      installGeo({
        geolocation: geo,
        permissions: createFakePermissions('denied'),
        secure: true,
      });
      const { t } = mountApp({ stored: true });
      await connectStored(t);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/Location is off for this site/)).toHaveTextContent(
        'Or choose a test location below.',
      );
      expect(screen.getByRole('button', { name: 'Try location again' })).toBeInTheDocument();
      expect(screen.getByLabelText('Message')).toBeDisabled();
      expect(
        screen.getByText('Share your location to chat with people nearby.'),
      ).toBeInTheDocument();
      expect(joinsTo(t)).toEqual([]);
      expect(geo.watchCalls()).toBe(0);
    }, 20_000);

    it('a re-render with a new-but-equal area state sends no stanzas', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      const before = t.sent.length;
      act(() => {
        geo.emit(57.6492, 10.4075); // same cell u4pruyd: a new fix, an equal area
      });
      act(() => {
        t.pushStanza(groupchat('bob', 'hi', '', 'm-rerender'));
      });
      expect(t.sent).toHaveLength(before);
    }, 20_000);

    it('"Join again" sits outside the status region, retries once and hands focus to the status line', async () => {
      const { t } = mountApp({ stored: true });
      const user = userEvent.setup({ delay: null });
      await connectStored(t);
      await locate();
      act(() => {
        t.pushStanza(presenceError('forbidden', CELL_ROOM));
      });
      const rejoin = screen.getByRole('button', { name: AREA_TEXT.rejoin });
      for (const status of screen.getAllByRole('status')) {
        expect(within(status).queryByRole('button')).toBeNull();
      }
      const joinsBefore = joinsTo(t).length;
      await user.click(rejoin);
      expect(joinsTo(t)).toHaveLength(joinsBefore + 1);
      expect(screen.queryByRole('button', { name: AREA_TEXT.rejoin })).toBeNull();
      expect(document.activeElement).toBe(screen.getByText(AREA_TEXT.joining('Area u4pruyd')));
    }, 20_000);

    describe('access recovery (ADR-020)', () => {
      it('a refused join locates once more, rejoins and ends joined without an error', async () => {
        const { t, requests } = mountApp({ stored: true });
        await connectStored(t);
        await locate();
        expect(locateRequests(requests)).toHaveLength(1);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        act(() => {
          t.pushStanza(presenceError('not-allowed', CELL_ROOM));
        });
        await settle();
        expect(locateRequests(requests)).toHaveLength(2);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM}/alice`]);
        expect(screen.getByText(AREA_TEXT.joining('Area u4pruyd'))).toBeInTheDocument();
        expect(screen.queryByText(AREA_TEXT.accessDenied)).toBeNull();
        expect(screen.queryByRole('button', { name: AREA_TEXT.rejoin })).toBeNull();
        act(() => {
          t.pushStanza(presence('alice', ['110']));
        });
        expect(screen.getByText(/You're in/)).toHaveTextContent("You're in Area u4pruyd as alice");
        expect(screen.queryByText(AREA_TEXT.accessDenied)).toBeNull();
        expect(locateRequests(requests)).toHaveLength(2);
      }, 20_000);

      it('a second refusal stops: a clear message and a keyboard-reachable Try again that locates and rejoins', async () => {
        const { t, requests } = mountApp({ stored: true });
        const user = userEvent.setup({ delay: null });
        await connectStored(t);
        await locate();
        act(() => {
          t.pushStanza(presenceError('registration-required', CELL_ROOM));
        });
        await settle();
        act(() => {
          t.pushStanza(presenceError('registration-required', CELL_ROOM));
        });
        await settle();
        // No loop: one automatic recovery, then the user decides.
        expect(locateRequests(requests)).toHaveLength(2);
        expect(joinsTo(t)).toHaveLength(2);
        const status = screen.getByText(AREA_TEXT.accessDenied);
        expect(status).toHaveAttribute('role', 'status');
        expect(screen.queryByRole('button', { name: AREA_TEXT.rejoin })).toBeNull();
        const retry = screen.getByRole('button', { name: AREA_TEXT.accessRetry });
        for (const s of screen.getAllByRole('status')) {
          expect(within(s).queryByRole('button')).toBeNull();
        }
        // Keyboard: reachable by Tab and activated with Enter.
        for (let i = 0; i < 40 && document.activeElement !== retry; i += 1) await user.tab();
        expect(document.activeElement).toBe(retry);
        await user.keyboard('{Enter}');
        expect(screen.queryByRole('button', { name: AREA_TEXT.accessRetry })).toBeNull();
        expect(document.activeElement).toBe(screen.getByText(AREA_TEXT.joining('Area u4pruyd')));
        await settle();
        expect(locateRequests(requests)).toHaveLength(3);
        expect(joinsTo(t)).toHaveLength(3);
        act(() => {
          t.pushStanza(presence('alice', ['110']));
        });
        expect(screen.getByText(/You're in/)).toBeInTheDocument();
        expect(locateRequests(requests)).toHaveLength(3);
      }, 30_000);

      it('other join failures keep "Join again" and never locate again', async () => {
        const { t, requests } = mountApp({ stored: true });
        await connectStored(t);
        await locate();
        act(() => {
          t.pushStanza(presenceError('forbidden', CELL_ROOM));
        });
        await settle();
        expect(locateRequests(requests)).toHaveLength(1);
        expect(screen.getByRole('button', { name: AREA_TEXT.rejoin })).toBeInTheDocument();
        expect(screen.queryByText(AREA_TEXT.accessDenied)).toBeNull();
      }, 20_000);
    });

    it('after leaving the room the status line says so', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      act(() => {
        t.pushStanza(presence('alice', ['110'], 'unavailable'));
      });
      expect(screen.getByText(AREA_TEXT.left)).toBeInTheDocument();
    }, 20_000);

    it('privacy: no coordinate or location field is ever put on the wire', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      await pickSpotB();
      act(() => {
        t.pushStanza(presence('alice', ['110'], undefined, CELL_ROOM_B));
      });
      await vi.waitFor(
        () => {
          expect(t.iqs).toHaveLength(2);
        },
        { timeout: 3_000 },
      );
      const wire = [...t.sent, ...t.iqs]
        .map((e) => new XMLSerializer().serializeToString(e))
        .join('\n');
      expect(wire.length).toBeGreaterThan(0);
      expect(wire).not.toMatch(/57\.6|10\.40|10\.408|51\.5|\b(lat|lon|lng|latitude|longitude)\b/i);
      expect(document.body.textContent).not.toMatch(/57\.6|10\.40|10\.408/);
    }, 20_000);

    describe('server-assigned rooms (POST /api/locate)', () => {
      const area = (name: string): HTMLElement => screen.getByRole('region', { name });
      const locateTexts = [
        AREA_TEXT.locateUnavailable,
        AREA_TEXT.locateOffline,
        AREA_TEXT.locateIdentityInvalid,
        AREA_TEXT.locateBadResponse,
      ];
      const noLocateText = (): void => {
        for (const text of locateTexts) expect(screen.queryByText(text)).toBeNull();
      };

      it('(a) sends only the cell centre, once per committed cell change, with the bearer token', async () => {
        const { t, requests } = mountApp({ stored: true });
        await signInAndJoin(t);
        const first = locateRequests(requests);
        expect(first).toHaveLength(1);
        expect(first[0]?.body).toBe(BODY_A);
        expect(first[0]?.headers.authorization).toBe(`Bearer ${TOKEN_RENEW}`);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);

        const sent = t.sent.length;
        act(() => {
          geo.emit(57.6492, 10.4075); // same cell: a new fix, no new request
        });
        await settle();
        expect(locateRequests(requests)).toHaveLength(1);
        expect(t.sent).toHaveLength(sent);

        await pickSpotB();
        const all = locateRequests(requests);
        expect(all).toHaveLength(2);
        expect(all[1]?.body).toBe(BODY_B);
        expect(leavesTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM_B}/alice`]);
      }, 20_000);

      it('(b) joins nothing until the answer arrives, then joins the returned room_jid', async () => {
        const gate = deferred<HttpResponseLike>();
        const { t } = mountApp({ stored: true, routes: { [LOCATE_URL]: () => gate.promise } });
        await connectStored(t);
        await locate();
        expect(joinsTo(t)).toEqual([]);
        expect(screen.getByText(AREA_TEXT.assigning('Area u4pruyd'))).toBeInTheDocument();
        expect(screen.getByLabelText('Message')).toBeDisabled();
        gate.resolve(locateAnswer({ url: LOCATE_URL, body: BODY_A, headers: {}, signal: undefined }));
        await settle();
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
      }, 20_000);

      it('(c) keeps the old room, label and composer while the next answer is pending', async () => {
        const gate = deferred<HttpResponseLike>();
        const { t } = mountApp({
          stored: true,
          routes: { [LOCATE_URL]: (req) => (req.body === BODY_B ? gate.promise : locateAnswer(req)) },
        });
        await signInAndJoin(t);
        await pickSpotB();
        expect(leavesTo(t)).toEqual([]);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(screen.getByText(/You're in/)).toHaveTextContent("You're in Area u4pruyd as alice");
        expect(screen.getByLabelText('Message')).toBeEnabled();
        expect(within(area('Your area')).getByText(AREA_TEXT.assigning('Area u4pruye'))).toBeInTheDocument();

        gate.resolve(locateAnswer({ url: LOCATE_URL, body: BODY_B, headers: {}, signal: undefined }));
        await settle();
        expect(leavesTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM_B}/alice`]);
      }, 20_000);

      it('(d) a newer pick aborts the pending request and ignores its late answer', async () => {
        const gate = deferred<HttpResponseLike>();
        const { t, requests } = mountApp({
          stored: true,
          routes: { [LOCATE_URL]: (req) => (req.body === BODY_B ? gate.promise : locateAnswer(req)) },
        });
        await signInAndJoin(t);
        await pickSpotB();
        await pick('Test spot C (far away)');
        const all = locateRequests(requests);
        expect(all.map((r) => r.body)).toEqual([BODY_A, BODY_B, BODY_C]);
        expect(all[1]?.signal?.aborted).toBe(true);
        gate.resolve(locateAnswer({ url: LOCATE_URL, body: BODY_B, headers: {}, signal: undefined }));
        await settle();
        expect(leavesTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM_C}/alice`]);
      }, 20_000);

      it('(e) a 503 shows the message and the button, leaves the room, and recovers by itself', async () => {
        let calls = 0;
        const { t, timers } = mountApp({
          stored: true,
          routes: {
            [LOCATE_URL]: (req) => {
              if (req.body === BODY_B) {
                calls += 1;
                if (calls === 1) return reply(503, { error: 'service_unavailable' }, { 'retry-after': '5' });
              }
              return locateAnswer(req);
            },
          },
        });
        await signInAndJoin(t);
        await pickSpotB();
        expect(screen.getByText(AREA_TEXT.locateUnavailable)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: AREA_TEXT.retryAssign })).toBeInTheDocument();
        expect(leavesTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(screen.getByLabelText('Message')).toBeDisabled();
        expect(screen.getByText(AREA_TEXT.emptyUnassigned)).toBeInTheDocument();

        await act(async () => {
          await timers.advance(4_999);
        });
        expect(calls).toBe(1);
        await act(async () => {
          await timers.advance(1);
        });
        await settle();
        expect(calls).toBe(2);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`, `${CELL_ROOM_B}/alice`]);
        noLocateText();
      }, 20_000);

      it('(e2) "Find my area chat" retries at once', async () => {
        let calls = 0;
        const { t } = mountApp({
          stored: true,
          routes: {
            [LOCATE_URL]: (req) => {
              calls += 1;
              return calls === 1 ? reply(503, { error: 'service_unavailable' }) : locateAnswer(req);
            },
          },
        });
        const user = userEvent.setup({ delay: null });
        await connectStored(t);
        await locate();
        expect(screen.getByText(AREA_TEXT.locateUnavailable)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: AREA_TEXT.retryAssign }));
        await settle();
        expect(calls).toBe(2);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(document.activeElement).toBe(area('Your area'));
      }, 20_000);

      it('(f) offline: no request and an offline message; coming back online asks and joins', async () => {
        const { t, requests, net } = mountApp({ stored: true });
        await connectStored(t);
        net.online = false;
        await locate();
        expect(locateRequests(requests)).toHaveLength(0);
        expect(screen.getByText(AREA_TEXT.locateOffline)).toBeInTheDocument();
        net.online = true;
        act(() => {
          net.fire();
        });
        await settle();
        expect(locateRequests(requests)).toHaveLength(1);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        noLocateText();
      }, 20_000);

      it('(g) a 401 on the first token renews and retries without an error', async () => {
        let calls = 0;
        const { t, requests } = mountApp({
          stored: true,
          routes: {
            [LOCATE_URL]: (req) => {
              calls += 1;
              return calls === 1 ? reply(401, { error: 'unauthorized' }) : locateAnswer(req);
            },
          },
        });
        await signInAndJoin(t);
        expect(calls).toBe(2);
        expect(requests.filter((r) => r.url === '/api/session/renew')).toHaveLength(2);
        expect(joinsTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        noLocateText();
      }, 20_000);

      it('(h) a rejected identity: no locate request, no join, the message and the Start over banner', async () => {
        const { t, requests } = mountApp({
          stored: true,
          routes: { '/api/session/renew': () => reply(401, { error: 'invalid_credentials' }) },
        });
        await connectStored(t);
        await locate();
        expect(locateRequests(requests)).toHaveLength(0);
        expect(joinsTo(t)).toEqual([]);
        expect(screen.getByText(AREA_TEXT.locateIdentityInvalid)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: AREA_TEXT.retryAssign })).toBeNull();
        expect(screen.getByRole('alert')).toHaveTextContent(IDENTITY_TEXT.identityInvalid);
      }, 20_000);

      it('(i) a room_jid on another domain is rejected and nothing is joined', async () => {
        const { t } = mountApp({
          stored: true,
          routes: {
            [LOCATE_URL]: () =>
              reply(200, {
                cell: 'u4pruyd',
                precision: 7,
                range: 'block',
                room_jid: 'g7_u4pruyd@muc.evil.example',
              }),
          },
        });
        await connectStored(t);
        await locate();
        expect(screen.getByText(AREA_TEXT.locateBadResponse)).toBeInTheDocument();
        expect(joinsTo(t)).toEqual([]);
        expect(document.body.textContent).not.toContain('evil');
      }, 20_000);

      it('(j) losing the location while located leaves the room', async () => {
        const { t } = mountApp({ stored: true });
        await signInAndJoin(t);
        act(() => {
          geo.fail(1);
        });
        await settle();
        expect(leavesTo(t)).toEqual([`${CELL_ROOM}/alice`]);
        expect(screen.getByLabelText('Message')).toBeDisabled();
      }, 20_000);

      it('(k) privacy: no coordinate in a store, the console, or a request body', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
          vi.spyOn(console, m).mockImplementation(() => undefined),
        );
        const { t, requests } = mountApp({ stored: true });
        await signInAndJoin(t);
        await pickSpotB();
        await pick('Test spot C (far away)');

        const bodies = locateRequests(requests).map((r) => r.body);
        expect(bodies).toEqual([BODY_A, BODY_B, BODY_C]);
        expect(
          bodies.some((b) => /57\.64911|10\.40744|10\.4087\b|51\.5074\b|-0\.1278|accuracy|range/.test(b)),
        ).toBe(false);

        const stores = JSON.stringify([
          useRoomStore.getState(),
          useSessionStore.getState(),
          useIdentityStore.getState(),
        ]);
        expect(stores).not.toMatch(/57\.64|10\.40|51\.50|"lat"|"lng"/);

        const logged = spies
          .flatMap((s) => s.mock.calls)
          .map((args) => args.map((a) => String(a)).join(' '))
          .join('\n');
        expect(logged).not.toMatch(/57\.6|10\.40|51\.50|"lat"|"lng"/);
        for (const s of spies) s.mockRestore();
      }, 20_000);
    });
  });

  describe('room history', () => {
    const recent = (): string => new Date(Date.now() - 3_600_000).toISOString();
    const finIq = (complete: boolean, last: string): Element =>
      parse(
        `<iq type="result"><fin xmlns="urn:xmpp:mam:2" complete="${String(complete)}"><set xmlns="http://jabber.org/protocol/rsm"><first index="0">${last}</first><last>${last}</last></set></fin></iq>`,
      );
    const queryIdOf = (t: ReturnType<typeof createFakeTransport>, i: number): string =>
      t.iqs[i]?.querySelector('query')?.getAttribute('queryid') ?? '';
    const pushResult = (
      t: ReturnType<typeof createFakeTransport>,
      i: number,
      id: string,
      nick: string,
      body: string,
    ): void => {
      act(() => {
        t.pushStanza(
          mamResult({
            queryId: queryIdOf(t, i),
            id,
            stamp: recent(),
            from: CELL_ROOM,
            inner: `<message from="${CELL_ROOM}/${nick}" type="groupchat"><body>${body}</body></message>`,
          }),
        );
      });
    };
    const answer = async (
      t: ReturnType<typeof createFakeTransport>,
      i: number,
      complete: boolean,
      last: string,
    ): Promise<void> => {
      await act(async () => {
        t.resolveIq(i, { ok: true, stanza: finIq(complete, last) });
        await Promise.resolve();
      });
    };

    it('shows the last messages from the archive with the divider, and de-dupes a later live copy', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      expect(t.iqs).toHaveLength(1);
      expect(screen.getByText('Loading recent messages…', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');

      pushResult(t, 0, 'H1', 'bob', 'first from history');
      pushResult(t, 0, 'H2', 'carol', 'second from history');
      await answer(t, 0, true, 'H2');

      const log = screen.getByRole('log');
      expect(within(log).getByText('first from history')).toBeInTheDocument();
      expect(within(log).getByText('second from history')).toBeInTheDocument();
      expect(within(log).getByRole('separator')).toBeInTheDocument();
      expect(log).not.toHaveAttribute('aria-busy');
      expect(screen.queryByText('Loading recent messages…')).toBeNull();

      act(() => {
        t.pushStanza(
          groupchat(
            'carol',
            'second from history',
            `<stanza-id xmlns="urn:xmpp:sid:0" id="H2" by="${CELL_ROOM}"/>`,
            'live-copy',
          ),
        );
      });
      expect(within(log).getAllByText('second from history')).toHaveLength(1);
    }, 20_000);

    it('shows a retry when history cannot load and asks again on "Try again"', async () => {
      const { t } = mountApp({ stored: true });
      const user = userEvent.setup({ delay: null });
      await signInAndJoin(t);
      await act(async () => {
        t.resolveIq(0, { ok: false, condition: 'resource-constraint' });
        await Promise.resolve();
      });
      expect(screen.getByText("Couldn't load recent messages.")).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      // The shared throttle may hold the retry back for up to 1.1 s.
      await vi.waitFor(
        () => {
          expect(t.iqs).toHaveLength(2);
        },
        { timeout: 3_000 },
      );
      expect(screen.queryByText("Couldn't load recent messages.")).toBeNull();
      expect(screen.getByText('Loading recent messages…', { selector: 'p' })).toBeInTheDocument();
    }, 20_000);

    it('after a reconnect, fetches only what was missed, forward from the last id, without duplicates', async () => {
      const { t } = mountApp({ stored: true });
      await signInAndJoin(t);
      pushResult(t, 0, 'H1', 'bob', 'before the outage');
      await answer(t, 0, true, 'H1');

      vi.useFakeTimers();
      act(() => {
        t.pushStatus({ kind: 'disconnected' });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => {
        t.pushStatus({ kind: 'connecting' });
        t.pushStatus({ kind: 'connected', jid: `${STORED.jid}/r2` });
      });
      act(() => {
        t.pushStanza(presence('alice', ['110']));
      });
      act(() => {
        vi.advanceTimersByTime(1_200);
      });
      expect(t.iqs).toHaveLength(2);
      const gap = t.iqs[1];
      expect(gap?.querySelector('after')?.textContent).toBe('H1');
      expect(gap?.querySelector('before')).toBeNull();

      pushResult(t, 1, 'H1', 'bob', 'before the outage');
      pushResult(t, 1, 'H3', 'carol', 'while you were away');
      await answer(t, 1, true, 'H3');

      const log = screen.getByRole('log');
      expect(within(log).getAllByText('before the outage')).toHaveLength(1);
      expect(within(log).getAllByText('while you were away')).toHaveLength(1);
    }, 20_000);

    describe('load earlier messages', () => {
      const rsmFin = (complete: boolean, first: string, last: string): Element =>
        parse(
          `<iq type="result"><fin xmlns="urn:xmpp:mam:2" complete="${String(complete)}"><set xmlns="http://jabber.org/protocol/rsm"><first index="0">${first}</first><last>${last}</last></set></fin></iq>`,
        );
      const answerRsm = async (
        t: ReturnType<typeof createFakeTransport>,
        i: number,
        complete: boolean,
        first: string,
        last: string,
      ): Promise<void> => {
        await act(async () => {
          t.resolveIq(i, { ok: true, stanza: rsmFin(complete, first, last) });
          await Promise.resolve();
        });
      };
      const BUTTON = { name: 'Load earlier messages' };

      async function reachIncompleteHistory(): Promise<{
        t: ReturnType<typeof createFakeTransport>;
        user: ReturnType<typeof userEvent.setup>;
      }> {
        const { t } = mountApp({ stored: true, client: { mamPageSize: 2 } });
        const user = userEvent.setup({ delay: null });
        await signInAndJoin(t);
        expect(screen.queryByRole('button', BUTTON)).toBeNull();
        pushResult(t, 0, 'H3', 'bob', 'body H3');
        pushResult(t, 0, 'H4', 'bob', 'body H4');
        await answerRsm(t, 0, false, 'H3', 'H4');
        return { t, user };
      }

      it('pages back above what is shown, keeps one divider, then withdraws the button', async () => {
        const { t, user } = await reachIncompleteHistory();
        const button = screen.getByRole('button', BUTTON);
        expect(within(screen.getByRole('log')).queryByRole('button')).toBeNull();
        await user.click(button);
        // The shared throttle may hold the query back for up to 1.1 s.
        await vi.waitFor(
          () => {
            expect(t.iqs).toHaveLength(2);
          },
          { timeout: 3_000 },
        );
        const iq = t.iqs[1];
        expect(iq?.querySelector('before')?.textContent).toBe('H3');
        expect(iq?.querySelector('after')).toBeNull();
        expect(screen.getByRole('button', { name: 'Loading earlier messages…' })).toHaveAttribute(
          'aria-disabled',
          'true',
        );

        pushResult(t, 1, 'H1', 'carol', 'body H1');
        pushResult(t, 1, 'H2', 'carol', 'body H2');
        await answerRsm(t, 1, true, 'H1', 'H2');

        const log = screen.getByRole('log');
        const bubbles = within(log)
          .getAllByText(/^body H\d$/)
          .map((el) => el.textContent);
        expect(bubbles).toEqual(['body H1', 'body H2', 'body H3', 'body H4']);
        expect(screen.queryByRole('button', BUTTON)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Loading earlier messages…' })).toBeNull();
        const separators = within(log).getAllByRole('separator');
        expect(separators).toHaveLength(1);
        expect(separators[0]?.previousElementSibling).toHaveTextContent('body H4');
        expect(log).toHaveFocus();

        act(() => {
          t.pushStanza(
            groupchat(
              'carol',
              'body H2',
              `<stanza-id xmlns="urn:xmpp:sid:0" id="H2" by="${CELL_ROOM}"/>`,
              'live-copy',
            ),
          );
        });
        expect(within(log).getAllByText('body H2')).toHaveLength(1);
      }, 20_000);

      it('shows its own error and "Try again", never the recent-messages banner, and retries the same page', async () => {
        const { t, user } = await reachIncompleteHistory();
        await user.click(screen.getByRole('button', BUTTON));
        await vi.waitFor(
          () => {
            expect(t.iqs).toHaveLength(2);
          },
          { timeout: 3_000 },
        );
        await act(async () => {
          t.resolveIq(1, { ok: false, condition: 'resource-constraint' });
          await Promise.resolve();
        });
        expect(screen.getByText("Couldn't load earlier messages.")).toBeInTheDocument();
        expect(screen.queryByText("Couldn't load recent messages.")).toBeNull();
        const retry = screen.getByRole('button', { name: 'Try again' });
        expect(retry).toHaveAccessibleDescription("Couldn't load earlier messages.");
        await user.click(retry);
        await vi.waitFor(
          () => {
            expect(t.iqs).toHaveLength(3);
          },
          { timeout: 3_000 },
        );
        expect(t.iqs[2]?.querySelector('before')?.textContent).toBe('H3');
        expect(screen.queryByText("Couldn't load recent messages.")).toBeNull();
      }, 20_000);
    });
  });
});
