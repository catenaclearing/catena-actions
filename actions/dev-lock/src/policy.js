/** Runtime mode, stored in the table so it can be changed without a release. */
export const Mode = Object.freeze({ OFF: "off", REPORT_ONLY: "report-only", ENFORCE: "enforce" });

/** What an enforced PR / label deploy does when it cannot take dev now. Stored in the table (CONFIG/pr_policy). */
export const PrPolicy = Object.freeze({ FAIL: "fail", WAIT: "wait" });

/** What a deploy does when someone else holds a live lock, or deploys are waiting in line ahead of it. */
export const Decision = Object.freeze({
  CONTINUE: "continue", // deploy anyway (report-only)
  BLOCK: "block", // fail the job now and queue for a "your turn" ping
  WAIT: "wait", // poll until the lock frees and this run is first in line, up to the wait limit
  PREEMPT: "preempt", // deploy anyway and tell the manual holder
});

/** Parse the runtime mode stored in the table. Anything missing or unrecognised is report-only, so it never enforces by accident. */
export function parseMode(raw) {
  return Object.values(Mode).includes(raw) ? raw : Mode.REPORT_ONLY;
}

/** Parse the PR policy stored in the table. Anything missing or unrecognised is fail, the behaviour before it existed. */
export function parsePrPolicy(raw) {
  return Object.values(PrPolicy).includes(raw) ? raw : PrPolicy.FAIL;
}

/**
 * Decide what to do when this run cannot take dev now: someone else holds a live lock (`holderType` is theirs), or dev
 * is free but other deploys are waiting in line ahead of it (`holderType` is null).
 *
 * A PR deploy waits in line when `pr_policy` is wait, in either mode: that is an explicit opt-in. Otherwise it fails
 * fast in enforce, and warns and deploys anyway in report-only. It never preempts a manual hold.
 *
 * A merge to main waits in line only in enforce; report-only stays observational for merges, which warn and deploy at
 * once. It must never be stalled by a manual hold either (its dev job gates the production deploy): in enforce it takes
 * the hold over.
 */
export function decide(mode, holderType, { isMainPush, prPolicy = PrPolicy.FAIL }) {
  const enforce = mode === Mode.ENFORCE;
  if (!isMainPush) {
    if (prPolicy === PrPolicy.WAIT) return Decision.WAIT;
    return enforce ? Decision.BLOCK : Decision.CONTINUE;
  }
  if (!enforce) return Decision.CONTINUE;
  return holderType === "manual" ? Decision.PREEMPT : Decision.WAIT;
}
