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
    it(`report-only never blocks a PR deploy (${holderType})`, () => {
      assert.equal(decide(Mode.REPORT_ONLY, holderType, { isMainPush: false }), Decision.CONTINUE);
    });
  }

  // Every combination: mode x pr_policy x merge-or-PR x who is in the way (a CI deploy, a manual hold, or nobody holds
  // dev but others are ahead in line).
  const expected = {
    "report-only": {
      fail: { merge: { ci: "CONTINUE", manual: "CONTINUE", line: "CONTINUE" }, pr: { ci: "CONTINUE", manual: "CONTINUE", line: "CONTINUE" } },
      wait: { merge: { ci: "CONTINUE", manual: "CONTINUE", line: "CONTINUE" }, pr: { ci: "WAIT", manual: "WAIT", line: "WAIT" } },
    },
    enforce: {
      fail: { merge: { ci: "WAIT", manual: "PREEMPT", line: "WAIT" }, pr: { ci: "BLOCK", manual: "BLOCK", line: "BLOCK" } },
      wait: { merge: { ci: "WAIT", manual: "PREEMPT", line: "WAIT" }, pr: { ci: "WAIT", manual: "WAIT", line: "WAIT" } },
    },
  };
  for (const [mode, byPolicy] of Object.entries(expected)) {
    for (const [prPolicy, byKind] of Object.entries(byPolicy)) {
      for (const [kind, byHolder] of Object.entries(byKind)) {
        for (const [holder, decision] of Object.entries(byHolder)) {
          it(`${mode}, pr_policy ${prPolicy}, ${kind}, ${holder === "line" ? "free with others ahead" : `held by ${holder}`}: ${decision}`, () => {
            const holderType = holder === "line" ? null : holder;
            assert.equal(decide(mode, holderType, { isMainPush: kind === "merge", prPolicy }), Decision[decision]);
          });
        }
      }
    }
  }

  it("report-only stays observational for a merge to main: it never waits", () => {
    for (const holderType of ["ci", "manual", null]) {
      assert.equal(decide(Mode.REPORT_ONLY, holderType, { isMainPush: true }), Decision.CONTINUE);
    }
  });

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
