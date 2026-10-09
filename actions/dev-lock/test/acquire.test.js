import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Output } from "../src/github.js";
import { acquire } from "../src/runner.js";
import { Lab, START, githubEnv, levels, mainPushEnv, text } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

describe("taking a free lock", () => {
  it("takes it", async () => {
    const ctx = await lab.fresh();
    const { settings, store } = ctx.make();
    await ctx.setMode("enforce");

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_type, "ci");
    assert.equal(lock.holder_key, settings.holderKey);
    assert.deepEqual([...lock.run_ids], [settings.runToken]);
    assert.deepEqual([lock.repo, lock.actor, lock.ref], ["catenaclearing/telematics-data-service", "alice", "refs/pull/42/merge"]);
    assert.equal(lock.started_at, START);
    assert.equal(lock.expires_at, START + 3600);
    assert.equal(ctx.out.outputs.acquired, "true");
  });

  it("records the PR URL when there is one", async () => {
    const ctx = await lab.fresh();
    const event = join(mkdtempSync(join(tmpdir(), "dev-lock-")), "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { html_url: "https://github.com/o/r/pull/42" } }));
    const { settings, store } = ctx.make(githubEnv({ GITHUB_EVENT_PATH: event }));

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal((await ctx.currentLock()).pr_url, "https://github.com/o/r/pull/42");
  });

  it("two calls in one run are fine and refresh the expiry (a job can call deploy-cdk more than once)", async () => {
    const ctx = await lab.fresh();
    const { settings, store } = ctx.make();
    await ctx.setMode("enforce");
    await acquire(settings, store, ctx.clock, ctx.out);
    ctx.clock.current += 600;

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    const lock = await ctx.currentLock();
    assert.deepEqual([...lock.run_ids], [settings.runToken]);
    assert.equal(lock.started_at, START);
    assert.equal(lock.expires_at, START + 600 + 3600);
  });

  it("runs started by one PR share the lock (two platform modules must not block each other)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const first = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const second = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));

    assert.equal(await acquire(first.settings, first.store, ctx.clock, ctx.out), 0);
    assert.equal(await acquire(second.settings, second.store, ctx.clock, ctx.out), 0);

    assert.deepEqual([...(await ctx.currentLock()).run_ids].sort(), [first.settings.runToken, second.settings.runToken].sort());
  });

  it("takes over an expired lock even though the item is still there (DynamoDB TTL deletes lazily)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START - 1 });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, settings.holderKey);
    assert.equal(lock.started_at, START);
    assert.deepEqual([...lock.run_ids], [settings.runToken]);
  });

  it("a lock expiring this very second is still held", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);
  });

  it("clears my earlier notify-me queue entry", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();
    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1); // blocked, queued
    assert.deepEqual((await ctx.queueItems()).map((item) => item.holder_key), [settings.holderKey]);
    await ctx.deleteLock(); // the holder finishes

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.deepEqual(await ctx.queueItems(), []);
  });
});

describe("modes", () => {
  it("a missing CONFIG item means report-only", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);
    assert.ok(levels(ctx.out).includes("warning"));
    assert.deepEqual(await ctx.queueItems(), []);
  });

  it("report-only never blocks and leaves the lock alone", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("report-only");
    const key = await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).holder_key, key);
    assert.deepEqual(await ctx.queueItems(), []);
    assert.match(text(ctx.out), /report-only/);
    assert.equal(ctx.out.outputs.acquired, "false");
  });

  it("off does not touch the lock at all", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("off");
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal(await ctx.currentLock(), null);
    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(ctx.out.outputs.acquired, "false");
  });

  it("an unknown mode value never enforces", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("ENFORCE ");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);
  });
});

describe("PR-label deploys fail fast", () => {
  it("when CI holds the lock", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const key = await ctx.holdAsCi({ actor: "bob" });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.equal((await ctx.currentLock()).holder_key, key); // the holder is unaffected
    const message = text(ctx.out);
    assert.match(message, /bob/);
    assert.match(message, /catena-platform/);
    assert.match(message, /#1/); // queue position
    assert.equal(levels(ctx.out).at(-1), "error");
    assert.equal(ctx.out.outputs.acquired, "false");
  });

  it("when a manual hold exists", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);
    assert.match(text(ctx.out), /U123/);
  });

  it("is queued once even if retried", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);
    ctx.clock.current += 60;
    await acquire(settings, store, ctx.clock, ctx.out);

    const items = await ctx.queueItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "notify");
    assert.equal(items[0].holder_key, settings.holderKey);
    assert.equal(items[0].run_url, settings.runUrl);
  });

  it("queue position follows arrival order", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const first = ctx.make(githubEnv({ GITHUB_ACTOR: "carol" }));
    const second = ctx.make(githubEnv({ GITHUB_ACTOR: "dave" }));

    await acquire(first.settings, first.store, ctx.clock, ctx.out);
    ctx.clock.current += 5;
    const secondOut = new Output({ echo: false });
    await acquire(second.settings, second.store, ctx.clock, secondOut);

    assert.match(text(ctx.out), /#1/);
    assert.match(text(secondOut), /#2/);
  });

  it("expired queue entries do not count towards the position", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    await ctx.put({ pk: "QUEUE#dev", sk: `${String(START - 99999).padStart(13, "0")}#ci#x#y#z`, kind: "notify", holder_key: "ci#x#y#z", ttl: START - 1 });
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.match(text(ctx.out), /#1/);
  });
});

describe("merge to main", () => {
  it("waits for a CI deploy, then takes the lock", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0); // waits ~100s for the other lock to expire

    assert.ok(ctx.clock.slept.length > 0);
    assert.ok(ctx.clock.slept.every((seconds) => seconds === 15));
    assert.ok(ctx.clock.slept.reduce((a, b) => a + b, 0) >= 100);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.deepEqual(await ctx.queueItems(), []); // no longer waiting
  });

  it("gives up after the wait limit and fails the job", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const key = await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.ok(ctx.clock.slept.reduce((a, b) => a + b, 0) >= settings.waitSeconds);
    assert.equal((await ctx.currentLock()).holder_key, key);
    assert.equal(levels(ctx.out).at(-1), "error");
    assert.deepEqual(await ctx.queueItems(), []); // a waiting entry is not left behind
  });

  it("is in the queue as a poll entry while it waits", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make(mainPushEnv());
    const seen = [];
    const originalSleep = ctx.clock.sleep.bind(ctx.clock);
    ctx.clock.sleep = async (seconds) => {
      seen.push((await ctx.queueItems()).map((item) => item.kind));
      await originalSleep(seconds);
    };

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.ok(seen.length > 0);
    assert.ok(seen.every((kinds) => kinds.length === 1 && kinds[0] === "poll"));
  });

  it("goes ahead over a manual hold and tells the holder", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, "manual#U123"); // the hold stays
    assert.equal(lock.preempted_by, settings.runUrl);
    assert.deepEqual(ctx.clock.slept, []); // did not wait
    assert.ok(levels(ctx.out).includes("warning"));
    assert.equal(ctx.out.outputs.acquired, "false");
  });

  it("notices a manual hold that appears while it waits", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make(mainPushEnv());
    const originalSleep = ctx.clock.sleep.bind(ctx.clock);
    ctx.clock.sleep = async (seconds) => {
      await originalSleep(seconds);
      if (ctx.clock.slept.length === 1) await ctx.holdAsManual();
    };

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);
    assert.equal((await ctx.currentLock()).holder_key, "manual#U123");
    assert.equal(ctx.clock.slept.length, 1);
    assert.deepEqual(await ctx.queueItems(), []); // it had been waiting; going ahead must not leave its waiting entry behind
  });
});

describe("the step outputs and what people read in the job log", () => {
  it("waiting writes the step outputs once, not on every poll", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make(mainPushEnv());
    const file = join(mkdtempSync(join(tmpdir(), "dev-lock-")), "github_output");

    await acquire(settings, store, ctx.clock, new Output({ echo: false, outputFile: file }));

    assert.ok(ctx.clock.slept.length > 3); // it really did poll several times
    assert.equal(readFileSync(file, "utf8"), "acquired=true\nblocked=false\n");
  });

  it("a lock about to expire does not say zero minutes", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 40 });
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.doesNotMatch(text(ctx.out), /about 0 min/);
    assert.match(text(ctx.out), /under a minute/);
  });

  it("taking the lock says so", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.deepEqual(ctx.out.messages, [["notice", `Holding the dev lock for ${settings.holderKey} (mode: enforce).`]]);
  });

  it("waiting for a CI deploy says for how long and where you are in the queue, once", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 100 });
    const { settings, store } = ctx.make(mainPushEnv());

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.match(text(ctx.out), /Waiting up to 30 min \(queue position #1\)/);
    assert.deepEqual(ctx.out.messages.filter(([, message]) => message.includes("Waiting up to")), [ctx.out.messages[0]]);
  });

  it("mode off says it is off", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("off");
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.deepEqual(ctx.out.messages, [["notice", "dev-lock is off (table CONFIG/mode); deploying without the lock."]]);
  });
});

describe("the blocked output (how a deliberate stop reaches the workflow when the step is continue-on-error)", () => {
  it("a blocked PR deploy says so", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.equal(ctx.out.outputs.blocked, "true");
  });

  it("a merge to main that gave up waiting says so", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.equal(ctx.out.outputs.blocked, "true");
  });

  it("every outcome that lets the deploy go ahead says not blocked", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);
    assert.equal(ctx.out.outputs.blocked, "false"); // took the lock

    await ctx.setMode("off");
    const other = ctx.make(githubEnv({ GITHUB_ACTOR: "bob", GITHUB_RUN_ID: "1002" }));
    const outOff = new Output({ echo: false });
    await acquire(other.settings, other.store, ctx.clock, outOff);
    assert.equal(outOff.outputs.blocked, "false"); // mode off

    await ctx.setMode("report-only");
    const outReport = new Output({ echo: false });
    await acquire(other.settings, other.store, ctx.clock, outReport);
    assert.equal(outReport.outputs.blocked, "false"); // report-only, someone else holds it
  });

  it("preempting a manual hold is not a block", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const { settings, store } = ctx.make(mainPushEnv());

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal(ctx.out.outputs.blocked, "false");
  });
});
