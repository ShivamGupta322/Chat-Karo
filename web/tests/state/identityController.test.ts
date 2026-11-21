import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialStore,
  createTokenManager,
  type ApiError,
  type ApiResult,
  type CreatedSession,
  type DeviceCredential,
  type SessionApi,
  type TokenManager,
  type TokenStatus,
} from "../../src/api";
import {
  initialIdentityState,
  useIdentityStore,
} from "../../src/state/identity";
import { createIdentityController } from "../../src/state/identityController";
import { createXmppClient } from "../../src/xmpp";
import { createFakeTransport } from "../helpers/fakeTransport";
import {
  createMemoryStorage,
  type MemoryStorage,
} from "../helpers/memoryStorage";

const DOMAIN = "chaterl.localhost";
const CRED: DeviceCredential = {
  jid: `u${"0123456789abcdef".repeat(2)}@${DOMAIN}`,
  xmppPassword: `xp1_${"A1_-".repeat(8)}`,
  nickname: "Alice_1",
};
const TOKEN = "SECRET.API.TOKEN";
const CREATED: CreatedSession = {
  credential: CRED,
  token: TOKEN,
  expiresIn: 3600,
};
const KEY = "nearby.identity.v1";

interface FakeTokens extends TokenManager {
  start: ReturnType<typeof vi.fn<TokenManager["start"]>>;
  stop: ReturnType<typeof vi.fn<TokenManager["stop"]>>;
  emit(s: TokenStatus): void;
  listenerCount(): number;
}

function fakeTokens(): FakeTokens {
  const listeners = new Set<(s: TokenStatus) => void>();
  let status: TokenStatus = { kind: "idle" };
  return {
    start: vi.fn<TokenManager["start"]>(),
    stop: vi.fn<TokenManager["stop"]>(),
    getToken: () => Promise.resolve({ ok: false, error: "stopped" }),
    withToken: () =>
      Promise.resolve({
        ok: false,
        error: { kind: "token", reason: "stopped" },
      }),
    getStatus: () => status,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    emit(s) {
      status = s;
      for (const l of [...listeners]) l(s);
    },
    listenerCount: () => listeners.size,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

function setup(opts: { stored?: boolean; tokens?: TokenManager } = {}): {
  t: ReturnType<typeof createFakeTransport>;
  storage: MemoryStorage;
  session: {
    create: ReturnType<typeof vi.fn<SessionApi["create"]>>;
    renew: SessionApi["renew"];
  };
  tokens: FakeTokens;
  ctl: ReturnType<typeof createIdentityController>;
  order: string[];
  client: ReturnType<typeof createXmppClient>;
} {
  const t = createFakeTransport();
  const order: string[] = [];
  const connect = t.connect.bind(t);
  t.connect = (jid, password, cb) => {
    order.push("connect");
    connect(jid, password, cb);
  };
  const client = createXmppClient(t, {
    mucDomain: `muc.${DOMAIN}`,
    random: () => 0.5,
  });
  const storage = createMemoryStorage();
  const credentials = createCredentialStore({
    xmppDomain: DOMAIN,
    slot: null,
    storage: () => storage,
  });
  if (opts.stored === true) credentials.save(CRED);
  storage.onWrite(() => order.push("save"));
  const session = {
    create: vi.fn<SessionApi["create"]>(),
    renew: vi.fn<SessionApi["renew"]>(),
  };
  const tokens = fakeTokens();
  const ctl = createIdentityController({
    client,
    credentials,
    session,
    tokens: opts.tokens ?? tokens,
  });
  return { t, storage, session, tokens, ctl, order, client };
}

const created = (): ApiResult<CreatedSession> => ({ ok: true, value: CREATED });

describe("identity controller", () => {
  let ctl: ReturnType<typeof createIdentityController> | null = null;

  beforeEach(() => {
    useIdentityStore.setState({ ...initialIdentityState });
  });
  afterEach(() => {
    ctl?.dispose();
    ctl = null;
  });

  it("start() without a credential shows onboarding and never connects", () => {
    const s = setup();
    ctl = s.ctl;
    s.ctl.start();
    expect(useIdentityStore.getState()).toEqual(initialIdentityState);
    expect(s.t.connectCalls).toHaveLength(0);
    expect(s.tokens.start).not.toHaveBeenCalled();
  });

  it("start() with a credential connects and renews in the same tick", () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    expect(s.t.connectCalls).toEqual([
      { jid: CRED.jid, password: CRED.xmppPassword },
    ]);
    expect(s.tokens.start).toHaveBeenCalledTimes(1);
    expect(s.tokens.start.mock.calls[0]).toEqual([CRED]);
    expect(useIdentityStore.getState()).toMatchObject({
      nickname: "Alice_1",
      intent: "active",
    });
  });

  it("onboard saves before it connects and starts the token with the first token", async () => {
    const s = setup();
    ctl = s.ctl;
    s.session.create.mockResolvedValue(created());
    s.ctl.start();
    await s.ctl.onboard("  Alice_1 ");
    expect(s.session.create).toHaveBeenCalledWith("Alice_1");
    expect(s.order).toEqual(["save", "connect"]);
    expect(s.storage.getItem(KEY)).toBe(
      `{"v":1,"jid":"${CRED.jid}","xmppPassword":"${CRED.xmppPassword}","nickname":"Alice_1"}`,
    );
    expect(s.t.connectCalls[0]).toEqual({
      jid: CRED.jid,
      password: CRED.xmppPassword,
    });
    expect(s.tokens.start.mock.calls[0]).toEqual([
      CRED,
      { token: TOKEN, expiresIn: 3600 },
    ]);
    expect(useIdentityStore.getState()).toMatchObject({
      nickname: "Alice_1",
      intent: "active",
      creating: false,
      remembered: true,
      onboardError: null,
    });
  });

  it("still connects when the credential cannot be saved, and says so", async () => {
    const s = setup();
    ctl = s.ctl;
    s.storage.failWrites();
    s.session.create.mockResolvedValue(created());
    s.ctl.start();
    await s.ctl.onboard("Alice_1");
    expect(s.t.connectCalls).toHaveLength(1);
    expect(useIdentityStore.getState().remembered).toBe(false);
    expect(s.storage.getItem(KEY)).toBeNull();
  });

  it.each<[string, ApiError, string]>([
    [
      "400",
      { kind: "http", status: 400, code: null, retryAfterMs: null },
      "invalid",
    ],
    [
      "409",
      { kind: "http", status: 409, code: "nickname_taken", retryAfterMs: null },
      "taken",
    ],
    [
      "503",
      { kind: "http", status: 503, code: null, retryAfterMs: null },
      "unavailable",
    ],
    [
      "502",
      { kind: "http", status: 502, code: null, retryAfterMs: null },
      "unavailable",
    ],
    [
      "504",
      { kind: "http", status: 504, code: null, retryAfterMs: null },
      "unavailable",
    ],
    ["timeout", { kind: "timeout" }, "unavailable"],
    ["network", { kind: "network" }, "unavailable"],
    [
      "500",
      { kind: "http", status: 500, code: null, retryAfterMs: null },
      "failed",
    ],
    [
      "413",
      { kind: "http", status: 413, code: null, retryAfterMs: null },
      "failed",
    ],
    [
      "415",
      { kind: "http", status: 415, code: null, retryAfterMs: null },
      "failed",
    ],
    [
      "404",
      { kind: "http", status: 404, code: null, retryAfterMs: null },
      "failed",
    ],
    ["bad-response", { kind: "bad-response" }, "failed"],
  ])(
    "maps a %s create failure to %s, with no save and no connect",
    async (_n, error, expected) => {
      const s = setup();
      ctl = s.ctl;
      s.session.create.mockResolvedValue({ ok: false, error });
      s.ctl.start();
      await s.ctl.onboard("Alice_1");
      expect(useIdentityStore.getState()).toMatchObject({
        creating: false,
        onboardError: expected,
        nickname: null,
      });
      expect(s.storage.getItem(KEY)).toBeNull();
      expect(s.t.connectCalls).toHaveLength(0);
      expect(s.tokens.start).not.toHaveBeenCalled();
    },
  );

  it("never rejects, even when create throws", async () => {
    const s = setup();
    ctl = s.ctl;
    s.session.create.mockRejectedValue(new Error("boom"));
    s.ctl.start();
    await expect(s.ctl.onboard("Alice_1")).resolves.toBeUndefined();
    expect(useIdentityStore.getState().onboardError).toBe("unavailable");
  });

  it("calls create once for a double onboard while creating", async () => {
    const s = setup();
    ctl = s.ctl;
    const d = deferred<ApiResult<CreatedSession>>();
    s.session.create.mockReturnValue(d.promise);
    s.ctl.start();
    const first = s.ctl.onboard("Alice_1");
    expect(useIdentityStore.getState().creating).toBe(true);
    await s.ctl.onboard("Alice_1");
    expect(s.session.create).toHaveBeenCalledTimes(1);
    d.resolve(created());
    await first;
    expect(s.t.connectCalls).toHaveLength(1);
    await s.ctl.onboard("Other");
    expect(s.session.create).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string]>([
    ["", "empty"],
    ["   ", "empty"],
    ["a", "invalid"],
    ["_bad", "invalid"],
  ])(
    "rejects the local nickname %j without calling create",
    async (raw, error) => {
      const s = setup();
      ctl = s.ctl;
      s.ctl.start();
      await s.ctl.onboard(raw);
      expect(s.session.create).not.toHaveBeenCalled();
      expect(useIdentityStore.getState()).toMatchObject({
        onboardError: error,
        creating: false,
      });
    },
  );

  it("signOut disconnects, stops the token, keeps the credential", () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    const before = s.storage.getItem(KEY);
    s.ctl.signOut();
    expect(s.t.disconnectCalls).toEqual(["user"]);
    expect(s.tokens.stop).toHaveBeenCalled();
    expect(useIdentityStore.getState().intent).toBe("signed-out");
    expect(s.storage.getItem(KEY)).toBe(before);
  });

  it("continueSession during disconnecting connects once, only after disconnected", async () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.ctl.signOut();
    s.ctl.continueSession();
    await tick();
    expect(s.t.connectCalls).toHaveLength(1);
    expect(s.tokens.start).toHaveBeenCalledTimes(2);
    s.t.pushStatus({ kind: "disconnected" });
    await tick();
    expect(s.t.connectCalls).toHaveLength(2);
    expect(s.t.connectCalls[1]).toEqual({
      jid: CRED.jid,
      password: CRED.xmppPassword,
    });
    // Only signOut stopped the token: the old session's disconnect must not kill the restarted one.
    expect(s.tokens.stop).toHaveBeenCalledTimes(1);
    await tick();
    expect(s.t.connectCalls).toHaveLength(2);
  });

  it("startOver while connected disconnects, stops the token, removes the key and resets", () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.ctl.startOver();
    expect(s.t.disconnectCalls).toEqual(["user"]);
    expect(s.tokens.stop).toHaveBeenCalled();
    expect(s.storage.getItem(KEY)).toBeNull();
    expect(useIdentityStore.getState()).toEqual(initialIdentityState);
  });

  it("startOver cancels a pending connect", async () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.ctl.signOut();
    s.ctl.continueSession();
    s.ctl.startOver();
    s.t.pushStatus({ kind: "disconnected" });
    await tick();
    expect(s.t.connectCalls).toHaveLength(1);
  });

  it("signOut cancels a pending connect", async () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.ctl.signOut();
    s.ctl.continueSession();
    s.ctl.signOut();
    s.t.pushStatus({ kind: "disconnected" });
    await tick();
    expect(s.t.connectCalls).toHaveLength(1);
  });

  it("an auth failure stops the token and keeps the stored credential", () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "failed", reason: "auth-failed" });
    expect(s.client.getState()).toMatchObject({ status: "disconnected" });
    expect(s.tokens.stop).toHaveBeenCalled();
    expect(s.storage.getItem(KEY)).not.toBeNull();
    expect(useIdentityStore.getState().intent).toBe("active");
  });

  it("does not stop the token on a dropped connection that is retrying", () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.t.pushStatus({ kind: "disconnected" });
    expect(s.client.getState().status).toBe("reconnecting");
    expect(s.tokens.stop).not.toHaveBeenCalled();
  });

  it("reflects the token status without touching XMPP", () => {
    const s = setup({ stored: true });
    ctl = s.ctl;
    s.ctl.start();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.tokens.emit({ kind: "identity-invalid" });
    expect(useIdentityStore.getState().token).toBe("identity-invalid");
    expect(s.t.disconnectCalls).toEqual([]);
    expect(s.client.getState().status).toBe("connected");
  });

  it("keeps the password and the token out of the store", async () => {
    const s = setup();
    ctl = s.ctl;
    s.session.create.mockResolvedValue(created());
    s.ctl.start();
    await s.ctl.onboard("Alice_1");
    s.tokens.emit({ kind: "valid", expiresAt: 123 });
    const state = JSON.stringify(useIdentityStore.getState());
    expect(state).not.toContain(CRED.xmppPassword);
    expect(state).not.toContain(TOKEN);
    expect(state).not.toContain(CRED.jid);
    expect(useIdentityStore.getState().token).toBe("valid");
  });

  it("dispose unsubscribes and stops the token", () => {
    const s = setup({ stored: true });
    s.ctl.start();
    expect(s.tokens.listenerCount()).toBe(1);
    s.ctl.dispose();
    expect(s.tokens.listenerCount()).toBe(0);
    expect(s.tokens.stop).toHaveBeenCalledTimes(1);
    s.tokens.emit({ kind: "failed" });
    expect(useIdentityStore.getState().token).not.toBe("failed");
    s.t.pushStatus({ kind: "failed", reason: "auth-failed" });
    expect(s.tokens.stop).toHaveBeenCalledTimes(1);
  });

  it("startOver then onboard while disconnecting keeps the new token manager running", async () => {
    const CRED2: DeviceCredential = {
      ...CRED,
      jid: `u${"fedcba9876543210".repeat(2)}@${DOMAIN}`,
      nickname: "Bob_1",
    };
    const renew = vi.fn<SessionApi["renew"]>().mockResolvedValue({
      ok: true,
      value: { nickname: "Alice_1", token: TOKEN, expiresIn: 3600 },
    });
    const real = createTokenManager({
      renew,
      online: { isOnline: () => true, subscribe: () => () => undefined },
    });
    const s = setup({ stored: true, tokens: real });
    ctl = s.ctl;
    s.session.create.mockResolvedValue({
      ok: true,
      value: { credential: CRED2, token: TOKEN, expiresIn: 3600 },
    });
    s.ctl.start();
    await tick();
    s.t.pushStatus({ kind: "connected", jid: `${CRED.jid}/r1` });
    s.ctl.startOver();
    await s.ctl.onboard("Bob_1");
    s.t.pushStatus({ kind: "disconnected" });
    await tick();
    expect(s.t.connectCalls).toHaveLength(2);
    expect(s.t.connectCalls[1]).toEqual({
      jid: CRED2.jid,
      password: CRED2.xmppPassword,
    });
    expect(real.getStatus().kind).toBe("valid");
  });

  it("works with the real token manager: valid after onboarding, idle after sign out", async () => {
    const renew = vi.fn<SessionApi["renew"]>();
    const real = createTokenManager({
      renew,
      online: { isOnline: () => true, subscribe: () => () => undefined },
    });
    const s = setup({ tokens: real });
    ctl = s.ctl;
    s.session.create.mockResolvedValue(created());
    s.ctl.start();
    await s.ctl.onboard("Alice_1");
    expect(useIdentityStore.getState().token).toBe("valid");
    expect(renew).not.toHaveBeenCalled();
    s.ctl.signOut();
    expect(useIdentityStore.getState().token).toBe("idle");
    expect(real.getStatus()).toEqual({ kind: "idle" });
  });
});
