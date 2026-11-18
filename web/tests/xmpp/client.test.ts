import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXmppClient } from "../../src/xmpp/client";
import type { XmppClient, XmppEvent } from "../../src/xmpp/types";
import {
  createFakeTransport,
  type FakeTransport,
} from "../helpers/fakeTransport";
import {
  CAPTURED_ROOM,
  CAPTURED_SELF_201,
  ROOM,
  groupchat,
  mamResult,
  parse,
  presence,
  presenceError,
} from "../fixtures/stanzas";
import { installPageHideClose } from "../../src/xmpp/pageHide";

const MUC = "muc.chaterl.localhost";
const ROOM2 = `test1@${MUC}`;
const PASSWORD = "hunter2-secret";

interface Ctx {
  t: FakeTransport;
  client: XmppClient;
  events: XmppEvent[];
}

function setup(): Ctx {
  const t = createFakeTransport();
  let n = 0;
  const client = createXmppClient(t, {
    mucDomain: MUC,
    newId: () => `id${++n}`,
    now: () => 1_000,
  });
  const events: XmppEvent[] = [];
  client.subscribe((e) => events.push(e));
  return { t, client, events };
}

function connect({ t, client }: Ctx): void {
  client.connect("alice@chaterl.localhost", PASSWORD);
  t.pushStatus({ kind: "connecting" });
  t.pushStatus({ kind: "connected", jid: "alice@chaterl.localhost/r1" });
}

function joined(ctx: Ctx, room = ROOM, nick = "alice"): void {
  ctx.client.joinRoom(room, nick);
  ctx.t.pushStanza(
    parse(
      `<presence from="${room}/${nick}"><x xmlns="http://jabber.org/protocol/muc#user"><status code="110"/></x></presence>`,
    ),
  );
}

const types = (events: XmppEvent[]): string[] => events.map((e) => e.type);
const joinPresences = (t: FakeTransport): string[] =>
  t.sent
    .filter(
      (e) =>
        e.localName === "presence" &&
        e.getAttribute("type") === null &&
        e.hasAttribute("to"),
    )
    .map((e) => e.getAttribute("to") ?? "");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connection", () => {
  it("emits connecting then connected and sends initial presence", () => {
    const ctx = setup();
    connect(ctx);
    const states = ctx.events.flatMap((e) =>
      e.type === "connection" ? [e.state.status] : [],
    );
    expect(states).toEqual(["connecting", "connected"]);
    expect(ctx.t.sentNames()).toEqual(["presence"]);
    expect(ctx.t.sent[0]?.hasAttribute("to")).toBe(false);
  });

  it("auth failure then disconnected ends disconnected with the error, emitted once", () => {
    const ctx = setup();
    ctx.client.connect("alice@chaterl.localhost", "bad");
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "failed", reason: "auth-failed" });
    ctx.t.pushStatus({ kind: "disconnected" });
    const finals = ctx.events.filter(
      (e) => e.type === "connection" && e.state.status === "disconnected",
    );
    expect(finals).toHaveLength(1);
    expect(ctx.client.getState()).toEqual({
      status: "disconnected",
      error: { reason: "auth-failed" },
    });
  });

  it("connect while connecting or connected is a no-op", () => {
    const ctx = setup();
    ctx.client.connect("alice@chaterl.localhost", "pw");
    ctx.client.connect("alice@chaterl.localhost", "pw");
    expect(ctx.t.connectCalls).toHaveLength(1);
    ctx.t.pushStatus({ kind: "connected", jid: "alice@chaterl.localhost/r1" });
    ctx.client.connect("alice@chaterl.localhost", "pw");
    expect(ctx.t.connectCalls).toHaveLength(1);
  });

  it("disconnect goes disconnecting then disconnected without error", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    expect(ctx.client.getState().status).toBe("disconnecting");
    expect(ctx.t.disconnectCalls).toEqual(["user"]);
    ctx.t.pushStatus({ kind: "disconnecting" });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
  });

  it("never keeps the password in state or events", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    expect(JSON.stringify(ctx.client.getState())).not.toContain(PASSWORD);
    expect(JSON.stringify(ctx.events)).not.toContain(PASSWORD);
    expect(ctx.t.connectCalls[0]?.password).toBe(PASSWORD);
  });

  it("can reconnect after a disconnect", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: "disconnected" });
    ctx.client.connect("alice@chaterl.localhost", "pw");
    expect(ctx.t.connectCalls).toHaveLength(2);
  });
});

describe("connection loss semantics", () => {
  const reconnecting = {
    status: "reconnecting",
    jid: "alice@chaterl.localhost/r1",
    attempt: 1,
  };

  it("an unexpected transport disconnect after a session starts reconnecting", () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toMatchObject(reconnecting);
  });

  it("a transport-initiated disconnecting then disconnected is still a loss, now retried", () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStatus({ kind: "disconnecting" });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toMatchObject(reconnecting);
  });

  it("a stream conflict (session replaced) is the remaining terminal connection-lost", () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStatus({
      kind: "failed",
      reason: "connection-failed",
      condition: "conflict",
    });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({
      status: "disconnected",
      error: { reason: "connection-lost", condition: "conflict" },
    });
  });

  it("a user disconnect has no error", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: "disconnecting" });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
  });

  it("a pagehide-triggered disconnect has no error", () => {
    const ctx = setup();
    connect(ctx);
    const target = new EventTarget();
    installPageHideClose(ctx.client, target);
    target.dispatchEvent(new Event("pagehide"));
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
  });

  it("auth failure then disconnected still reports auth-failed", () => {
    const ctx = setup();
    ctx.client.connect("alice@chaterl.localhost", "bad");
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "failed", reason: "auth-failed" });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({
      status: "disconnected",
      error: { reason: "auth-failed" },
    });
  });

  it("the user-initiated flag is cleared by the next connect", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: "disconnected" });
    connect(ctx);
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toMatchObject(reconnecting);
  });
});

describe("joining", () => {
  it("happy path: occupants then room-joined created=false, join asks for no MUC history (maxstanzas 0)", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presence("bob"));
    ctx.t.pushStanza(presence("carol"));
    ctx.t.pushStanza(presence("alice", ["110"]));
    const roomEvents = ctx.events.filter((e) => e.type !== "connection");
    expect(roomEvents).toEqual([
      { type: "room-joining", roomJid: ROOM, nick: "alice" },
      { type: "occupant-joined", roomJid: ROOM, nick: "bob", isSelf: false },
      { type: "occupant-joined", roomJid: ROOM, nick: "carol", isSelf: false },
      { type: "occupant-joined", roomJid: ROOM, nick: "alice", isSelf: true },
      { type: "room-joined", roomJid: ROOM, nick: "alice", created: false },
      { type: "history-loading", roomJid: ROOM, direction: "initial" },
    ]);
    const hist = ctx.t.sent[1]?.querySelector("history");
    expect(hist?.getAttribute("maxstanzas")).toBe("0");
  });

  it("a duplicate join sends one presence", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.client.joinRoom(ROOM, "alice");
    expect(joinPresences(ctx.t)).toHaveLength(1);
  });

  it("reports invalid room, invalid nick and not-connected without sending", () => {
    const ctx = setup();
    ctx.client.joinRoom(ROOM, "alice");
    expect(ctx.events.at(-1)).toMatchObject({
      type: "room-join-failed",
      reason: "not-connected",
    });
    connect(ctx);
    const before = ctx.t.sent.length;
    ctx.client.joinRoom("Bad Room@x", "alice");
    expect(ctx.events.at(-1)).toMatchObject({
      type: "room-join-failed",
      reason: "invalid-room",
    });
    ctx.client.joinRoom(ROOM, "   ");
    expect(ctx.events.at(-1)).toMatchObject({
      type: "room-join-failed",
      reason: "invalid-nick",
    });
    expect(ctx.t.sent).toHaveLength(before);
  });

  it("201 sends the instant-config IQ and reports created=true on success", async () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presence("alice", ["110", "201"]));
    expect(ctx.t.iqs).toHaveLength(1);
    expect(ctx.t.iqs[0]?.getAttribute("to")).toBe(ROOM);
    ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.events.find((e) => e.type === "room-joined")).toEqual({
      type: "room-joined",
      roomJid: ROOM,
      nick: "alice",
      created: true,
    });
  });

  it("real MongooseIM 201 frame sends one owner IQ; room-joined only after the result", async () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(CAPTURED_ROOM, "alice");
    ctx.t.pushStanza(CAPTURED_SELF_201);
    expect(ctx.t.iqs).toHaveLength(1);
    expect(ctx.t.iqs[0]?.querySelector("query")?.namespaceURI).toBe(
      "http://jabber.org/protocol/muc#owner",
    );
    expect(types(ctx.events)).not.toContain("room-joined");
    ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
    await vi.advanceTimersByTimeAsync(0);
    // One owner IQ, then the history query that follows room-joined.
    expect(ctx.t.iqs).toHaveLength(2);
    expect(ctx.t.iqs[1]?.querySelector("query")?.namespaceURI).toBe(
      "urn:xmpp:mam:2",
    );
    expect(ctx.events.find((e) => e.type === "room-joined")).toEqual({
      type: "room-joined",
      roomJid: CAPTURED_ROOM,
      nick: "alice",
      created: true,
    });
  });

  it("fails immediately when the room sends self unavailable while joining", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presence("alice", ["110"], "unavailable"));
    expect(ctx.events.at(-1)).toMatchObject({
      type: "room-join-failed",
      reason: "other",
    });
  });

  it.each([
    ["error", { ok: false as const, condition: "forbidden" }],
    ["timeout", { ok: false as const, condition: "timeout" }],
  ])(
    "201 with IQ %s leaves and reports room-config-failed",
    async (_n, result) => {
      const ctx = setup();
      connect(ctx);
      ctx.client.joinRoom(ROOM, "alice");
      ctx.t.pushStanza(presence("alice", ["110", "201"]));
      ctx.t.resolveIq(0, result);
      await vi.advanceTimersByTimeAsync(0);
      const last = ctx.t.sent.at(-1);
      expect(last?.getAttribute("type")).toBe("unavailable");
      expect(ctx.events.at(-1)).toEqual({
        type: "room-join-failed",
        roomJid: ROOM,
        reason: "room-config-failed",
        condition: result.condition,
      });
    },
  );

  it("retries a nick conflict as alice-2, alice-3, alice-4 then fails", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    for (let i = 0; i < 4; i++) ctx.t.pushStanza(presenceError("conflict"));
    expect(joinPresences(ctx.t)).toEqual([
      `${ROOM}/alice`,
      `${ROOM}/alice-2`,
      `${ROOM}/alice-3`,
      `${ROOM}/alice-4`,
    ]);
    expect(ctx.events.at(-1)).toEqual({
      type: "room-join-failed",
      roomJid: ROOM,
      reason: "conflict",
    });
    const joining = ctx.events.filter((e) => e.type === "room-joining");
    expect(joining).toHaveLength(4);
  });

  it("joins with the server-assigned nick from the 110 presence", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presence("alice-1", ["110", "210"]));
    expect(ctx.events.find((e) => e.type === "room-joined")).toMatchObject({
      type: "room-joined",
      nick: "alice-1",
    });
  });

  it("does not retry forbidden", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presenceError("forbidden"));
    expect(joinPresences(ctx.t)).toHaveLength(1);
    expect(ctx.events.at(-1)).toMatchObject({
      type: "room-join-failed",
      reason: "forbidden",
    });
  });

  it("maps unknown error conditions to other with the condition", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presenceError("resource-constraint"));
    expect(ctx.events.at(-1)).toEqual({
      type: "room-join-failed",
      roomJid: ROOM,
      reason: "other",
      condition: "resource-constraint",
    });
  });

  it("times out after 10 s, leaves, and ignores a late self presence", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    vi.advanceTimersByTime(10_000);
    expect(ctx.t.sent.at(-1)?.getAttribute("type")).toBe("unavailable");
    expect(ctx.events.at(-1)).toMatchObject({
      type: "room-join-failed",
      reason: "timeout",
    });
    const count = ctx.events.length;
    ctx.t.pushStanza(presence("alice", ["110"]));
    expect(ctx.events).toHaveLength(count);
  });
});

describe("occupants and leaving", () => {
  it("emits occupant-left for another user's unavailable", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presence("bob"));
    ctx.t.pushStanza(presence("alice", ["110"]));
    ctx.t.pushStanza(presence("bob", [], "unavailable"));
    expect(ctx.events.at(-1)).toEqual({
      type: "occupant-left",
      roomJid: ROOM,
      nick: "bob",
    });
  });

  it("self 307 emits room-left kicked", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(presence("alice", ["110", "307"], "unavailable"));
    expect(ctx.events.at(-1)).toEqual({
      type: "room-left",
      roomJid: ROOM,
      reason: "kicked",
    });
  });

  it("leaveRoom sends unavailable, emits room-left self, then ignores the room", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.client.leaveRoom(ROOM);
    expect(ctx.t.sent.at(-1)?.getAttribute("type")).toBe("unavailable");
    expect(ctx.events.at(-1)).toEqual({
      type: "room-left",
      roomJid: ROOM,
      reason: "self",
    });
    const count = ctx.events.length;
    ctx.t.pushStanza(presence("alice", ["110"], "unavailable"));
    ctx.t.pushStanza(presence("bob"));
    ctx.t.pushStanza(groupchat("bob", "hello"));
    expect(ctx.events).toHaveLength(count);
  });

  it("a transport drop suspends every room and starts reconnecting (no room-left)", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    ctx.t.pushStatus({
      kind: "failed",
      reason: "connection-failed",
      condition: "x",
    });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.events.filter((e) => e.type === "room-left")).toEqual([]);
    expect(ctx.events.filter((e) => e.type === "room-suspended")).toEqual([
      { type: "room-suspended", roomJid: ROOM },
      { type: "room-suspended", roomJid: ROOM2 },
    ]);
    expect(ctx.client.getState()).toMatchObject({ status: "reconnecting" });
  });

  it("an initial sign-in failure still leaves every room and ends disconnected with the error", () => {
    const ctx = setup();
    ctx.client.connect("alice@chaterl.localhost", PASSWORD);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({
      kind: "failed",
      reason: "connection-failed",
      condition: "x",
    });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({
      status: "disconnected",
      error: { reason: "connection-failed", condition: "x" },
    });
  });
});

describe("messages", () => {
  it("flags the echo of our own message as own", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(groupchat("alice", "hi"));
    ctx.t.pushStanza(groupchat("bob", "yo", "", "m2"));
    const msgs = ctx.events.flatMap((e) =>
      e.type === "message" ? [e.message] : [],
    );
    expect(msgs.map((m) => m.isOwn)).toEqual([true, false]);
    expect(msgs[0]).toMatchObject({
      body: "hi",
      sentAt: 1_000,
      isHistory: false,
    });
  });

  it("marks delayed messages as history", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(
      groupchat(
        "bob",
        "old",
        '<delay xmlns="urn:xmpp:delay" stamp="2024-01-02T03:04:05Z"/>',
      ),
    );
    const m = ctx.events.at(-1);
    expect(m).toMatchObject({ type: "message", message: { isHistory: true } });
  });

  it("ignores messages from untracked rooms", () => {
    const ctx = setup();
    connect(ctx);
    const count = ctx.events.length;
    ctx.t.pushStanza(groupchat("bob", "hello"));
    expect(ctx.events).toHaveLength(count);
  });

  it("reports message errors", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(
      parse(
        `<message from="${ROOM}" type="error"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></message>`,
      ),
    );
    expect(ctx.events.at(-1)).toEqual({
      type: "message-error",
      roomJid: ROOM,
      condition: "forbidden",
    });
  });
});

describe("sendGroupchat", () => {
  it("rejects empty, too-long, not-connected and not-joined without sending", () => {
    const ctx = setup();
    expect(ctx.client.sendGroupchat(ROOM, "hi")).toEqual({
      ok: false,
      error: "not-connected",
    });
    connect(ctx);
    const before = ctx.t.sent.length;
    expect(ctx.client.sendGroupchat(ROOM, "   ")).toEqual({
      ok: false,
      error: "empty",
    });
    expect(ctx.client.sendGroupchat(ROOM, "hi")).toEqual({
      ok: false,
      error: "not-joined",
    });
    joined(ctx);
    const afterJoin = ctx.t.sent.length;
    expect(ctx.client.sendGroupchat(ROOM, "😀".repeat(2001))).toEqual({
      ok: false,
      error: "too-long",
    });
    expect(ctx.t.sent).toHaveLength(afterJoin);
    expect(afterJoin).toBeGreaterThan(before);
  });

  it("accepts exactly 2000 code points", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    expect(ctx.client.sendGroupchat(ROOM, "😀".repeat(2000)).ok).toBe(true);
  });

  it("sends the trimmed body with the generated id", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    const res = ctx.client.sendGroupchat(ROOM, "  hello  ");
    // id1/id2 were taken by the history query that follows the join.
    expect(res).toEqual({ ok: true, id: "id3" });
    const sent = ctx.t.sent.at(-1);
    expect(sent?.getAttribute("type")).toBe("groupchat");
    expect(sent?.getAttribute("id")).toBe("id3");
    expect(sent?.querySelector("body")?.textContent).toBe("hello");
  });

  it("does not render optimistically", () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    const count = ctx.events.length;
    ctx.client.sendGroupchat(ROOM, "hello");
    expect(ctx.events).toHaveLength(count);
  });
});

describe("misc", () => {
  it("answers incoming iq get with service-unavailable and the same id", () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStanza(
      parse(
        '<iq from="chaterl.localhost" type="get" id="p1"><query xmlns="jabber:iq:version"/></iq>',
      ),
    );
    const reply = ctx.t.sent.at(-1);
    expect(reply?.localName).toBe("iq");
    expect(reply?.getAttribute("id")).toBe("p1");
    expect(reply?.getAttribute("type")).toBe("error");
    expect(reply?.querySelector("service-unavailable")).not.toBeNull();
  });

  it("does not reply to result iqs", () => {
    const ctx = setup();
    connect(ctx);
    const before = ctx.t.sent.length;
    ctx.t.pushStanza(parse('<iq type="result" id="r1"/>'));
    expect(ctx.t.sent).toHaveLength(before);
  });

  it("isolates a throwing subscriber", () => {
    const ctx = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ctx.client.subscribe(() => {
      throw new Error("boom");
    });
    const seen: string[] = [];
    ctx.client.subscribe((e) => seen.push(e.type));
    connect(ctx);
    expect(seen).toContain("connection");
    expect(types(ctx.events)).toContain("connection");
    spy.mockRestore();
  });

  it("unsubscribe stops delivery", () => {
    const ctx = setup();
    const seen: string[] = [];
    const off = ctx.client.subscribe((e) => seen.push(e.type));
    off();
    connect(ctx);
    expect(seen).toEqual([]);
  });
});

describe("reconnect", () => {
  const JID_R1 = "alice@chaterl.localhost/r1";
  const JID_R2 = "alice@chaterl.localhost/r2";
  let clock = 10_000;

  function setupR(): Ctx {
    clock = 10_000;
    const t = createFakeTransport();
    let n = 0;
    const client = createXmppClient(t, {
      mucDomain: MUC,
      newId: () => `id${++n}`,
      now: () => clock,
      random: () => 0.5,
    });
    const events: XmppEvent[] = [];
    client.subscribe((e) => events.push(e));
    return { t, client, events };
  }

  function advance(ms: number): void {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }

  const drop = (ctx: Ctx): void => {
    ctx.t.pushStatus({ kind: "disconnected" });
  };

  const delayOf = (ctx: Ctx): number => {
    const s = ctx.client.getState();
    if (s.status !== "reconnecting" || s.nextAttemptAt === null)
      throw new Error("no retry pending");
    return s.nextAttemptAt - clock;
  };

  /** Fire the pending retry timer and deliver connecting + connected on the new attempt. */
  function recover(ctx: Ctx, jid = JID_R2): void {
    advance(delayOf(ctx));
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "connected", jid });
  }

  it("a drop after a session reconnects after 1 s with the same credentials and suspends rooms", () => {
    const ctx = setupR();
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    drop(ctx);
    expect(ctx.client.getState()).toEqual({
      status: "reconnecting",
      jid: JID_R1,
      attempt: 1,
      nextAttemptAt: clock + 1000,
    });
    expect(ctx.events.filter((e) => e.type === "room-suspended")).toHaveLength(
      2,
    );
    expect(ctx.events.some((e) => e.type === "room-left")).toBe(false);
    advance(999);
    expect(ctx.t.connectCalls).toHaveLength(1);
    advance(1);
    expect(ctx.t.connectCalls).toHaveLength(2);
    expect(ctx.t.connectCalls[1]).toEqual({
      jid: "alice@chaterl.localhost",
      password: PASSWORD,
    });
    expect(ctx.client.getState()).toMatchObject({
      status: "reconnecting",
      nextAttemptAt: null,
    });
    // The transport's own 'connecting' does not change the state.
    ctx.t.pushStatus({ kind: "connecting" });
    expect(ctx.client.getState()).toMatchObject({
      status: "reconnecting",
      nextAttemptAt: null,
    });
  });

  it("backs off 1, 2, 4, 8, 16, 30, 30 s and ignores a disconnected trailing a failure", () => {
    const ctx = setupR();
    connect(ctx);
    drop(ctx);
    const seen = [delayOf(ctx)];
    for (let i = 0; i < 6; i += 1) {
      advance(seen[i] ?? 0);
      ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
      ctx.t.pushStatus({ kind: "disconnected" });
      seen.push(delayOf(ctx));
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // Only one timer is pending: advancing the last delay yields exactly one more connect.
    const before = ctx.t.connectCalls.length;
    advance(30000);
    expect(ctx.t.connectCalls).toHaveLength(before + 1);
  });

  it("resets the backoff only after 60 s connected", () => {
    const a = setupR();
    connect(a);
    drop(a);
    recover(a);
    advance(59_000);
    drop(a);
    expect(delayOf(a)).toBe(2000);

    const b = setupR();
    connect(b);
    drop(b);
    recover(b);
    advance(60_000);
    drop(b);
    expect(delayOf(b)).toBe(1000);
  });

  it("after reconnecting, sends presence then rejoins with the base nick", () => {
    const ctx = setupR();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presenceError("conflict"));
    ctx.t.pushStanza(
      parse(
        `<presence from="${ROOM}/alice-2"><x xmlns="http://jabber.org/protocol/muc#user"><status code="110"/></x></presence>`,
      ),
    );
    drop(ctx);
    ctx.events.length = 0;
    const sentBefore = ctx.t.sent.length;
    recover(ctx);
    const sent = ctx.t.sent.slice(sentBefore);
    expect(sent[0]?.localName).toBe("presence");
    expect(sent[0]?.hasAttribute("to")).toBe(false);
    expect(sent[1]?.getAttribute("to")).toBe(`${ROOM}/alice`);
    expect(ctx.events.map((e) => e.type)).toEqual([
      "connection",
      "connection",
      "room-joining",
    ]);
    ctx.t.pushStanza(presence("alice", ["110"]));
    expect(ctx.events).toContainEqual({
      type: "room-joined",
      roomJid: ROOM,
      nick: "alice",
      created: false,
    });
  });

  it("rejoins several suspended rooms in order", () => {
    const ctx = setupR();
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    drop(ctx);
    const sentBefore = ctx.t.sent.length;
    recover(ctx);
    expect(
      ctx.t.sent
        .slice(sentBefore)
        .filter((e) => e.hasAttribute("to"))
        .map((e) => e.getAttribute("to")),
    ).toEqual([`${ROOM}/alice`, `${ROOM2}/alice`]);
  });

  it("auth failure during a retry is terminal and never retried again", () => {
    const ctx = setupR();
    connect(ctx);
    joined(ctx);
    drop(ctx);
    advance(1000);
    ctx.t.pushStatus({ kind: "failed", reason: "auth-failed" });
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState()).toEqual({
      status: "disconnected",
      error: { reason: "auth-failed" },
    });
    expect(ctx.events).toContainEqual({
      type: "room-left",
      roomJid: ROOM,
      reason: "disconnected",
    });
    ctx.client.wake("visible");
    advance(120_000);
    expect(ctx.t.connectCalls).toHaveLength(2);
  });

  it("a stream conflict is never retried", () => {
    const ctx = setupR();
    connect(ctx);
    ctx.t.pushStatus({
      kind: "failed",
      reason: "connection-failed",
      condition: "conflict",
    });
    advance(120_000);
    expect(ctx.t.connectCalls).toHaveLength(1);
  });

  it("an initial sign-in connection failure is not retried", () => {
    const ctx = setupR();
    ctx.client.connect("alice@chaterl.localhost", PASSWORD);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
    advance(120_000);
    expect(ctx.t.connectCalls).toHaveLength(1);
    expect(ctx.client.getState()).toMatchObject({ status: "disconnected" });
  });

  it("sign-out with a retry pending ends disconnected without error and never reconnects", () => {
    const ctx = setupR();
    connect(ctx);
    joined(ctx);
    drop(ctx);
    ctx.client.disconnect();
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
    expect(ctx.events).toContainEqual({
      type: "room-left",
      roomJid: ROOM,
      reason: "disconnected",
    });
    advance(60_000);
    expect(ctx.t.connectCalls).toHaveLength(1);
  });

  it("sign-out with an attempt in flight ignores a late connected from the old attempt", () => {
    const ctx = setupR();
    connect(ctx);
    drop(ctx);
    advance(1000);
    expect(ctx.t.connectCalls).toHaveLength(2);
    ctx.client.disconnect();
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
    ctx.t.pushStatus({ kind: "connected", jid: JID_R2 });
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
  });

  it("pagehide while reconnecting signs out and does not reconnect", () => {
    const ctx = setupR();
    connect(ctx);
    drop(ctx);
    const target = new EventTarget();
    installPageHideClose(ctx.client, target);
    target.dispatchEvent(new Event("pagehide"));
    advance(60_000);
    expect(ctx.t.connectCalls).toHaveLength(1);
    expect(ctx.client.getState()).toEqual({ status: "disconnected" });
  });

  it("wake while reconnecting attempts at once; a second wake in flight is a no-op; the early attempt is refunded", () => {
    const ctx = setupR();
    connect(ctx);
    drop(ctx);
    ctx.client.wake("visible");
    expect(ctx.t.connectCalls).toHaveLength(2);
    ctx.client.wake("visible");
    expect(ctx.t.connectCalls).toHaveLength(2);
    ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
    // The early attempt did not consume a backoff step.
    expect(delayOf(ctx)).toBe(1000);
    expect(ctx.client.getState()).toMatchObject({ attempt: 1 });
  });

  it("tab flaps every second during a 20 s outage do not squeeze the backoff", () => {
    const ctx = setupR();
    connect(ctx);
    drop(ctx);
    let maxDelay = 0;
    let maxAttempt = 0;
    for (let i = 0; i < 20; i += 1) {
      ctx.client.wake("visible");
      const st = ctx.client.getState();
      if (st.status === "reconnecting" && st.nextAttemptAt === null) {
        ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
        ctx.t.pushStatus({ kind: "disconnected" });
      }
      const after = ctx.client.getState();
      if (after.status === "reconnecting" && after.nextAttemptAt !== null) {
        maxDelay = Math.max(maxDelay, after.nextAttemptAt - clock);
        maxAttempt = Math.max(maxAttempt, after.attempt);
      }
      advance(1000);
      const mid = ctx.client.getState();
      if (mid.status === "reconnecting" && mid.nextAttemptAt === null) {
        ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
        ctx.t.pushStatus({ kind: "disconnected" });
      }
    }
    // Without throttling this was ~20 connects with attempt 20 and a 30 s delay.
    expect(ctx.t.connectCalls.length).toBeLessThanOrEqual(9);
    // Natural timer-driven failures still advance the schedule (1, 2, 4 s ...).
    expect(maxAttempt).toBeLessThanOrEqual(4);
    expect(maxDelay).toBeLessThanOrEqual(8400);
  });

  describe("wake triggers and the throttle", () => {
    function failedAttemptThenWait(ctx: Ctx): number {
      connect(ctx);
      drop(ctx);
      advance(1000);
      expect(ctx.t.connectCalls).toHaveLength(2);
      ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
      ctx.t.pushStatus({ kind: "disconnected" });
      advance(1000);
      const st = ctx.client.getState();
      return st.status === "reconnecting" ? st.attempt : -1;
    }

    it.each(["user", "online"] as const)(
      "wake(%s) right after a failed attempt connects at once and does not escalate",
      (trigger) => {
        const ctx = setupR();
        const attemptBefore = failedAttemptThenWait(ctx);
        ctx.client.wake(trigger);
        expect(ctx.t.connectCalls).toHaveLength(3);
        ctx.t.pushStatus({ kind: "failed", reason: "connection-failed" });
        ctx.t.pushStatus({ kind: "disconnected" });
        expect(ctx.client.getState()).toMatchObject({
          status: "reconnecting",
          attempt: attemptBefore,
        });
      },
    );

    it("wake(visible) in the same position is throttled", () => {
      const ctx = setupR();
      failedAttemptThenWait(ctx);
      ctx.client.wake("visible");
      expect(ctx.t.connectCalls).toHaveLength(2);
    });

    it("while connected, wake(online) probes even within the visible throttle window", async () => {
      const ctx = setupR();
      connect(ctx);
      ctx.client.wake("visible");
      expect(ctx.t.iqs).toHaveLength(1);
      ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
      await vi.advanceTimersByTimeAsync(0);
      advance(5_000);
      ctx.client.wake("visible");
      expect(ctx.t.iqs).toHaveLength(1);
      ctx.client.wake("online");
      expect(ctx.t.iqs).toHaveLength(2);
    });
  });

  describe("liveness probe", () => {
    it("sends one ping to the server domain and none while one is in flight", () => {
      const ctx = setupR();
      connect(ctx);
      ctx.client.wake("visible");
      ctx.client.wake("visible");
      expect(ctx.t.iqs).toHaveLength(1);
      const iq = ctx.t.iqs[0];
      expect(iq?.getAttribute("to")).toBe("chaterl.localhost");
      expect(iq?.getAttribute("type")).toBe("get");
      expect(iq?.querySelector("ping")?.namespaceURI).toBe("urn:xmpp:ping");
    });

    it("a timeout drops the stale link, suspends rooms and reconnects", async () => {
      const ctx = setupR();
      connect(ctx);
      joined(ctx);
      ctx.client.wake("visible");
      // iqs[0] is the history query that follows the join; the probe is iqs[1].
      ctx.t.resolveIq(1, { ok: false, condition: "timeout" });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.t.disconnectCalls).toEqual(["stale"]);
      expect(ctx.client.getState()).toMatchObject({
        status: "reconnecting",
        attempt: 1,
      });
      expect(ctx.events).toContainEqual({
        type: "room-suspended",
        roomJid: ROOM,
      });
    });

    it("an error reply or a result means the link is alive", async () => {
      const ctx = setupR();
      connect(ctx);
      ctx.client.wake("visible");
      ctx.t.resolveIq(0, { ok: false, condition: "service-unavailable" });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.client.getState().status).toBe("connected");
      advance(30_000);
      ctx.client.wake("visible");
      ctx.t.resolveIq(1, { ok: true, stanza: parse('<iq type="result"/>') });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.client.getState().status).toBe("connected");
      expect(ctx.t.disconnectCalls).toEqual([]);
    });

    it("five wakes within 30 s send one ping; a wake after 30 s sends a second", async () => {
      const ctx = setupR();
      connect(ctx);
      for (let i = 0; i < 5; i += 1) {
        ctx.client.wake("visible");
        ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
        await vi.advanceTimersByTimeAsync(0);
        advance(5_000);
      }
      expect(ctx.t.iqs).toHaveLength(1);
      advance(5_000);
      ctx.client.wake("visible");
      expect(ctx.t.iqs).toHaveLength(2);
    });

    it("a connected transition resets the probe throttle", () => {
      const ctx = setupR();
      connect(ctx);
      ctx.client.wake("visible");
      expect(ctx.t.iqs).toHaveLength(1);
      drop(ctx);
      recover(ctx);
      ctx.client.wake("visible");
      expect(ctx.t.iqs).toHaveLength(2);
    });

    it("a timeout that arrives after a state change is ignored", async () => {
      const ctx = setupR();
      connect(ctx);
      ctx.client.wake("visible");
      drop(ctx);
      ctx.t.resolveIq(0, { ok: false, condition: "timeout" });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.t.disconnectCalls).toEqual([]);
      expect(ctx.client.getState()).toMatchObject({
        status: "reconnecting",
        attempt: 1,
      });
    });
  });

  it("answers a server ping with a result and still rejects other gets", () => {
    const ctx = setupR();
    connect(ctx);
    ctx.t.pushStanza(
      parse(
        "<iq type='get' id='p1' from='chaterl.localhost'><ping xmlns='urn:xmpp:ping'/></iq>",
      ),
    );
    const reply = ctx.t.sent.at(-1);
    expect(reply?.getAttribute("type")).toBe("result");
    expect(reply?.getAttribute("id")).toBe("p1");
    expect(reply?.getAttribute("to")).toBe("chaterl.localhost");
    ctx.t.pushStanza(
      parse(
        "<iq type='get' id='q1' from='x'><query xmlns='jabber:iq:version'/></iq>",
      ),
    );
    expect(ctx.t.sent.at(-1)?.getAttribute("type")).toBe("error");
  });

  it("ignores a stale instant-room result after a drop and rejoin", async () => {
    const ctx = setupR();
    connect(ctx);
    ctx.client.joinRoom(ROOM, "alice");
    ctx.t.pushStanza(presence("alice", ["110", "201"]));
    expect(ctx.t.iqs).toHaveLength(1);
    drop(ctx);
    recover(ctx);
    ctx.events.length = 0;
    ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
    await vi.advanceTimersByTimeAsync(0);
    const outcomes = ctx.events.filter(
      (e) => e.type === "room-joined" || e.type === "room-join-failed",
    );
    expect(outcomes).toEqual([]);
  });

  it("leaveRoom while suspended reports room-left self, sends nothing and does not rejoin", () => {
    const ctx = setupR();
    connect(ctx);
    joined(ctx);
    drop(ctx);
    const sentBefore = ctx.t.sent.length;
    ctx.client.leaveRoom(ROOM);
    expect(ctx.events.at(-1)).toEqual({
      type: "room-left",
      roomJid: ROOM,
      reason: "self",
    });
    expect(ctx.t.sent).toHaveLength(sentBefore);
    recover(ctx);
    expect(
      joinPresences(ctx.t).filter((to) => to.startsWith(ROOM)),
    ).toHaveLength(1);
  });

  describe("credentials", () => {
    it("never appear in states or events, including reconnecting ones", () => {
      const ctx = setupR();
      connect(ctx);
      joined(ctx);
      drop(ctx);
      recover(ctx);
      drop(ctx);
      expect(JSON.stringify(ctx.events)).not.toContain(PASSWORD);
      expect(JSON.stringify(ctx.client.getState())).not.toContain(PASSWORD);
    });

    it("are never written to web storage", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const ctx = setupR();
      connect(ctx);
      drop(ctx);
      recover(ctx);
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    });

    it("are dropped on terminate: wake makes no connect", () => {
      const ctx = setupR();
      connect(ctx);
      drop(ctx);
      ctx.client.disconnect();
      ctx.client.wake("visible");
      advance(60_000);
      expect(ctx.t.connectCalls).toHaveLength(1);
    });
  });
});

describe("history (MAM)", () => {
  const T0 = Date.parse("2026-11-18T16:00:00Z");
  const STAMP = "2026-11-18T15:00:00Z";
  const JID2 = "alice@chaterl.localhost/r2";
  let clock = T0;

  function setupH(extra: Partial<Parameters<typeof createXmppClient>[1]> = {}): Ctx {
    clock = T0;
    const t = createFakeTransport();
    let n = 0;
    const client = createXmppClient(t, {
      mucDomain: MUC,
      newId: () => `id${++n}`,
      now: () => clock,
      random: () => 0.5,
      ...extra,
    });
    const events: XmppEvent[] = [];
    client.subscribe((e) => events.push(e));
    return { t, client, events };
  }

  // Step the clock 1 ms at a time so timers see the right now(), as they would in a browser.
  function advance(ms: number): void {
    for (let i = 0; i < ms; i += 1) {
      clock += 1;
      vi.advanceTimersByTime(1);
    }
  }

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  const qid = (ctx: Ctx, i: number): string =>
    ctx.t.iqs[i]?.querySelector("query")?.getAttribute("queryid") ?? "";

  const hasTag = (ctx: Ctx, i: number, tag: string): boolean =>
    ctx.t.iqs[i]?.querySelector(tag) != null;

  const afterOf = (ctx: Ctx, i: number): string | null =>
    ctx.t.iqs[i]?.querySelector("after")?.textContent ?? null;

  function result(
    ctx: Ctx,
    i: number,
    id: string,
    body: string,
    nick = "bob",
    over: { queryId?: string; from?: string; stamp?: string } = {},
  ): void {
    ctx.t.pushStanza(
      mamResult({
        queryId: over.queryId ?? qid(ctx, i),
        id,
        stamp: over.stamp ?? STAMP,
        from: over.from ?? ROOM,
        inner: `<message from='${ROOM}/${nick}' type='groupchat'><body>${body}</body></message>`,
      }),
    );
  }

  const fin = (complete: boolean, last: string | null = null): Element =>
    parse(
      `<iq type='result'><fin xmlns='urn:xmpp:mam:2' complete='${String(complete)}'><set xmlns='http://jabber.org/protocol/rsm'>${
        last === null ? "" : `<first index='0'>F</first><last>${last}</last>`
      }</set></fin></iq>`,
    );

  const finish = async (
    ctx: Ctx,
    i: number,
    complete = true,
    last: string | null = null,
  ): Promise<void> => {
    ctx.t.resolveIq(i, { ok: true, stanza: fin(complete, last) });
    await flush();
  };

  const loaded = (ctx: Ctx): Extract<XmppEvent, { type: "history-loaded" }>[] =>
    ctx.events.flatMap((e) => (e.type === "history-loaded" ? [e] : []));

  const liveWithSid = (id: string, body = "live", nick = "bob"): Element =>
    groupchat(
      nick,
      body,
      `<stanza-id xmlns="urn:xmpp:sid:0" id="${id}" by="${ROOM}"/>`,
      `m-${id}`,
    );

  /** initial history with one item A1, then a drop and a reconnect; leaves the gap page-1 IQ sent (iqs[1]). */
  async function reachGap(ctx: Ctx): Promise<void> {
    connect(ctx);
    joined(ctx);
    result(ctx, 0, "A1", "first");
    await finish(ctx, 0);
    ctx.t.pushStatus({ kind: "disconnected" });
    advance(1000);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "connected", jid: JID2 });
    ctx.t.pushStanza(presence("alice", ["110"]));
    // The first query went out at T0; the backoff took 1000 ms, so the throttle holds the gap query for 100 ms.
    advance(100);
  }

  it("first join: room-joined, then history-loading and exactly one before-query for the last 24 h", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    const names = types(ctx.events).filter((x) => x !== "connection" && x !== "occupant-joined");
    expect(names).toEqual(["room-joining", "room-joined", "history-loading"]);
    expect(ctx.events.at(-1)).toEqual({
      type: "history-loading",
      roomJid: ROOM,
      direction: "initial",
    });
    expect(ctx.t.iqs).toHaveLength(1);
    const iq = ctx.t.iqs[0];
    expect(iq?.getAttribute("to")).toBe(ROOM);
    expect(iq?.querySelector("before")).not.toBeNull();
    expect(iq?.querySelector("after")).toBeNull();
    expect(iq?.querySelector("max")?.textContent).toBe("50");
    const start = Array.from(iq?.querySelectorAll("field") ?? []).find(
      (f) => f.getAttribute("var") === "start",
    );
    expect(start?.textContent).toBe(new Date(T0 - 86_400_000).toISOString());

    result(ctx, 0, "A1", "one", "bob");
    result(ctx, 0, "A2", "two", "carol");
    expect(loaded(ctx)).toHaveLength(0);
    await finish(ctx, 0);
    const [ev, ...rest] = loaded(ctx);
    expect(rest).toHaveLength(0);
    expect(ev).toMatchObject({ roomJid: ROOM, direction: "initial", done: true, complete: true });
    expect(ev?.messages.map((m) => [m.id, m.nick, m.body, m.isHistory])).toEqual([
      ["A1", "bob", "one", true],
      ["A2", "carol", "two", true],
    ]);
    expect(ev?.messages[0]?.sentAt).toBe(Date.parse(STAMP));
    expect(types(ctx.events)).not.toContain("message");
  });

  it("marks history from the room's own nick as own", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    result(ctx, 0, "A1", "mine", "alice");
    result(ctx, 0, "A2", "theirs", "bob");
    await finish(ctx, 0);
    expect(loaded(ctx)[0]?.messages.map((m) => m.isOwn)).toEqual([true, false]);
  });

  it("drops results with a wrong queryid, a resourceful outer from or another room's from", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    result(ctx, 0, "X1", "spoof1", "bob", { queryId: "nope" });
    result(ctx, 0, "X2", "spoof2", "bob", { from: `${ROOM}/mallory` });
    result(ctx, 0, "X3", "spoof3", "bob", { from: ROOM2 });
    result(ctx, 0, "A1", "genuine");
    await finish(ctx, 0);
    expect(loaded(ctx)[0]?.messages.map((m) => m.id)).toEqual(["A1"]);
    expect(types(ctx.events)).not.toContain("message");
  });

  it("ignores a result when no query is in flight", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    await finish(ctx, 0);
    const before = ctx.events.length;
    result(ctx, 0, "LATE", "late");
    expect(ctx.events).toHaveLength(before);
    expect(types(ctx.events)).not.toContain("message");
  });

  it("caps the buffered results at the page size", async () => {
    const ctx = setupH({ mamPageSize: 2 });
    connect(ctx);
    joined(ctx);
    result(ctx, 0, "A1", "a");
    result(ctx, 0, "A2", "b");
    result(ctx, 0, "A3", "c");
    await finish(ctx, 0);
    expect(loaded(ctx)[0]?.messages.map((m) => m.id)).toEqual(["A1", "A2"]);
  });

  it("after a reconnect rejoins with maxstanzas 0 and queries forward from the last live id", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    await finish(ctx, 0);
    ctx.t.pushStanza(liveWithSid("S1"));
    ctx.t.pushStatus({ kind: "disconnected" });
    advance(1000);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "connected", jid: JID2 });
    const rejoin = ctx.t.sent.at(-1);
    expect(rejoin?.getAttribute("to")).toBe(`${ROOM}/alice`);
    expect(rejoin?.querySelector("history")?.getAttribute("maxstanzas")).toBe("0");
    ctx.t.pushStanza(presence("alice", ["110"]));
    expect(ctx.events.at(-1)).toEqual({
      type: "history-loading",
      roomJid: ROOM,
      direction: "gap",
    });
    advance(1100);
    expect(ctx.t.iqs).toHaveLength(2);
    expect(afterOf(ctx, 1)).toBe("S1");
    expect(hasTag(ctx, 1, "before")).toBe(false);
  });

  it("pages the gap forward, one query per 1100 ms, and stops when complete", async () => {
    const ctx = setupH();
    await reachGap(ctx);
    expect(ctx.t.iqs).toHaveLength(2);
    expect(afterOf(ctx, 1)).toBe("A1");
    result(ctx, 1, "G1", "gap one");
    await finish(ctx, 1, false, "L1");
    expect(loaded(ctx).at(-1)).toMatchObject({ direction: "gap", done: false, complete: false });
    advance(1099);
    expect(ctx.t.iqs).toHaveLength(2);
    advance(1);
    expect(ctx.t.iqs).toHaveLength(3);
    expect(afterOf(ctx, 2)).toBe("L1");
    result(ctx, 2, "G2", "gap two");
    await finish(ctx, 2, true, "L2");
    expect(loaded(ctx).at(-1)).toMatchObject({ direction: "gap", done: true, complete: true });
    expect(loaded(ctx).at(-1)?.messages.map((m) => m.id)).toEqual(["G2"]);
    advance(10_000);
    expect(ctx.t.iqs).toHaveLength(3);
  });

  it("stops after 5 incomplete gap pages and reports an incomplete done", async () => {
    const ctx = setupH();
    await reachGap(ctx);
    for (let page = 1; page <= 5; page += 1) {
      result(ctx, page, `G${page}`, `gap ${page}`);
      await finish(ctx, page, false, `L${page}`);
      advance(1100);
    }
    expect(ctx.t.iqs).toHaveLength(6);
    expect(loaded(ctx).at(-1)).toMatchObject({ direction: "gap", done: true, complete: false });
    advance(10_000);
    expect(ctx.t.iqs).toHaveLength(6);
  });

  it("falls back to the initial query once when the gap anchor is gone", async () => {
    const ctx = setupH();
    await reachGap(ctx);
    ctx.t.resolveIq(1, { ok: false, condition: "item-not-found" });
    await flush();
    expect(ctx.events.at(-1)).toEqual({
      type: "history-loading",
      roomJid: ROOM,
      direction: "initial",
    });
    expect(ctx.t.iqs).toHaveLength(2);
    advance(1100);
    expect(ctx.t.iqs).toHaveLength(3);
    expect(hasTag(ctx, 2, "before")).toBe(true);
    expect(hasTag(ctx, 2, "after")).toBe(false);
    ctx.t.resolveIq(2, { ok: false, condition: "item-not-found" });
    await flush();
    expect(ctx.events.at(-1)).toEqual({
      type: "history-failed",
      roomJid: ROOM,
      direction: "initial",
      condition: "item-not-found",
    });
    advance(60_000);
    expect(ctx.t.iqs).toHaveLength(3);
  });

  it.each(["timeout", "resource-constraint", "service-unavailable"])(
    "reports %s as history-failed and never retries by itself",
    async (condition) => {
      const ctx = setupH();
      connect(ctx);
      joined(ctx);
      ctx.t.resolveIq(0, { ok: false, condition });
      await flush();
      expect(ctx.events.at(-1)).toEqual({
        type: "history-failed",
        roomJid: ROOM,
        direction: "initial",
        condition,
      });
      advance(60_000);
      expect(ctx.t.iqs).toHaveLength(1);
    },
  );

  it("reports a result without a fin as bad-response", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.t.resolveIq(0, { ok: true, stanza: parse("<iq type='result'/>") });
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({
      type: "history-failed",
      direction: "initial",
      condition: "bad-response",
    });
  });

  it("retryHistory runs a new query after a failure", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.t.resolveIq(0, { ok: false, condition: "timeout" });
    await flush();
    advance(1100);
    ctx.client.retryHistory(ROOM);
    expect(ctx.t.iqs).toHaveLength(2);
    expect(ctx.events.at(-1)).toMatchObject({ type: "history-loading", direction: "initial" });
  });

  it("retries a failed initial load as initial even after a live message set the anchor", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(liveWithSid("S1"));
    ctx.t.resolveIq(0, { ok: false, condition: "timeout" });
    await flush();
    advance(1100);
    ctx.client.retryHistory(ROOM);
    expect(ctx.t.iqs).toHaveLength(2);
    expect(hasTag(ctx, 1, "before")).toBe(true);
    expect(hasTag(ctx, 1, "after")).toBe(false);
    expect(ctx.events.at(-1)).toEqual({
      type: "history-loading",
      roomJid: ROOM,
      direction: "initial",
    });
  });

  it("retryHistory is a no-op while a query is in flight or queued", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.client.retryHistory(ROOM);
    expect(ctx.t.iqs).toHaveLength(1);
    ctx.t.resolveIq(0, { ok: false, condition: "timeout" });
    await flush();
    // Within the throttle window the retry is queued, and a second retry must not add another.
    ctx.client.retryHistory(ROOM);
    ctx.client.retryHistory(ROOM);
    expect(ctx.t.iqs).toHaveLength(1);
    advance(1100);
    expect(ctx.t.iqs).toHaveLength(2);
  });

  it("retryHistory is a no-op for an unknown or suspended room", () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.client.retryHistory(ROOM2);
    ctx.t.pushStatus({ kind: "disconnected" });
    const count = ctx.events.length;
    ctx.client.retryHistory(ROOM);
    expect(ctx.events).toHaveLength(count);
    expect(ctx.t.iqs).toHaveLength(1);
  });

  it("ignores the old query's result after a drop and does not reuse its buffer", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    result(ctx, 0, "OLD", "stale body");
    ctx.t.pushStatus({ kind: "disconnected" });
    advance(1000);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "connected", jid: JID2 });
    ctx.t.pushStanza(presence("alice", ["110"]));
    advance(1100);
    expect(ctx.t.iqs).toHaveLength(2);
    await finish(ctx, 0);
    expect(loaded(ctx)).toHaveLength(0);
    await finish(ctx, 1);
    expect(loaded(ctx)).toHaveLength(1);
    expect(loaded(ctx)[0]?.messages).toEqual([]);
  });

  it("leaving the room while a query is in flight yields no later events", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.client.leaveRoom(ROOM);
    const count = ctx.events.length;
    await finish(ctx, 0);
    expect(ctx.events).toHaveLength(count);
  });

  it("leaving the room while a query is queued sends nothing later", () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    expect(ctx.t.iqs).toHaveLength(1);
    ctx.client.leaveRoom(ROOM2);
    const count = ctx.events.length;
    advance(10_000);
    expect(ctx.t.iqs).toHaveLength(1);
    expect(ctx.events).toHaveLength(count);
  });

  it("a terminal disconnect clears every timer, including a queued history query", async () => {
    const ctx = setupH();
    expect(vi.getTimerCount()).toBe(0);
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: "disconnected" });
    expect(ctx.client.getState().status).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
    await finish(ctx, 0);
    advance(10_000);
    expect(ctx.t.iqs).toHaveLength(1);
  });

  it("a live message during the initial query keeps its id as the catch-up anchor", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(liveWithSid("S9"));
    result(ctx, 0, "A1", "old");
    await finish(ctx, 0);
    ctx.t.pushStatus({ kind: "disconnected" });
    advance(1000);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "connected", jid: JID2 });
    ctx.t.pushStanza(presence("alice", ["110"]));
    advance(1100);
    expect(afterOf(ctx, 1)).toBe("S9");
  });

  it("without live messages the catch-up anchor is the last history id", async () => {
    const ctx = setupH();
    await reachGap(ctx);
    expect(afterOf(ctx, 1)).toBe("A1");
  });

  it("a live message without a stanza-id does not change the anchor", async () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    result(ctx, 0, "A1", "old");
    await finish(ctx, 0);
    ctx.t.pushStanza(groupchat("bob", "no sid", "", "plain-1"));
    ctx.t.pushStatus({ kind: "disconnected" });
    advance(1000);
    ctx.t.pushStatus({ kind: "connecting" });
    ctx.t.pushStatus({ kind: "connected", jid: JID2 });
    ctx.t.pushStanza(presence("alice", ["110"]));
    advance(1100);
    expect(afterOf(ctx, 1)).toBe("A1");
  });

  it("throttles history queries across rooms", () => {
    const ctx = setupH();
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    expect(ctx.t.iqs).toHaveLength(1);
    advance(1099);
    expect(ctx.t.iqs).toHaveLength(1);
    advance(1);
    expect(ctx.t.iqs).toHaveLength(2);
    expect(ctx.t.iqs[1]?.getAttribute("to")).toBe(ROOM2);
  });

  it("never logs bodies or room addresses from the history paths", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      const ctx = setupH();
      await reachGap(ctx);
      result(ctx, 1, "G1", "secret body text");
      await finish(ctx, 1, false, "L1");
      advance(1100);
      ctx.t.resolveIq(2, { ok: false, condition: "timeout" });
      await flush();
      ctx.client.retryHistory(ROOM);
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      expect(logged).not.toContain("secret body text");
      expect(logged).not.toContain(ROOM);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
