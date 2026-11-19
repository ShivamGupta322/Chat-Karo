// The only test of the actual bytes Strophe sends. Importing strophe.js is allowed here by a scoped ESLint override.
import { Strophe } from "strophe.js";
import { describe, expect, it } from "vitest";
import { buildMamQuery } from "../../../src/xmpp/mam";

const base = {
  roomJid: "room@conference.localhost",
  iqId: "i1",
  queryId: "q1",
  startIso: "2026-01-01T00:00:00.000Z",
  max: 50,
};

function wire(page: Parameters<typeof buildMamQuery>[0]["page"]): string {
  return Strophe.serialize(buildMamQuery({ ...base, page }));
}

describe("MAM query as serialized by Strophe", () => {
  it("newest page: <max>50</max><before/> inside the RSM <set>", () => {
    expect(wire({ before: true })).toContain(
      '<set xmlns="http://jabber.org/protocol/rsm"><max>50</max><before/></set>',
    );
  });
  it("earlier page: <before>F1</before>", () => {
    expect(wire({ before: "F1" })).toContain("<before>F1</before>");
  });
  it("gap page: <after>L1</after>", () => {
    expect(wire({ after: "L1" })).toContain("<after>L1</after>");
  });
  it("no RSM child carries an xmlns attribute", () => {
    for (const page of [
      { before: true },
      { before: "F1" },
      { after: "L1" },
    ] as const) {
      expect(wire(page)).not.toMatch(/<(max|before|after)\b[^>]* xmlns=/);
    }
  });
});
