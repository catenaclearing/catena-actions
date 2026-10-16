// The store's transactions, sent unchanged to a DynamoDB that runs them (DynamoDB Local), including the cancelled ones.
// dynalite has no TransactWriteItems, so without DEV_LOCK_DYNAMODB_ENDPOINT these are skipped locally; in CI (where
// `CI` is set) a missing endpoint fails instead, so this coverage cannot quietly disappear.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { acquire } from "../src/runner.js";
import { LockStore } from "../src/store.js";
import { Lab, REAL_DYNAMODB, START, githubEnv } from "./support.js";

const required = Boolean(process.env.CI);
const skip = REAL_DYNAMODB ? false : required ? false : "set DEV_LOCK_DYNAMODB_ENDPOINT to a DynamoDB Local (see test/support.js)";

const lab = new Lab();
before(async () => {
  if (!REAL_DYNAMODB && required) throw new Error("CI must run these against DynamoDB Local: DEV_LOCK_DYNAMODB_ENDPOINT is not set");
  if (REAL_DYNAMODB) await lab.start();
});
after(async () => {
  if (REAL_DYNAMODB) await lab.stop();
});

const holder = "ci#catenaclearing/telematics-data-service#alice#refs/pull/42/merge";
const sk = (seconds, key = holder) => `${String(seconds * 1000).padStart(13, "0")}#${key}`;

/**
 * A client that, once, runs `change` just before sending the first transaction `matches` picks, then sends that
 * transaction unchanged. When the backend cancels it, `afterCancel` runs at once, before the store reacts, so a test
 * can see exactly what the cancelled transaction left behind.
 */
function interfere(doc, matches, change, afterCancel) {
  const seen = { cancelled: null, sent: false };
  return {
    seen,
    send: async (command) => {
      if (seen.sent || !(command instanceof TransactWriteCommand) || !matches(command.input.TransactItems)) return doc.send(command);
      seen.sent = true;
      await change();
      try {
        return await doc.send(command);
      } catch (error) {
        seen.cancelled = error.name;
        await afterCancel();
        throw error;
      }
    },
  };
}

async function read(ctx, key) {
  const { Item } = await ctx.doc.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true }));
  return Item ?? null;
}

const claimKey = { pk: "QUEUE_CLAIM#dev", sk: holder };

describe("transactions against DynamoDB Local", { skip }, () => {
  it("an expired queue entry TTL has not deleted yet is replaced (`ttl` is a reserved word), and a blocked PR stays blocked", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 600), kind: "notify", holder_key: holder, heartbeat_at: START - 600, ttl: START - 1 });
    await ctx.put({ ...claimKey, entry_sk: sk(START - 600), ttl: START + 3600 });
    const { settings, store } = ctx.make();

    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1); // blocked, not failed open

    assert.equal(ctx.out.outputs.blocked, "true");
    assert.ok(!ctx.out.messages.some(([, message]) => message.includes("could not use the lock table")));
    const claim = await read(ctx, claimKey);
    assert.notEqual(claim.entry_sk, sk(START - 600));
    assert.deepEqual((await ctx.queueItems()).map((entry) => entry.sk), [claim.entry_sk]);
  });

  for (const [name, entry] of [
    ["a stale poll entry from before poll_seconds was stored", { kind: "poll", heartbeat_at: START - 600, ttl: START + 3600 }],
    ["a stale poll entry with poll_seconds", { kind: "poll", heartbeat_at: START - 600, poll_seconds: 15, ttl: START + 3600 }],
  ]) {
    it(`${name} is replaced by a real transaction`, async () => {
      const ctx = await lab.fresh();
      await ctx.holdAsCi();
      await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 600), holder_key: holder, ...entry });
      await ctx.put({ ...claimKey, entry_sk: sk(START - 600), ttl: START + 3600 });
      const { settings, store } = ctx.make();

      assert.equal(await store.enqueue(settings, "poll"), 1);

      const claim = await read(ctx, claimKey);
      assert.notEqual(claim.entry_sk, sk(START - 600));
      assert.deepEqual((await ctx.queueItems()).map((item) => item.sk), [claim.entry_sk]);
    });
  }

  it("moving the claim rolls back as a whole when the claim moved first: nothing of the cancelled write is left", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    await ctx.put({ ...claimKey, entry_sk: sk(START - 600), ttl: START + 3600 }); // its entry is gone
    let claimAfterCancel;
    const doc = interfere(
      ctx.doc,
      (items) => Boolean(items[1]?.Update && items[1].Update.Key.pk === "QUEUE_CLAIM#dev"),
      () => ctx.put({ ...claimKey, entry_sk: sk(START - 5), ttl: START + 3600 }), // a sibling run moved it
      async () => {
        claimAfterCancel = await read(ctx, claimKey);
      },
    );
    await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 5), kind: "notify", holder_key: holder, heartbeat_at: START, ttl: START + 3600 });
    const { settings } = ctx.make();
    const store = new LockStore(doc, ctx.tableName, () => ctx.clock.now());

    assert.equal(await store.enqueue(settings, "notify"), 1);

    assert.equal(doc.seen.cancelled, "TransactionCanceledException");
    assert.equal(claimAfterCancel.entry_sk, sk(START - 5)); // the cancelled update did not land
    assert.deepEqual((await ctx.queueItems()).map((item) => item.sk), [sk(START - 5)]); // and the run joined the sibling's
  });

  it("deleting a duplicate rolls back when the claim moved: the entry is still there", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 20), kind: "notify", holder_key: holder, heartbeat_at: START, ttl: START + 3600 });
    await ctx.put({ pk: "QUEUE#dev", sk: sk(START - 10), kind: "notify", holder_key: holder, heartbeat_at: START, ttl: START + 3600 });
    await ctx.put({ ...claimKey, entry_sk: sk(START - 10), ttl: START + 3600 });
    let duplicateAfterCancel;
    const doc = interfere(
      ctx.doc,
      (items) => Boolean(items[0]?.ConditionCheck && items[0].ConditionCheck.Key.pk === "QUEUE_CLAIM#dev"),
      () => ctx.put({ ...claimKey, entry_sk: sk(START - 20), ttl: START + 3600 }),
      async () => {
        duplicateAfterCancel = await read(ctx, { pk: "QUEUE#dev", sk: sk(START - 20) });
      },
    );
    const { settings } = ctx.make();
    const store = new LockStore(doc, ctx.tableName, () => ctx.clock.now());

    await store.enqueue(settings, "notify");

    assert.equal(doc.seen.cancelled, "TransactionCanceledException");
    assert.notEqual(duplicateAfterCancel, null);
    const claim = await read(ctx, claimKey);
    assert.ok((await ctx.queueItems()).some((item) => item.sk === claim.entry_sk)); // the claimed entry always survives
  });

  it("leaving the queue deletes the entry and its claim together", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const { settings, store } = ctx.make();
    await store.enqueue(settings, "notify");

    await store.removeQueueEntries(settings.holderKey);

    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(await read(ctx, claimKey), null);
  });

  it("a poll cleanup removes one waiter transactionally and deletes the entry with the final claim", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const first = ctx.make(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const second = ctx.make(githubEnv({ GITHUB_RUN_ID: "1002" }));
    await first.store.enqueue(first.settings, "poll");
    await second.store.enqueue(second.settings, "poll");

    await first.store.removeQueueEntries(first.settings.holderKey, ["poll"], first.settings.runToken);

    const [entry] = await ctx.queueItems();
    assert.deepEqual(entry.poll_run_ids, new Set([second.settings.runToken]));
    assert.equal((await read(ctx, claimKey)).entry_sk, entry.sk);

    await second.store.removeQueueEntries(second.settings.holderKey, ["poll"], second.settings.runToken);
    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(await read(ctx, claimKey), null);
  });

  it("leaving the queue rolls back as a whole when the claim moved: the entry is not deleted without its claim", async () => {
    const ctx = await lab.fresh();
    await ctx.holdAsCi();
    const { settings, store: plain } = ctx.make();
    await plain.enqueue(settings, "notify");
    const [entry] = await ctx.queueItems();
    let entryAfterCancel;
    let claimAfterCancel;
    const doc = interfere(
      ctx.doc,
      (items) => items.length === 2 && items.every((item) => item.Delete),
      () => ctx.doc.send(new PutCommand({ TableName: ctx.tableName, Item: { ...claimKey, entry_sk: "elsewhere", ttl: START + 3600 } })),
      async () => {
        entryAfterCancel = await read(ctx, { pk: "QUEUE#dev", sk: entry.sk });
        claimAfterCancel = await read(ctx, claimKey);
      },
    );
    const store = new LockStore(doc, ctx.tableName, () => ctx.clock.now());

    await store.removeQueueEntries(settings.holderKey);

    assert.equal(doc.seen.cancelled, "TransactionCanceledException");
    assert.notEqual(entryAfterCancel, null); // the entry's delete was rolled back with the claim's
    assert.equal(claimAfterCancel.entry_sk, "elsewhere");
    assert.equal(await read(ctx, { pk: "QUEUE#dev", sk: entry.sk }), null); // then removed on its own, as a leftover
    assert.equal((await read(ctx, claimKey)).entry_sk, "elsewhere"); // and the other claim was left alone
  });

  it("a whole blocked-then-released PR deploy leaves no queue state behind", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const bob = await ctx.holdAsCi();
    const { settings, store } = ctx.make(githubEnv());
    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 1);
    assert.equal((await ctx.queueItems()).length, 1);

    await ctx.deleteLock(); // bob is done
    assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    assert.notEqual((await ctx.currentLock()).holder_key, bob);
    assert.deepEqual(await ctx.queueItems(), []);
    assert.equal(await read(ctx, claimKey), null);
  });
});
