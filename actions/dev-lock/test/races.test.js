// The timing-sensitive paths: another run changing the lock between two of our calls.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { acquire, release, run } from "../src/runner.js";
import { LockStore } from "../src/store.js";
import { Lab, START, githubEnv, mainPushEnv } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

/** Loses the first writes because "someone else" held the lock at that instant, then finds it freed. */
class FlakyStore extends LockStore {
  constructor(doc, tableName, clock, lose) {
    super(doc, tableName, clock);
    this.lose = lose;
  }

  async putIfFree(settings) {
    if (this.lose > 0) {
      this.lose -= 1;
      return false;
    }
    return super.putIfFree(settings);
  }
}

describe("a lock that changes while we try to take it", () => {
  it("freed between the write and the read is just retried", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings } = ctx.make();
    const store = new FlakyStore(ctx.doc, ctx.tableName, () => ctx.clock.now(), 1);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.equal(ctx.out.outputs.acquired, "true");
  });

  it("one that keeps changing gives up rather than spinning", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings } = ctx.make();
    const store = new FlakyStore(ctx.doc, ctx.tableName, () => ctx.clock.now(), 10_000);

    await assert.rejects(acquire(settings, store, ctx.clock, ctx.out), /kept changing/);
  });

  it("giving up on a changing lock fails open", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const store = new FlakyStore(ctx.doc, ctx.tableName, () => ctx.clock.now(), 10_000);

    const code = await run("acquire", { env: githubEnv({ INPUT_TABLE_NAME: ctx.tableName }), clock: ctx.clock, out: ctx.out, makeStore: () => store });

    assert.equal(code, 0);
    assert.match(ctx.out.messages[0][1], /kept changing/);
  });
});

describe("release is two writes, and a sibling can join between them", () => {
  it("the lock survives a sibling run joining in the middle of a release", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const first = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const second = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));
    await acquire(first.settings, first.store, ctx.clock, ctx.out);
    let done = false;
    const racing = {
      send: async (command) => {
        const response = await ctx.doc.send(command);
        if (!done && command instanceof UpdateCommand && command.input.UpdateExpression === "DELETE run_ids :run") {
          done = true;
          await second.store.joinIfMine(second.settings); // a sibling joins right after our first release write
        }
        return response;
      },
    };

    await release(first.settings, new LockStore(racing, ctx.tableName, () => ctx.clock.now()), ctx.out);

    assert.deepEqual([...(await ctx.currentLock()).run_ids], [second.settings.runToken]);
  });
});

describe("the queue", () => {
  it("counts entries beyond the first page", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    for (const actor of ["carol", "dave", "erin"]) {
      const { settings, store } = ctx.make(githubEnv({ GITHUB_ACTOR: actor }));
      await acquire(settings, store, ctx.clock, ctx.out);
      ctx.clock.current += 1;
    }
    const last = ctx.make(githubEnv({ GITHUB_ACTOR: "frank" }));
    const paged = {
      // One item per page, like a big queue would return.
      send: async (command) => {
        if (!(command instanceof QueryCommand)) return ctx.doc.send(command);
        const { ExclusiveStartKey, ...rest } = command.input;
        const { Items } = await ctx.doc.send(new QueryCommand(rest));
        const index = ExclusiveStartKey ? Number(ExclusiveStartKey.index) + 1 : 0;
        return { Items: Items.slice(index, index + 1), ...(index + 1 < Items.length ? { LastEvaluatedKey: { index } } : {}) };
      },
    };

    await acquire(last.settings, new LockStore(paged, ctx.tableName, () => ctx.clock.now()), ctx.clock, ctx.out);

    assert.equal((await ctx.queueItems()).length, 4);
    assert.match(ctx.out.messages.at(-1)[1], /#4/);
  });

  it("records the PR URL", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const { settings, store } = ctx.make(githubEnv(), { prUrl: "https://github.com/o/r/pull/42" });

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal((await ctx.queueItems())[0].pr_url, "https://github.com/o/r/pull/42");
  });

  it("a waiting entry whose runner died stops counting towards the queue", async () => {
    // A polling job refreshes its entry; one that stopped (runner killed) must not hold a place in the queue.
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const ghost = "ci#catenaclearing/ghost#dave#refs/heads/main";
    await ctx.put({ pk: "QUEUE#dev", sk: `${String(START - 600).padStart(13, "0")}#${ghost}`, kind: "poll", holder_key: ghost, heartbeat_at: START - 600, ttl: START + 3600 });
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.match(ctx.out.messages.at(-1)[1], /#1/);
  });

  it("a waiting entry that is still polling counts", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const waiting = "ci#catenaclearing/other#erin#refs/heads/main";
    await ctx.put({ pk: "QUEUE#dev", sk: `${String(START - 20).padStart(13, "0")}#${waiting}`, kind: "poll", holder_key: waiting, heartbeat_at: START - 20, ttl: START + 3600 });
    const { settings, store } = ctx.make();

    await acquire(settings, store, ctx.clock, ctx.out);

    assert.match(ctx.out.messages.at(-1)[1], /#2/);
  });

  it("a notify-me entry is not dropped for having no heartbeat (failed deploys do not poll)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const first = ctx.make(githubEnv({ GITHUB_ACTOR: "carol" }));
    await acquire(first.settings, first.store, ctx.clock, ctx.out);
    ctx.clock.current += 1800;
    await ctx.holdAsCi({ expiresAt: START + 99999 });
    const second = ctx.make(githubEnv({ GITHUB_ACTOR: "dave" }));

    await acquire(second.settings, second.store, ctx.clock, ctx.out);

    assert.match(ctx.out.messages.at(-1)[1], /#2/);
  });
});

describe("sub-second time: the store compares whole seconds, so the runner must too", () => {
  // Found running the real container: expires_at == the current whole second, but the wall clock is at .9. The store
  // (whole seconds) said "not expired yet" while a comparison against the fractional clock said "expired, so it is a
  // race, retry now". Six instant retries in the same second then gave up and failed open.
  it("a lock that expired within this second is not mistaken for a race", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi({ expiresAt: START });
    ctx.clock.current = START + 0.9;
    const { settings, store } = ctx.make(mainPushEnv());

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey); // it waited for the next poll and took the lock
    assert.equal(ctx.clock.slept.length, 1);
    assert.ok(ctx.out.messages.every(([, message]) => !message.includes("kept changing")));
  });

  for (const fraction of [0, 0.25, 0.5, 0.999]) {
    it(`a PR deploy is told who holds the lock at .${fraction} of the expiry second`, async () => {
      const ctx = await lab.fresh();
      await ctx.setMode("enforce");
      await ctx.holdAsCi({ expiresAt: START });
      ctx.clock.current = START + fraction;
      const { settings, store } = ctx.make();

      assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

      assert.match(ctx.out.messages.at(-1)[1], /bob/);
    });
  }
});
