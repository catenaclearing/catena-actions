// The timing-sensitive paths: another run changing the lock between two of our calls.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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

describe("two runs of one holder queueing at the same moment", () => {
  /** Clients whose first queue read waits until every run has done one, so each run sees a queue without its entry. */
  function barrier(doc, count) {
    let arrived = 0;
    let open;
    const opened = new Promise((resolve) => {
      open = resolve;
    });
    return () => {
      let waited = false;
      return {
        send: async (command) => {
          const response = await doc.send(command);
          if (!waited && command instanceof QueryCommand) {
            waited = true;
            arrived += 1;
            if (arrived === count) open();
            await opened;
          }
          return response;
        },
      };
    };
  }

  it("end up with one queue entry, and both are told the same position", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const ahead = "ci#catenaclearing/other#carol#refs/pull/9/merge";
    await ctx.put({ pk: "QUEUE#dev", sk: `${String((START - 30) * 1000).padStart(13, "0")}#${ahead}`, kind: "notify", holder_key: ahead, ttl: START + 3600 });
    const client = barrier(ctx.doc, 2);
    // Each run sees a different millisecond, as two runners would, so their entries get different sort keys.
    const runs = [["1001", 0.001], ["1002", 0.002]].map(([id, offset]) => ({
      settings: ctx.make(githubEnv({ GITHUB_RUN_ID: id })).settings,
      store: new LockStore(client(), ctx.tableName, () => ctx.clock.now() + offset),
    }));

    const positions = await Promise.all(runs.map(({ settings, store }) => store.enqueue(settings, "notify")));

    const mine = (await ctx.queueItems()).filter((entry) => entry.holder_key === runs[0].settings.holderKey);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].sk, (await ctx.queueClaim(runs[0].settings.holderKey)).entry_sk); // the one the claim names
    assert.deepEqual(positions, [2, 2]);
  });

  it("another holder's duplicate entry does not push the holders behind it back", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const ahead = "ci#catenaclearing/other#carol#refs/pull/9/merge";
    for (const offset of [30, 20]) {
      await ctx.put({ pk: "QUEUE#dev", sk: `${String((START - offset) * 1000).padStart(13, "0")}#${ahead}`, kind: "notify", holder_key: ahead, ttl: START + 3600 });
    }
    const { settings, store } = ctx.make();

    assert.equal(await store.enqueue(settings, "notify"), 2);
  });
});

describe("a holder's queue entry under concurrent runs (the claim item)", () => {
  const holder = () => "ci#catenaclearing/telematics-data-service#alice#refs/pull/42/merge";
  const sk = (seconds, key = holder()) => `${String(seconds * 1000).padStart(13, "0")}#${key}`;

  it("two runs that both see two entries of their holder never delete both (the cleanup is anchored to the claim)", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    // Leftovers from a crash: two entries, and the claim names the later one.
    for (const at of [START - 20, START - 10]) {
      await ctx.put({ pk: "QUEUE#dev", sk: sk(at), kind: "notify", holder_key: holder(), heartbeat_at: START, ttl: START + 3600 });
    }
    await ctx.put({ pk: "QUEUE_CLAIM#dev", sk: holder(), entry_sk: sk(START - 10), ttl: START + 3600 });
    const runs = ["1001", "1002"].map((id) => ctx.make(githubEnv({ GITHUB_RUN_ID: id })));

    const positions = await Promise.all(runs.map(({ settings, store }) => store.enqueue(settings, "notify")));

    const mine = (await ctx.queueItems()).filter((entry) => entry.holder_key === holder());
    assert.deepEqual(mine.map((entry) => entry.sk), [sk(START - 10)]);
    assert.deepEqual(positions, [1, 1]);
  });

  it("a run whose claim was taken over while it wrote removes its own entry and joins the new one", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    let moved = false;
    const doc = {
      send: async (command) => {
        // Right after this run writes its entry, another run of the holder moves the claim to a newer entry.
        if (!moved && command instanceof UpdateCommand && command.input.Key.pk === "QUEUE_CLAIM#dev") {
          moved = true;
          await ctx.put({ pk: "QUEUE#dev", sk: sk(START + 5), kind: "notify", holder_key: holder(), heartbeat_at: START, ttl: START + 3600 });
          await ctx.put({ pk: "QUEUE_CLAIM#dev", sk: holder(), entry_sk: sk(START + 5), ttl: START + 3600 });
        }
        return ctx.doc.send(command);
      },
    };
    const { settings, store } = ctx.make(githubEnv(), {}, doc);

    assert.equal(await store.enqueue(settings, "poll"), 1);

    const mine = (await ctx.queueItems()).filter((entry) => entry.holder_key === holder());
    assert.deepEqual(mine.map((entry) => entry.sk), [sk(START + 5)]);
    assert.equal(mine[0].kind, "poll"); // refreshed by this run
  });

  it("an entry deleted behind the claim's back (the Slack bot, or TTL) is replaced at the back of the queue", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const other = "ci#catenaclearing/other#carol#refs/pull/9/merge";
    await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 30, other), kind: "notify", holder_key: other, ttl: START + 3600 });
    await ctx.put({ pk: "QUEUE_CLAIM#dev", sk: holder(), entry_sk: sk(START - 60), ttl: START + 3600 }); // entry gone
    const { settings, store } = ctx.make();

    assert.equal(await store.enqueue(settings, "notify"), 2);

    assert.equal((await ctx.queueClaim(holder())).entry_sk, sk(START));
  });

  it("a dead (stale poll) entry is replaced, not revived, and is deleted", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 600), kind: "poll", holder_key: holder(), heartbeat_at: START - 600, ttl: START + 3600 });
    await ctx.put({ pk: "QUEUE_CLAIM#dev", sk: holder(), entry_sk: sk(START - 600), ttl: START + 3600 });
    const { settings, store } = ctx.make();

    await store.enqueue(settings, "poll");

    assert.deepEqual((await ctx.queueItems()).map((entry) => entry.sk), [sk(START)]);
  });

  it("leaving the queue removes the claim too, so the next block starts a fresh entry", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();
    await store.enqueue(settings, "notify");

    await store.removeQueueEntries(settings.holderKey);

    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(await ctx.queueClaim(settings.holderKey), null);
  });

  it("removing only `poll` entries keeps the claim of a `notify` entry", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();
    await store.enqueue(settings, "notify");

    await store.removeQueueEntries(settings.holderKey, ["poll"]);

    assert.equal((await ctx.queueItems()).length, 1);
    assert.equal((await ctx.queueClaim(settings.holderKey)).entry_sk, (await ctx.queueItems())[0].sk);
  });

  it("a claim that keeps moving ends in a failed-open run, not a loop", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const doc = {
      send: async (command) => {
        if (command instanceof UpdateCommand && command.input.Key.pk === "QUEUE_CLAIM#dev") {
          await ctx.put({ pk: "QUEUE_CLAIM#dev", sk: holder(), entry_sk: `elsewhere-${Math.random()}`, ttl: START + 3600 });
        }
        return ctx.doc.send(command);
      },
    };
    const { settings, store } = ctx.make(githubEnv(), {}, doc);

    await assert.rejects(store.enqueue(settings, "notify"), /kept changing/);
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

describe("a manual hold that ends while a merge to main is preempting it", () => {
  /** A client that runs `afterRead` once, right after the first read of the lock: the moment the run has decided what it saw. */
  function afterFirstLockRead(doc, afterRead) {
    let fired = false;
    return {
      send: async (command) => {
        const response = await doc.send(command);
        if (!fired && command instanceof GetCommand && command.input.Key.pk === "LOCK#dev") {
          fired = true;
          await afterRead();
        }
        return response;
      },
    };
  }

  const told = (ctx) => ctx.out.messages.some(([, message]) => message.includes("has been told"));

  it("waits for the CI deploy that took the lock in between, instead of deploying alongside it", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const doc = afterFirstLockRead(ctx.doc, async () => {
      await ctx.deleteLock(); // `/dev unlock`
      await ctx.holdAsCi({ expiresAt: START + 100 }); // and a PR deploy takes the lock straight away
    });
    const { settings, store } = ctx.make(mainPushEnv(), {}, doc);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.ok(ctx.clock.slept.length > 0, "it should have waited for bob's deploy");
    assert.equal(ctx.out.outputs.acquired, "true"); // and then took the lock when bob's expired
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
    assert.equal(told(ctx), false); // nobody was preempted, so nobody was told
  });

  it("gives up like any merge to main behind a CI deploy when that deploy does not end", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const doc = afterFirstLockRead(ctx.doc, async () => {
      await ctx.deleteLock();
      await ctx.holdAsCi({ expiresAt: START + 999_999 });
    });
    const { settings, store } = ctx.make(mainPushEnv(), {}, doc);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);

    assert.equal(ctx.out.outputs.blocked, "true");
    assert.equal((await ctx.currentLock()).holder_key, "ci#catenaclearing/catena-platform#bob#refs/pull/7/merge"); // untouched
    assert.equal((await ctx.currentLock()).preempted_by, undefined);
  });

  it("does not take over a hold that was extended in between (it reads the lock again and takes the new one over)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const doc = afterFirstLockRead(ctx.doc, () => ctx.holdAsManual({ expiresAt: START + 9000 })); // `/dev extend`
    const { settings, store } = ctx.make(mainPushEnv(), {}, doc);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).preempted_hold.expires_at, START + 9000); // the extended hold is the one kept
  });

  it("takes the lock when the hold ended and nobody else did", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const doc = afterFirstLockRead(ctx.doc, () => ctx.deleteLock());
    const { settings, store } = ctx.make(mainPushEnv(), {}, doc);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal(ctx.out.outputs.acquired, "true");
    assert.deepEqual(ctx.clock.slept, []); // no waiting needed
    assert.equal(told(ctx), false);
  });

  it("does not take over a hold that expired in the meantime", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual({ expiresAt: START + 1 });
    const doc = afterFirstLockRead(ctx.doc, async () => {
      ctx.clock.current = START + 5; // the hold runs out between the read and the stamp
    });
    const { settings, store } = ctx.make(mainPushEnv(), {}, doc);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal(ctx.out.outputs.acquired, "true");
    assert.equal(told(ctx), false);
    assert.equal((await ctx.currentLock()).holder_key, settings.holderKey);
  });

  it("looking again is bounded: a hold that keeps vanishing ends in a failed-open run, not a loop", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const { settings, store } = ctx.make(mainPushEnv());
    store.takeOverHold = async () => false; // the hold is gone every time it is taken over, yet getLock keeps finding one

    await assert.rejects(acquire(settings, store, ctx.clock, ctx.out), /kept changing/);
  });
});

describe("our own holder takes the lock between our failed join and our read", () => {
  it("joins it instead of being blocked by itself", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const sibling = ctx.make(githubEnv({ GITHUB_JOB: "deploy-development-2" }));
    let swapped = false;
    const doc = {
      send: async (command) => {
        if (!swapped && command instanceof GetCommand && command.input.Key.pk === "LOCK#dev") {
          swapped = true;
          await ctx.deleteLock(); // bob's deploy finishes
          assert.equal(await sibling.store.putIfFree(sibling.settings), true); // and our sibling run gets in first
        }
        return ctx.doc.send(command);
      },
    };
    const { settings, store } = ctx.make(githubEnv(), {}, doc);

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.equal(ctx.out.outputs.acquired, "true");
    assert.deepEqual(new Set((await ctx.currentLock()).run_ids), new Set([sibling.settings.runToken, settings.runToken]));
  });
});
