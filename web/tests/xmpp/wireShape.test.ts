import { describe, expect, it } from "vitest";
import { buildMamQuery } from "../../src/xmpp/mam";
import {
  buildIqErrorReply,
  buildJoinPresence,
  buildPing,
} from "../../src/xmpp/stanzas";
import { CAPTURED_ROOM, ROOM, parse } from "../fixtures/stanzas";

/** Strophe serializes the xmlns ATTRIBUTE, so a child repeating its parent's xmlns is redundant on the wire. */
function nearestAncestorXmlns(el: Element): string | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const v = p.getAttribute("xmlns");
    if (v !== null) return v;
  }
  return null;
}

function redundant(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].flatMap((el) => {
    const own = el.getAttribute("xmlns");
    return own !== null && own === nearestAncestorXmlns(el)
      ? [el.localName]
      : [];
  });
}

const mam = {
  roomJid: CAPTURED_ROOM,
  iqId: "i",
  queryId: "q",
  startIso: "2026-01-01T00:00:00Z",
  max: 50,
};

describe("no builder emits a redundant xmlns", () => {
  const cases: Array<[string, () => Element]> = [
    [
      "mam before:true",
      () => buildMamQuery({ ...mam, page: { before: true } }),
    ],
    ["mam before:id", () => buildMamQuery({ ...mam, page: { before: "F1" } })],
    ["mam after:id", () => buildMamQuery({ ...mam, page: { after: "L1" } })],
    ["join presence", () => buildJoinPresence(ROOM, "alice", 20)],
    ["ping", () => buildPing(ROOM, "p1")],
    [
      "iq error reply",
      () =>
        buildIqErrorReply(
          parse(
            '<iq from="a@b/c" to="x@y" type="get" id="q1"><ping xmlns="urn:xmpp:ping"/></iq>',
          ),
        ),
    ],
  ];
  for (const [name, make] of cases) {
    it(name, () => {
      expect(redundant(make())).toEqual([]);
    });
  }
});
