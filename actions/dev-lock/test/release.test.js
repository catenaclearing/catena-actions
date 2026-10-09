import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { acquire, release } from "../src/runner.js";
import { Lab, START, githubEnv } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

describe("release", () => {
  it("frees the lock", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal(await release(settings, store, ctx.out), 0);

    assert.equal(await ctx.currentLock(), null);
  });

  it("is idempotent", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal(await release(settings, store, ctx.out), 0);
    assert.equal(await release(settings, store, ctx.out), 0);
    assert.equal(await ctx.currentLock(), null);
  });

  it("when nothing is held is a no-op", async () => {
    const ctx = await lab.fresh();
    const { settings, store } = ctx.make();

    assert.equal(await release(settings, store, ctx.out), 0);

    assert.equal(await ctx.currentLock(), null);
  });

  it("never touches someone else's lock", async () => {
    const ctx = await lab.fresh();
    const key = await ctx.holdAsCi();
    const { settings, store } = ctx.make();

    assert.equal(await release(settings, store, ctx.out), 0);
    assert.equal(await store.release(settings), false);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, key);
    assert.deepEqual([...lock.run_ids], ["2002-1-deploy-development"]);
  });

  it("keeps the lock until the last run of a holder releases", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const first = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const second = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));
    await acquire(first.settings, first.store, ctx.clock, ctx.out);
    await acquire(second.settings, second.store, ctx.clock, ctx.out);

    await release(first.settings, first.store, ctx.out);
    assert.deepEqual([...(await ctx.currentLock()).run_ids], [second.settings.runToken]);

    await release(second.settings, second.store, ctx.out);
    assert.equal(await ctx.currentLock(), null);
  });

  it("a second release in the same job is harmless (deploy-cdk may call the action twice, so the post step runs twice)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);
    await acquire(settings, store, ctx.clock, ctx.out);

    await release(settings, store, ctx.out);
    await release(settings, store, ctx.out);

    assert.equal(await ctx.currentLock(), null);
  });

  it("removes a waiting entry but keeps the notify-me entry (a blocked PR deploy must still be pinged)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out); // blocked: notify entry
    await ctx.put({
      pk: "QUEUE#dev",
      sk: `${String(START + 1).padStart(13, "0")}#${settings.holderKey}`,
      kind: "poll",
      holder_key: settings.holderKey,
      ttl: START + 999,
    });

    await release(settings, store, ctx.out);

    assert.deepEqual((await ctx.queueItems()).map((item) => item.kind), ["notify"]);
  });

  it("does not remove other people's queue entries", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const waiting = ctx.make(githubEnv({ GITHUB_ACTOR: "carol" }));
    await acquire(waiting.settings, waiting.store, ctx.clock, ctx.out);
    const mine = ctx.make();

    await release(mine.settings, mine.store, ctx.out);

    assert.equal((await ctx.queueItems()).length, 1);
  });

  it("a run that never held the lock does not claim to release it (a blocked deploy's post step also runs)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);
    ctx.out.messages.length = 0;

    await release(settings, store, ctx.out);

    assert.equal(ctx.out.messages.filter(([, message]) => message.includes("Released")).length, 0);
  });

  it("a run that held the lock says so when it releases", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);
    ctx.out.messages.length = 0;

    await release(settings, store, ctx.out);

    assert.equal(ctx.out.messages.filter(([, message]) => message.includes("Released")).length, 1);
  });
});

describe("LockStore.release", () => {
  it("reports whether this run held the lock", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal(await store.release(settings), true);
    assert.equal(await store.release(settings), false);
  });

  it("reports true for each run while siblings remain", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const first = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const second = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));
    await acquire(first.settings, first.store, ctx.clock, ctx.out);
    await acquire(second.settings, second.store, ctx.clock, ctx.out);

    assert.equal(await first.store.release(first.settings), true); // a sibling is still running, so the lock stays, but this run did hold it
    assert.equal(await first.store.release(first.settings), false); // already gone
    assert.equal(await second.store.release(second.settings), true);
  });

  it("reports false for a run that is not in its holder's set (same holder, different run)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const holder = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const otherRun = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));
    await acquire(holder.settings, holder.store, ctx.clock, ctx.out);

    assert.equal(await otherRun.store.release(otherRun.settings), false);
    assert.equal(await holder.store.release(holder.settings), true);
  });
});
