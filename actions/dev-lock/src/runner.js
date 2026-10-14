import { RUN_TOKEN_STATE, Settings } from "./config.js";
import { createStore } from "./client.js";
import { Output } from "./github.js";
import { Decision, Mode, decide, parseMode } from "./policy.js";

const MAX_RACE_RETRIES = 5;

/** The real clock. Time is in epoch seconds, so tests can substitute one that only moves when the code sleeps. */
export const systemClock = {
  now: () => Date.now() / 1000,
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

function holderLabel(lock) {
  if (lock.holderType === "manual") {
    const reason = lock.reason ? ` (${lock.reason})` : "";
    return `a manual hold by ${lock.actor}${reason}`;
  }
  return `${lock.actor}'s deploy of ${lock.repo} (${lock.ref})`;
}

function timing(lock, now) {
  const since = `${new Date(lock.startedAt * 1000).toISOString().slice(11, 16)} UTC`;
  const minutes = Math.max(0, Math.floor((lock.expiresAt - now) / 60));
  const expires = minutes ? `about ${minutes} min` : "under a minute";
  return `since ${since}, expires in ${expires}`;
}

async function tryTake(settings, store) {
  return (await store.putIfFree(settings)) || (await store.joinIfMine(settings));
}

async function tookLock(settings, store, out, mode) {
  out.setOutput("acquired", "true");
  out.setOutput("blocked", "false");
  try {
    await store.removeQueueEntries(settings.holderKey);
  } catch {
    out.warning("dev-lock acquired the lock but could not clear its queue entry; continuing with the lock held.");
  }
  out.notice(`Holding the dev lock for ${settings.holderKey} (mode: ${mode}).`);
  return 0;
}

/** Returned instead of an exit code when the lock changed under us and should be read again straight away. */
const LOOK_AGAIN = Symbol("look again");

/** Returned when this run took the lock over from a manual hold: it holds the lock, and has set its own outputs. */
const PREEMPTED = Symbol("preempted");

/** Act on a live lock held by someone else. Returns the exit code, null to keep waiting, LOOK_AGAIN or PREEMPTED. */
async function heldBySomeoneElse(settings, store, clock, out, mode, lock, wait) {
  const decision = decide(mode, lock.holderType, { isMainPush: settings.isMainPush });
  const holder = `${holderLabel(lock)}, ${timing(lock, clock.now())}`;

  if (decision === Decision.CONTINUE) {
    out.warning(`Dev is held by ${holder}. dev-lock is in report-only mode, so this deploy would have been blocked; continuing.`);
    return 0;
  }

  if (decision === Decision.PREEMPT) {
    // Take the lock over, so nothing else can deploy until this run's post step releases it (which gives the hold back).
    // If the hold ended or changed since we read it there is nothing to preempt, and someone else may have taken the
    // lock in the meantime: look at the lock again instead of deploying alongside them.
    if (!(await store.takeOverHold(settings, lock.holderKey))) return LOOK_AGAIN;
    out.setOutput("acquired", "true");
    out.setOutput("blocked", "false");
    // It holds dev now, so it leaves the queue entirely, as tookLock does: an old `notify` entry of this holder (say a
    // blocked workflow_dispatch on main) would otherwise keep counting toward everyone else's position.
    try {
      await store.removeQueueEntries(settings.holderKey);
    } catch {
      out.warning("dev-lock took the lock over but could not clear its queue entry; continuing with the lock held.");
    }
    out.warning(
      `Dev is held by ${holder}. A merge to main must not be stalled by a manual hold (production waits on this deploy), ` +
        `so it has taken the lock over until it finishes; ${lock.actor} has been told and gets the hold back afterwards.`,
    );
    return PREEMPTED;
  }

  if (decision === Decision.BLOCK) {
    const position = await store.enqueue(settings, "notify");
    out.error(
      `Dev is locked by ${holder}. You are #${position} in the queue; the #dev-deploys bot will ping you when it is your turn. ` +
        "Re-run this job once dev is free.",
    );
    return 1;
  }

  // Decision.WAIT: a merge to main waits for the CI deploy ahead of it.
  const position = await store.enqueue(settings, "poll");
  if (wait.since === null) {
    wait.since = clock.now();
    out.notice(`Dev is locked by ${holder}. Waiting up to ${Math.floor(settings.waitSeconds / 60)} min (queue position #${position}).`);
  }
  if (clock.now() - wait.since < settings.waitSeconds) return null;
  await store.removeQueueEntries(settings.holderKey, ["poll"]);
  out.error(
    `Gave up after ${Math.floor(settings.waitSeconds / 60)} min: dev is still locked by ${holder}. ` +
      "Production waits on this job, so re-run it once dev is free.",
  );
  return 1;
}

/** Take the dev lock for this run. Returns 1 only when the deploy must stop; every other outcome is 0. */
export async function acquire(settings, store, clock, out) {
  // Saved before anything is written, so the post step can release this share even if acquire dies after taking it.
  out.saveState(RUN_TOKEN_STATE, settings.runToken);
  const mode = parseMode(await store.getMode());
  if (mode === Mode.OFF) {
    out.notice("dev-lock is off (table CONFIG/mode); deploying without the lock.");
    out.setOutput("acquired", "false");
    out.setOutput("blocked", "false");
    return 0;
  }

  const wait = { since: null };
  let races = 0;
  const lostRace = () => {
    races += 1;
    if (races > MAX_RACE_RETRIES) throw new Error("the dev lock kept changing while trying to take it");
  };
  for (;;) {
    if (await tryTake(settings, store)) return tookLock(settings, store, out, mode);

    const lock = await store.getLock();
    if (lock === null || lock.isExpired(store.now())) {
      // Freed or expired between our write and our read: someone else may be racing us, so just try again.
      lostRace();
      continue;
    }
    if (lock.holderKey === settings.holderKey) {
      // Our own holder took the lock after our join failed (a sibling run got in when the previous holder released).
      // It is ours to join, not someone else's to wait on or be blocked by.
      lostRace();
      continue;
    }

    const exitCode = await heldBySomeoneElse(settings, store, clock, out, mode, lock, wait);
    if (exitCode === PREEMPTED) return 0;
    if (exitCode === LOOK_AGAIN) {
      lostRace();
      continue;
    }
    if (exitCode !== null) {
      out.setOutput("acquired", "false");
      out.setOutput("blocked", exitCode ? "true" : "false");
      return exitCode;
    }
    const remaining = Math.max(0, settings.waitSeconds - (clock.now() - wait.since));
    await clock.sleep(Math.min(settings.pollSeconds, remaining));
  }
}

/** Give this run's share of the lock back. Safe to call any number of times, and never fails the job. */
export async function release(settings, store, out) {
  const held = await store.release(settings);
  // A blocked deploy's `notify` entry stays: it is how that deployer gets pinged when dev is free.
  await store.removeQueueEntries(settings.holderKey, ["poll"]);
  if (held) out.notice(`Released the dev lock for run ${settings.runToken}.`);
  return 0;
}

/**
 * Run `acquire` or `release`. Fails open: only a deliberate block (1) or a wiring bug (2) is a non-zero exit.
 *
 * `makeStore` is injectable so tests can point it at a local DynamoDB.
 */
export async function run(command, { env = process.env, makeStore = createStore, clock = systemClock, out = null } = {}) {
  const output = out ?? new Output({ outputFile: env.GITHUB_OUTPUT ?? null, stateFile: env.GITHUB_STATE ?? null });
  if (command !== "acquire" && command !== "release") {
    output.error(`dev-lock: unknown command '${command ?? ""}' (expected 'acquire' or 'release'); this is a bug in the action wiring.`);
    return 2;
  }

  try {
    const settings = Settings.fromEnv(env);
    const store = makeStore(settings, env, clock);
    return command === "acquire" ? await acquire(settings, store, clock, output) : await release(settings, store, output);
  } catch (error) {
    // Fail open by design: the lock is coordination, not a security control.
    output.warning(
      `dev-lock could not use the lock table (${error?.name ?? "Error"}: ${error?.message ?? error}); continuing without the lock. ` +
        "Concurrent dev deploys are possible until this is fixed.",
    );
    output.debug(error?.stack ?? String(error));
    output.setOutput("acquired", "false");
    output.setOutput("blocked", "false");
    return 0;
  }
}
