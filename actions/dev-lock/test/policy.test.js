import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Decision, Mode, decide, parseMode } from "../src/policy.js";

describe("parseMode", () => {
  const cases = [
    [null, Mode.REPORT_ONLY], // nothing seeds CONFIG/mode: absent means report-only
    [undefined, Mode.REPORT_ONLY],
    ["report-only", Mode.REPORT_ONLY],
    ["enforce", Mode.ENFORCE],
    ["off", Mode.OFF],
    ["ENFORCE", Mode.REPORT_ONLY], // unknown values never enforce
    ["enforce ", Mode.REPORT_ONLY],
    ["", Mode.REPORT_ONLY],
    ["disabled", Mode.REPORT_ONLY],
  ];
  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} is ${expected}`, () => assert.equal(parseMode(raw), expected));
  }
});

describe("decide", () => {
  for (const holderType of ["ci", "manual"]) {
    for (const isMainPush of [true, false]) {
      it(`report-only never blocks (${holderType}, main push: ${isMainPush})`, () => {
        assert.equal(decide(Mode.REPORT_ONLY, holderType, { isMainPush }), Decision.CONTINUE);
      });
    }
  }

  it("a PR deploy fails fast whoever holds the lock", () => {
    assert.equal(decide(Mode.ENFORCE, "ci", { isMainPush: false }), Decision.BLOCK);
    assert.equal(decide(Mode.ENFORCE, "manual", { isMainPush: false }), Decision.BLOCK);
  });

  it("a merge to main waits for a CI deploy", () => {
    assert.equal(decide(Mode.ENFORCE, "ci", { isMainPush: true }), Decision.WAIT);
  });

  it("a merge to main is never blocked by a manual hold (prod needs the dev job)", () => {
    assert.equal(decide(Mode.ENFORCE, "manual", { isMainPush: true }), Decision.PREEMPT);
  });
});
