// Properties of the store that an emulator cannot show on its own, so these look at how it talks to DynamoDB.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { acquire, release } from "../src/runner.js";
import { Lock, LockStore } from "../src/store.js";
import { Lab, START, githubEnv } from "./support.js";

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
    const mk = (n, actor) => ({ pk: "QUEUE#dev", sk: `${String(START + n).padStart(13, "0")}#ci#r#${actor}#ref`, kind: "notify", holder_key: `ci#r#${actor}#ref`, ttl: START + 9999 });
    const unsorted = {
      send: async (command) => {
        const response = await ctx.doc.send(command);
        return command.constructor.name === "QueryCommand" ? { Items: [mk(3, "late"), mk(1, "first"), mk(2, "middle")] } : response;
      },
    };
    const { settings } = ctx.make(githubEnv({ GITHUB_ACTOR: "middle", GITHUB_REF: "ref" }), { repo: "r" });
    const store = new LockStore(unsorted, ctx.tableName, () => ctx.clock.now());

    const position = await store.enqueue(settings, "notify");

    assert.equal(position, 2);
  });
});
