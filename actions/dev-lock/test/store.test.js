// Properties of the store that an emulator cannot show on its own, so these look at how it talks to DynamoDB.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { acquire, release } from "../src/runner.js";
import { Lock, LockStore } from "../src/store.js";
import { Lab, START, githubEnv, mainPushEnv } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

/** Passes every command through to the real client and remembers what was sent. */
function recording(doc) {
  const sent = [];
  return {
    sent,
    send: async (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return doc.send(command);
    },
  };
}

describe("how the store talks to DynamoDB", () => {
  it("every read is strongly consistent (a stale read of the lock would let two deploys believe they are alone)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const spy = recording(ctx.doc);
    const { settings } = ctx.make();
    const store = new LockStore(spy, ctx.tableName, () => ctx.clock.now());

    await acquire(settings, store, ctx.clock, ctx.out); // blocked: reads the mode, the lock and the queue
    await release(settings, store, ctx.out);

    const reads = spy.sent.filter(({ name }) => name === "GetCommand" || name === "QueryCommand");
    assert.deepEqual([...new Set(reads.map(({ name }) => name))].sort(), ["GetCommand", "QueryCommand"]);
    assert.ok(reads.every(({ input }) => input.ConsistentRead === true));
  });

  it("taking a free lock is a single write (each extra write is a window for a race)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const spy = recording(ctx.doc);
    const { settings } = ctx.make();
    const store = new LockStore(spy, ctx.tableName, () => ctx.clock.now());

    await acquire(settings, store, ctx.clock, ctx.out);

    const writes = spy.sent.filter(({ name }) => ["PutCommand", "UpdateCommand", "DeleteCommand"].includes(name));
    assert.deepEqual(writes.map(({ name }) => name), ["PutCommand"]);
  });

  it("only touches the one table it was given", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const spy = recording(ctx.doc);
    const { settings } = ctx.make(githubEnv());
    const store = new LockStore(spy, ctx.tableName, () => ctx.clock.now());

    await acquire(settings, store, ctx.clock, ctx.out);
    await release(settings, store, ctx.out);

    assert.ok(spy.sent.length > 0);
    assert.ok(spy.sent.every(({ input }) => input.TableName === ctx.tableName));
  });
});

describe("Lock.fromItem", () => {
  it("fills in what a hand-written or older item lacks", () => {
    const lock = Lock.fromItem({ holder_key: "manual#U1", expires_at: 100 });

    assert.deepEqual({ ...lock }, {
      holderType: "ci",
      holderKey: "manual#U1",
      actor: "unknown",
      repo: null,
      ref: null,
      reason: null,
      startedAt: 0,
      expiresAt: 100,
    });
  });

  it("decides expiry in whole seconds: free only once expires_at is strictly in the past", () => {
    const lock = Lock.fromItem({ holder_key: "k", expires_at: 100 });

    assert.equal(lock.isExpired(100), false);
    assert.equal(lock.isExpired(101), true);
  });
});

describe("queue order", () => {
  it("is worked out from the sort key, not from the order DynamoDB happens to return", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    // In milliseconds, as the store writes them; "middle" is at START, which is the entry this run will claim.
    const mk = (ms, actor) => ({ pk: "QUEUE#dev", sk: `${String(START * 1000 + ms).padStart(13, "0")}#ci#r#${actor}#ref`, kind: "notify", holder_key: `ci#r#${actor}#ref`, ttl: START + 9999 });
    const unsorted = {
      send: async (command) => {
        const response = await ctx.doc.send(command);
        return command.constructor.name === "QueryCommand" ? { Items: [mk(1, "late"), mk(-1, "first"), mk(0, "middle")] } : response;
      },
    };
    const { settings } = ctx.make(githubEnv({ GITHUB_ACTOR: "middle", GITHUB_REF: "ref" }), { repo: "r" });
    const store = new LockStore(unsorted, ctx.tableName, () => ctx.clock.now());

    const position = await store.enqueue(settings, "notify");

    assert.equal(position, 2);
  });
});

describe("LockStore.takeOverHold", () => {
  const take = (ctx) => {
    const { settings, store } = ctx.make(mainPushEnv());
    return { settings, taken: () => store.takeOverHold(settings, "manual#U123") };
  };

  it("turns a live hold into a lease held by this run, and keeps the hold", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsManual();
    const { settings, taken } = take(ctx);

    assert.equal(await taken(), true);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, settings.holderKey);
    assert.equal(lock.expires_at, START + settings.ttlSeconds);
    assert.equal(lock.preempted_by, settings.runUrl);
    assert.equal(lock.preempted_at, START);
    assert.deepEqual(lock.preempted_hold, {
      holder_type: "manual",
      holder_key: "manual#U123",
      actor: "U123",
      reason: "testing the new connector",
      started_at: START - 60,
      expires_at: START + 7200,
    });
  });

  it("says no, and writes nothing, when the lock has gone", async () => {
    const ctx = await lab.fresh();

    assert.equal(await take(ctx).taken(), false);

    assert.equal(await ctx.currentLock(), null); // a failed condition must not create the item
  });

  it("says no, and writes nothing, when someone else holds the lock now", async () => {
    const ctx = await lab.fresh();
    const bob = await ctx.holdAsCi();

    assert.equal(await take(ctx).taken(), false);

    assert.equal((await ctx.currentLock()).holder_key, bob);
  });

  it("says no when the hold has expired, even though its item is still there", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsManual({ expiresAt: START - 1 });

    assert.equal(await take(ctx).taken(), false);

    assert.equal((await ctx.currentLock()).holder_type, "manual");
  });

  it("is still live in the second the hold expires (the same whole-second rule as every other write)", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsManual({ expiresAt: START });

    assert.equal(await take(ctx).taken(), true);
  });

  it("says no when the hold changed between its read and its write", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsManual();
    const { settings } = ctx.make(mainPushEnv());
    let changed = false;
    const doc = {
      send: async (command) => {
        const response = await ctx.doc.send(command);
        if (!changed && command instanceof GetCommand) {
          changed = true;
          await ctx.holdAsManual({ expiresAt: START + 9000 }); // `/dev extend`
        }
        return response;
      },
    };
    const store = new LockStore(doc, ctx.tableName, () => ctx.clock.now());

    assert.equal(await store.takeOverHold(settings, "manual#U123"), false);

    assert.equal((await ctx.currentLock()).holder_type, "manual");
  });

  it("does not hide a real error as a lost race", async () => {
    const ctx = await lab.fresh();
    const { settings } = ctx.make(mainPushEnv());
    const broken = new LockStore({ send: async () => Promise.reject(Object.assign(new Error("no"), { name: "AccessDeniedException" })) }, ctx.tableName, () => ctx.clock.now());

    await assert.rejects(broken.takeOverHold(settings, "manual#U123"), /no/);
  });
});

describe("LockStore.joinIfMine", () => {
  it("never shortens the lease: a sibling with a longer TTL keeps its expiry", async () => {
    const ctx = await lab.fresh();
    const long = ctx.make(githubEnv({ GITHUB_JOB: "long", INPUT_TTL_MINUTES: "120" }));
    const short = ctx.make(githubEnv({ GITHUB_JOB: "short", INPUT_TTL_MINUTES: "10" }));
    await long.store.putIfFree(long.settings);

    assert.equal(await short.store.joinIfMine(short.settings), true);

    const lock = await ctx.currentLock();
    assert.equal(lock.expires_at, START + 120 * 60);
    assert.equal(lock.run_ids.size, 2);
  });

  it("pushes the expiry out when this run's TTL reaches further", async () => {
    const ctx = await lab.fresh();
    const first = ctx.make(githubEnv({ GITHUB_JOB: "a", INPUT_TTL_MINUTES: "10" }));
    const later = ctx.make(githubEnv({ GITHUB_JOB: "b", INPUT_TTL_MINUTES: "10" }));
    await first.store.putIfFree(first.settings);
    ctx.clock.current = START + 300;

    await later.store.joinIfMine(later.settings);

    assert.equal((await ctx.currentLock()).expires_at, START + 300 + 600);
  });

  it("does not join a replacement lock after the extension condition fails", async () => {
    const ctx = await lab.fresh();
    const first = ctx.make(githubEnv({ INPUT_TTL_MINUTES: "60" }));
    const joining = ctx.make(githubEnv({ GITHUB_JOB: "sibling", INPUT_TTL_MINUTES: "60" }));
    await first.store.putIfFree(first.settings);
    let replaced = false;
    const racing = {
      send: async (command) => {
        try {
          return await ctx.doc.send(command);
        } catch (error) {
          if (!replaced && command.constructor.name === "UpdateCommand" && error.name === "ConditionalCheckFailedException") {
            replaced = true;
            await ctx.holdAsCi();
          }
          throw error;
        }
      },
    };
    const store = new LockStore(racing, ctx.tableName, () => ctx.clock.now());

    assert.equal(await store.joinIfMine(joining.settings), false);

    const lock = await ctx.currentLock();
    assert.equal(lock.run_ids.has(joining.settings.runToken), false);
    assert.equal(lock.holder_key, "ci#catenaclearing/catena-platform#bob#refs/pull/7/merge");
  });

  it("does not join someone else's lock, or an expired one of its own", async () => {
    const ctx = await lab.fresh();
    const { settings, store } = ctx.make();
    await ctx.holdAsCi();
    assert.equal(await store.joinIfMine(settings), false);

    await ctx.deleteLock();
    await store.putIfFree(settings);
    ctx.clock.current = START + settings.ttlSeconds + 1;
    assert.equal(await ctx.make(githubEnv({ GITHUB_JOB: "x" })).store.joinIfMine(ctx.make(githubEnv({ GITHUB_JOB: "x" })).settings), false);
  });
});
