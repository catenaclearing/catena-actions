/** Runtime mode, stored in the table so it can be changed without a release. */
export const Mode = Object.freeze({ OFF: "off", REPORT_ONLY: "report-only", ENFORCE: "enforce" });

/** What a deploy does when someone else holds a live lock. */
export const Decision = Object.freeze({
  CONTINUE: "continue", // deploy anyway (report-only)
  BLOCK: "block", // fail the job now and queue for a "your turn" ping
  WAIT: "wait", // poll until the lock frees, up to the wait limit
  PREEMPT: "preempt", // deploy anyway and tell the manual holder
});

/** Parse the runtime mode stored in the table. Anything missing or unrecognised is report-only, so it never enforces by accident. */
export function parseMode(raw) {
  return Object.values(Mode).includes(raw) ? raw : Mode.REPORT_ONLY;
}

/**
 * Decide what to do when someone else holds a live lock.
 *
 * A merge to main must never be stalled by a manual hold: its dev job gates the production deploy.
 */
export function decide(mode, holderType, { isMainPush }) {
  if (mode !== Mode.ENFORCE) return Decision.CONTINUE;
  if (!isMainPush) return Decision.BLOCK;
  return holderType === "manual" ? Decision.PREEMPT : Decision.WAIT;
}
