// Waiting in line (PLAT-590): CONFIG/pr_policy = wait lets a blocked PR deploy wait in its job, and every waiting run
// takes a free lock only when nobody is waiting in line ahead of it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Output } from "../src/github.js";
import { Decision, Mode, PrPolicy, decide, parsePrPolicy } from "../src/policy.js";
import { acquire, release } from "../src/runner.js";
import { LockStore, POLL_ENTRY_STALE_SECONDS, QUEUE_CLAIM_PK, QUEUE_ENTRY_TTL_SECONDS, QUEUE_PK } from "../src/store.js";
import { Lab, START, githubEnv, levels, mainPushEnv, text } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

const setPrPolicy = (ctx, value) => ctx.put({ pk: "CONFIG", sk: "pr_policy", value });

/** Put another holder in the queue, as its own run would have: an entry, and the claim naming it. */
async function queued(ctx, holderKey, { at = START - 30, heartbeat = START, kind = "poll", runs = ["2002-1-deploy-development-abcd1234"], mainPush = false, legacy = false } = {}) {
  const sk = `${String(at * 1000).padStart(13, "0")}#00000000-0000-0000-0000-000000000000#${holderKey}`;
  await ctx.put({
    pk: QUEUE_PK,
    sk,
    kind,
    holder_key: holderKey,
    repo: "catenaclearing/catena-platform",
    actor: holderKey.split("#")[2],
    ref: mainPush ? "refs/heads/main" : "refs/pull/7/merge",
    enqueued_at: at,
    heartbeat_at: heartbeat,
    poll_seconds: 15,
    run_url: "https://github.com/o/r/actions/runs/2002",
    ttl: START + QUEUE_ENTRY_TTL_SECONDS,
    ...(runs.length ? { poll_run_ids: new Set(runs) } : {}),
    ...(kind === "poll" && !legacy ? { main_push: mainPush } : {}), // a legacy (v0.16.0) waiting merge wrote none
  });
  await ctx.put({ pk: QUEUE_CLAIM_PK, sk: holderKey, entry_sk: sk, ttl: START + QUEUE_ENTRY_TTL_SECONDS });
  return sk;
}

const CAROL = "ci#catenaclearing/catena-platform#carol#refs/pull/8/merge";
const DAVE = "ci#catenaclearing/catena-platform#dave#refs/pull/9/merge";
const MERGE = "ci#catenaclearing/catena-platform#erin#refs/heads/main";

/** A clock for one run: shares the test's time, and calls `onSleep` before each of that run's sleeps. */
function runClock(ctx, onSleep) {
  return { now: () => ctx.clock.now(), sleep: async (seconds) => { await onSleep?.(); await ctx.clock.sleep(seconds); } };
}

describe("the PR policy", () => {
  const cases = [
    [null, PrPolicy.FAIL], // nothing seeds CONFIG/pr_policy: absent is the behaviour before it existed
    [undefined, PrPolicy.FAIL],
    ["fail", PrPolicy.FAIL],
    ["wait", PrPolicy.WAIT],
    ["WAIT", PrPolicy.FAIL], // unknown values never wait
    ["wait ", PrPolicy.FAIL],
    ["", PrPolicy.FAIL],
  ];
  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} is ${expected}`, () => assert.equal(parsePrPolicy(raw), expected));
  }

  it("wait makes a PR deploy wait whoever holds dev, and never preempt a manual hold", () => {
    for (const holderType of ["ci", "manual", null]) {
      assert.equal(decide(Mode.ENFORCE, holderType, { isMainPush: false, prPolicy: PrPolicy.WAIT }), Decision.WAIT);
      assert.equal(decide(Mode.ENFORCE, holderType, { isMainPush: false, prPolicy: PrPolicy.FAIL }), Decision.BLOCK);
    }
  });

  it("does not change what a merge to main does", () => {
    for (const prPolicy of [PrPolicy.FAIL, PrPolicy.WAIT]) {
      assert.equal(decide(Mode.ENFORCE, "ci", { isMainPush: true, prPolicy }), Decision.WAIT);
      assert.equal(decide(Mode.ENFORCE, null, { isMainPush: true, prPolicy }), Decision.WAIT);
      assert.equal(decide(Mode.ENFORCE, "manual", { isMainPush: true, prPolicy }), Decision.PREEMPT);
    }
  });

  it("is an opt-in that waits in report-only too; report-only merges still never wait", () => {
    for (const holderType of ["ci", "manual", null]) {
      assert.equal(decide(Mode.REPORT_ONLY, holderType, { isMainPush: false, prPolicy: PrPolicy.WAIT }), Decision.WAIT);
      assert.equal(decide(Mode.REPORT_ONLY, holderType, { isMainPush: false, prPolicy: PrPolicy.FAIL }), Decision.CONTINUE);
      assert.equal(decide(Mode.REPORT_ONLY, holderType, { isMainPush: true, prPolicy: PrPolicy.WAIT }), Decision.CONTINUE);
    }
  });
});

describe("a PR deploy with pr_policy wait", () => {
  it("waits for a CI deploy, then takes the lock and leaves the queue", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make();
    const kinds = [];
    const clock = runClock(ctx, async () => kinds.push((await ctx.queueItems()).map((item) => item.kind)));

    assert.equal(await acquire(settings, store, clock, ctx.out), 0);

    assert.ok(kinds.length > 0 && kinds.every((k) => k.length === 1 && k[0] === "poll"));
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.deepEqual(await ctx.queueItems(), []);
    assert.match(text(ctx.out), /Waiting up to 30 min \(queue position #1\)/);
    assert.equal(ctx.out.outputs.blocked, "false");
  });

  it("waits behind a manual hold instead of preempting it, and gives up after pr_wait_minutes still in the queue", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsManual({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(githubEnv({ INPUT_PR_WAIT_MINUTES: "3", INPUT_WAIT_MINUTES: "1" }));

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.equal((await ctx.currentLock()).holder_key, "manual#U123"); // untouched
    assert.equal(ctx.clock.slept.reduce((a, b) => a + b, 0), 180); // its own limit, not wait_minutes
    const [entry] = await ctx.queueItems();
    assert.equal(entry.kind, "notify"); // pinged when it is their turn, as a fail-fast block is
    assert.equal(entry.holder_key, settings.holderKey);
    assert.equal(entry.poll_run_ids, undefined); // not counted as waiting any more
    assert.equal((await ctx.queueClaim(settings.holderKey)).entry_sk, entry.sk);
    assert.match(text(ctx.out), /Gave up after waiting 3 min: dev is locked by a manual hold by U123.*#1 in the queue.*ping you/s);
    assert.equal(levels(ctx.out).at(-1), "error");
    assert.equal(ctx.out.outputs.blocked, "true");
    assert.equal(ctx.out.outputs.acquired, "false");
  });

  it("pr_wait_minutes 0 gives up straight away, with the same notify entry as a fail-fast block", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make(githubEnv({ INPUT_PR_WAIT_MINUTES: "0" }));

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.deepEqual(ctx.clock.slept, []);
    assert.deepEqual((await ctx.queueItems()).map((item) => item.kind), ["notify"]);
  });

  it("a cancelled wait (the post step) takes its token out of the queue", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make();
    let cancel;
    const cancelled = new Promise((resolve) => (cancel = resolve));
    const clock = runClock(ctx, async () => {
      cancel();
      await new Promise(() => {}); // the job is cancelled while it sleeps: acquire never returns
    });
    acquire(settings, store, clock, ctx.out);
    await cancelled;

    await release(settings, store, new Output({ echo: false }));

    assert.deepEqual(await ctx.queueItems(), []);
  });

  it("waits in line in report-only too, then takes the lock", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.ok(ctx.clock.slept.reduce((a, b) => a + b, 0) >= 100);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(ctx.out.outputs.acquired, "true");
  });

  it("in report-only, giving up deploys anyway: no failure, no ping, out of the line", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await setPrPolicy(ctx, "wait");
    const key = await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(githubEnv({ INPUT_PR_WAIT_MINUTES: "2" }));

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal(ctx.clock.slept.reduce((a, b) => a + b, 0), 120);
    assert.equal((await ctx.currentLock()).holder_key, key); // untouched
    assert.deepEqual(await ctx.queueItems(), []);
    assert.match(text(ctx.out), /Waited 2 min: dev is locked by bob's deploy.*report-only mode, so this deploy would have failed; continuing/s);
    assert.ok(!levels(ctx.out).includes("error"));
    assert.equal(ctx.out.outputs.blocked, "false");
    assert.equal(ctx.out.outputs.acquired, "false");
  });

  it("in report-only, giving up also drops a notify entry it waited on, so the bot does not ping a deploy already done", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(githubEnv({ INPUT_PR_WAIT_MINUTES: "1" }));
    await queued(ctx, settings.holderKey, { kind: "notify", runs: [] }); // blocked earlier, under enforce

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(await ctx.queueClaim(settings.holderKey), null);
  });

  it("in report-only, giving up turns a notify entry a live sibling still waits on into a plain wait, keeping its place", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(githubEnv({ INPUT_PR_WAIT_MINUTES: "1" }));
    const sk = await queued(ctx, settings.holderKey, { kind: "notify", runs: ["sibling-run"] });
    await ctx.put({ ...(await ctx.queueItems())[0], claim_deadline: START + 600 }); // the bot had started its turn

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    const [entry] = await ctx.queueItems();
    assert.equal(entry.sk, sk); // same place in line
    assert.equal(entry.kind, "poll"); // no "your turn" ping for it any more
    assert.equal(entry.claim_deadline, undefined);
    assert.deepEqual([...entry.poll_run_ids], ["sibling-run"]);
    assert.equal((await ctx.queueClaim(settings.holderKey)).entry_sk, sk);
    // The sibling, still alive, refreshes it and keeps waiting there; another deploy sees it ahead.
    const sibling = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));
    await sibling.store.enqueue(sibling.settings, "poll");
    const zoe = ctx.make(githubEnv({ GITHUB_ACTOR: "zoe" }));
    assert.equal(await zoe.store.waitersAhead(zoe.settings), 1);
  });

  it("in report-only, a dead sibling's token does not keep the ping: the entry stops asking, then drops out once stale", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(githubEnv({ INPUT_PR_WAIT_MINUTES: "1" }));
    await queued(ctx, settings.holderKey, { kind: "notify", runs: ["dead-run"], heartbeat: START - 9999 }); // its runner died

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    const [entry] = await ctx.queueItems();
    assert.equal(entry.kind, "poll"); // never pinged as notify again
    const zoe = ctx.make(githubEnv({ GITHUB_ACTOR: "zoe" }));
    ctx.clock.current += POLL_ENTRY_STALE_SECONDS + 16; // nobody refreshes it
    assert.equal(await zoe.store.waitersAhead(zoe.settings), 0);
  });

  it("in report-only, a PR deploy waits behind a manual hold too (it never preempts one)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsManual({ expiresAt: START + 40 });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.ok(ctx.clock.slept.length > 0);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });

  for (const value of [null, "fail", "WAIT"]) {
    it(`pr_policy ${JSON.stringify(value)} fails fast as before`, async () => {
      const ctx = await lab.fresh();
      await ctx.setMode("enforce");
      if (value !== null) await setPrPolicy(ctx, value);
      await ctx.holdAsCi();
      const { settings, store } = ctx.make();

      assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

      assert.deepEqual(ctx.clock.slept, []);
      assert.deepEqual((await ctx.queueItems()).map((item) => item.kind), ["notify"]);
    });
  }
});

describe("report-only, with pr_policy fail", () => {
  for (const prPolicy of ["fail", "wait"]) {
    it(`a merge to main never waits for a CI deploy nor joins the queue: it warns and deploys at once (pr_policy ${prPolicy})`, async () => {
      const ctx = await lab.fresh();
      await ctx.setMode("report-only");
      await setPrPolicy(ctx, prPolicy);
      const key = await ctx.holdAsCi({ expiresAt: START + 100 });
      const { settings, store } = ctx.make(mainPushEnv());

      assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

      assert.deepEqual(ctx.clock.slept, []);
      assert.deepEqual(await ctx.queueItems(), []); // so the Slack bot never says it is in line
      assert.equal((await ctx.currentLock()).holder_key, key);
      assert.match(text(ctx.out), /report-only mode, so this deploy would have been blocked; continuing/);
      assert.equal(ctx.out.outputs.blocked, "false");
    });
  }

  it("a merge to main does not wait behind others in line either: it deploys without the lock", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await queued(ctx, MERGE, { mainPush: true }); // say an enforce-era merge still waiting
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.deepEqual(ctx.clock.slept, []);
    assert.equal(await ctx.currentLock(), null);
    assert.deepEqual((await ctx.queueItems()).map((item) => item.holder_key), [MERGE]);
  });

  it("a merge to main goes ahead alongside a manual hold without taking it over, as before", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await ctx.holdAsManual();
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.deepEqual(ctx.clock.slept, []);
    assert.equal((await ctx.currentLock()).holder_key, "manual#U123");
    assert.match(text(ctx.out), /report-only mode, so this deploy would have been blocked; continuing/);
  });

  it("a PR deploy does not wait: it warns and deploys, without joining the queue", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.deepEqual(ctx.clock.slept, []);
    assert.deepEqual(await ctx.queueItems(), []);
  });

  it("a PR deploy does not take a free lock from people waiting in line; it deploys without it", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    await queued(ctx, CAROL);
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal(await ctx.currentLock(), null);
    assert.match(text(ctx.out), /Dev is free, but 1 deploy is waiting in line ahead of this one\. dev-lock is in report-only mode/);
    assert.equal(ctx.out.outputs.acquired, "false");
  });
});

describe("first in, first out", () => {
  it("a free lock is not taken by a newcomer while someone waits in line; it waits its turn", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await queued(ctx, CAROL);
    const { settings, store } = ctx.make();
    let sleeps = 0;
    const clock = runClock(ctx, async () => {
      sleeps += 1;
      assert.equal(await ctx.currentLock(), null); // nobody took it: carol's turn
      if (sleeps === 2) {
        // carol takes dev and leaves the line (as tookLock does); here she just leaves it
        await ctx.doc.send(new DeleteCommand({ TableName: ctx.tableName, Key: { pk: QUEUE_PK, sk: (await ctx.queueClaim(CAROL)).entry_sk } }));
      }
    });

    assert.equal(await acquire(settings, store, clock, ctx.out), 0);

    assert.equal(sleeps, 2);
    assert.match(text(ctx.out), /Dev is free, but 1 deploy is waiting in line ahead of this one\. Waiting up to 30 min \(queue position #2\)/);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });

  it("a merge to main goes ahead of PR deploys that were waiting before it (production waits on it)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await queued(ctx, CAROL, { at: START - 60 });
    await queued(ctx, DAVE, { at: START - 30 });
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.deepEqual(ctx.clock.slept, []);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });

  it("a PR deploy waits behind a merge to main that is waiting, even one that arrived after it", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    const alice = ctx.make();
    await queued(ctx, alice.settings.holderKey, { at: START - 60 }); // alice was first
    await queued(ctx, MERGE, { at: START - 30, mainPush: true });

    assert.equal(await alice.store.waitersAhead(alice.settings), 1);
  });

  it("a merge to main waits behind a merge that was waiting before it (merges stay in order)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await queued(ctx, MERGE, { mainPush: true });
    await queued(ctx, CAROL); // a PR: never ahead of a merge
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await store.waitersAhead(settings), 1);
  });

  it("an entry from an older action without main_push is a waiting merge (only merges waited before)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await queued(ctx, MERGE, { mainPush: true, legacy: true });
    const merge = ctx.make(mainPushEnv());
    const pr = ctx.make(githubEnv({ GITHUB_ACTOR: "carol" }));

    assert.equal(await merge.store.waitersAhead(merge.settings), 1); // a newer merge stays behind it
    assert.equal(await pr.store.waitersAhead(pr.settings), 1);
    assert.equal((await ctx.queueItems())[0].main_push, undefined);
  });

  it("a merge to main waits out the turn the Slack bot gave someone", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const sk = await queued(ctx, CAROL, { kind: "notify", runs: [] });
    await ctx.put({ ...(await ctx.queueItems()).find((item) => item.sk === sk), claim_deadline: START + 30 });
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.ok(ctx.clock.slept.reduce((a, b) => a + b, 0) > 30);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });

  it("a waiting merge says it is one on its queue entry", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const merge = ctx.make(mainPushEnv());
    const pr = ctx.make(githubEnv({ GITHUB_ACTOR: "carol" }));

    await merge.store.enqueue(merge.settings, "poll");
    await pr.store.enqueue(pr.settings, "poll");

    const byHolder = Object.fromEntries((await ctx.queueItems()).map((item) => [item.holder_key, item.main_push]));
    assert.deepEqual(byHolder, { [merge.settings.holderKey]: true, [pr.settings.holderKey]: false });
  });

  it("with pr_policy fail, a PR deploy is blocked by a line even when dev is free", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await queued(ctx, CAROL);
    await queued(ctx, DAVE, { at: START - 20 });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.equal(await ctx.currentLock(), null);
    assert.match(text(ctx.out), /Dev is free, but 2 deploys are waiting in line ahead of this one\. You are #3 in the queue/);
    assert.equal(ctx.out.outputs.blocked, "true");
  });

  it("but a merge to main still takes a manual hold over with people in line (production must not wait on a hold)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsManual();
    await queued(ctx, CAROL);
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.deepEqual(ctx.clock.slept, []);
  });

  it("a sibling run joins its own holder's lock whoever is in line", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const first = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    assert.equal(await acquire(first.settings, first.store, ctx.clock, ctx.out), 0);
    await queued(ctx, CAROL);
    const second = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));

    assert.equal(await acquire(second.settings, second.store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).run_ids.size, 2);
  });

  it("who does not hold anyone up: a notify entry nobody waits on, a dead waiter, an expired entry", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await queued(ctx, CAROL, { kind: "notify", runs: [] }); // failed fast; pinged when dev is free
    await queued(ctx, DAVE, { at: START - 20, heartbeat: START - POLL_ENTRY_STALE_SECONDS - 16 }); // runner died
    await queued(ctx, "ci#o/r#erin#refs/pull/1/merge", { at: START - 10 });
    await ctx.put({ ...(await ctx.queueItems()).find((item) => item.holder_key.includes("erin")), ttl: START - 1 });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });

  it("a run waiting in line does not take dev during the turn the Slack bot gave someone ahead of it", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    const sk = await queued(ctx, CAROL, { kind: "notify", runs: [] }); // failed fast earlier, nobody waiting in a job
    await ctx.put({ ...(await ctx.queueItems()).find((item) => item.sk === sk), claim_deadline: START + 30 }); // "your turn, carol"
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.ok(ctx.clock.slept.reduce((a, b) => a + b, 0) > 30); // waited out carol's window
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.match(text(ctx.out), /Dev is free, but 1 deploy is waiting in line ahead of this one/);
  });

  it("a turn that ran out, or is being skipped, holds nobody up", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    for (const [holder, extra] of [
      [CAROL, { claim_deadline: START - 1 }],
      [DAVE, { claim_deadline: START + 300, skip_state: "announcing" }],
    ]) {
      const sk = await queued(ctx, holder, { kind: "notify", runs: [] });
      await ctx.put({ ...(await ctx.queueItems()).find((item) => item.sk === sk), ...extra });
    }
    const { settings, store } = ctx.make();

    assert.equal(await store.waitersAhead(settings), 0);
  });

  it("a notified deployer who re-runs and waits keeps their place", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const alice = ctx.make();
    await queued(ctx, alice.settings.holderKey, { at: START - 60, kind: "notify", runs: [] }); // blocked earlier
    await queued(ctx, CAROL, { at: START - 30 }); // waiting since after that
    const out = new Output({ echo: false });
    let checked = false;
    const clock = runClock(ctx, async () => {
      if (checked) return;
      checked = true;
      // While alice waits, carol has one deploy ahead of her, and alice none.
      assert.equal(await alice.store.waitersAhead(alice.settings), 0);
      assert.equal(await alice.store.waitersAhead({ holderKey: CAROL }), 1);
      await ctx.deleteLock();
    });

    assert.equal(await acquire(alice.settings, alice.store, clock, out), 0);

    assert.match(text(out), /queue position #1/);
    assert.ok(checked);
  });

  it("counts holders, not runs: two runs of one holder waiting are one deploy ahead", async () => {
    const ctx = await lab.fresh();
    await queued(ctx, CAROL, { runs: ["a", "b"] });
    const { settings, store } = ctx.make();

    assert.equal(await store.waitersAhead(settings), 1);
  });

  it("waiters take dev one after another: merges first, in the order they arrived, then PR deploys in theirs", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    await ctx.holdAsCi({ expiresAt: START + 99999 }); // freed once everyone is in line
    const order = [];
    const runs = [
      ["alice", githubEnv({ GITHUB_ACTOR: "alice" })],
      ["carol", githubEnv({ GITHUB_ACTOR: "carol" })],
      ["merge-1", mainPushEnv({ GITHUB_ACTOR: "bob" })],
      ["dave", githubEnv({ GITHUB_ACTOR: "dave" })],
      ["merge-2", mainPushEnv({ GITHUB_ACTOR: "erin" })],
    ];
    const finished = [];
    for (const [name, env] of runs) {
      const { settings, store } = ctx.make({ ...env, INPUT_PR_WAIT_MINUTES: "600", INPUT_WAIT_MINUTES: "600" });
      let arrive;
      const arrived = new Promise((resolve) => (arrive = resolve));
      const clock = runClock(ctx, () => arrive());
      finished.push(
        acquire(settings, store, clock, new Output({ echo: false })).then(async (code) => {
          assert.equal(code, 0);
          order.push(name);
          const lock = await ctx.currentLock();
          assert.equal(lock.holder_key, settings.holderKey); // exactly one holder at a time
          await release(settings, store, new Output({ echo: false }));
        }),
      );
      await arrived; // in the queue before the next one starts
      ctx.clock.current += 1;
    }
    await ctx.deleteLock();
    await Promise.all(finished);

    assert.deepEqual(order, ["merge-1", "merge-2", "alice", "carol", "dave"]);
    assert.equal(await ctx.currentLock(), null);
    assert.deepEqual(await ctx.queueItems(), []);
  });
});

describe("a long wait", () => {
  it("loses more races in all than the limit in a row without giving up (which would fail open)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await setPrPolicy(ctx, "wait");
    const { settings } = ctx.make();
    let calls = 0;
    const store = new (class extends LockStore {
      async putIfFree(s) {
        calls += 1;
        if (calls <= 4 || (calls >= 6 && calls <= 9)) return false; // dev looked free, someone else got it first
        if (calls === 5) {
          await ctx.holdAsCi({ expiresAt: START + 20 }); // and once someone actually did
          return false;
        }
        return super.putIfFree(s);
      }
    })(ctx.doc, ctx.tableName, () => ctx.clock.now());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.ok(calls > 9);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });
});
