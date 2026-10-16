import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { acquire, release, run } from "../src/runner.js";
import { LockStore } from "../src/store.js";
import { Output } from "../src/github.js";
import { Lab, START, githubEnv, mainPushEnv } from "./support.js";

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

  it("releases each repeated action invocation with its saved credentials and resolved table and region", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const dir = mkdtempSync(join(tmpdir(), "dev-lock-state-"));
    const states = [join(dir, "lock-1"), join(dir, "lock-2")];
    const calls = [];
    const makeStore = (settings, env) => {
      calls.push({ settings, env });
      return ctx.make(githubEnv(), {}, ctx.doc).store;
    };
    const invocationEnv = (id, accessKey, region) =>
      githubEnv({
        GITHUB_RUN_ID: id,
        INPUT_TABLE_NAME: ctx.tableName,
        INPUT_AWS_REGION: region,
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: `${accessKey}-secret`,
        AWS_SESSION_TOKEN: `${accessKey}-session`,
      });
    const acquireInvocation = async (index, env) =>
      run("acquire", {
        env,
        clock: ctx.clock,
        out: new Output({ echo: false, stateFile: states[index] }),
        makeStore,
      });
    const postEnv = (index, env) => ({
      ...env,
      ...Object.fromEntries(
        readFileSync(states[index], "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [`STATE_${line.slice(0, separator)}`, line.slice(separator + 1)];
          }),
      ),
    });
    try {
      const firstEnv = invocationEnv("1001", "first-access", "us-west-1");
      const secondEnv = invocationEnv("1002", "second-access", "eu-west-1");

      assert.equal(await acquireInvocation(0, firstEnv), 0);
      assert.equal(await acquireInvocation(1, secondEnv), 0);

      assert.equal(await run("release", { env: postEnv(1, secondEnv), clock: ctx.clock, out: ctx.out, makeStore }), 0);
      const afterSecond = await ctx.currentLock();
      assert.deepEqual([...afterSecond.run_ids], [calls[0].settings.runToken]);

      const cleanedEnv = { ...firstEnv };
      delete cleanedEnv.AWS_ACCESS_KEY_ID;
      delete cleanedEnv.AWS_SECRET_ACCESS_KEY;
      delete cleanedEnv.AWS_SESSION_TOKEN;
      const envBeforeFirstPost = { ...cleanedEnv };
      assert.equal(await run("release", { env: postEnv(0, cleanedEnv), clock: ctx.clock, out: ctx.out, makeStore }), 0);

      assert.equal(envBeforeFirstPost.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(calls[3].env.AWS_ACCESS_KEY_ID, "first-access");
      assert.equal(calls[3].env.AWS_SECRET_ACCESS_KEY, "first-access-secret");
      assert.equal(calls[3].env.AWS_SESSION_TOKEN, "first-access-session");
      assert.equal(calls[3].settings.tableName, ctx.tableName);
      assert.equal(calls[3].settings.region, "us-west-1");
      assert.equal(await ctx.currentLock(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("releasing a lease that preempted a manual hold", () => {
  it("gives the hold back, still marked as preempted, when it has not run out", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const { settings, store } = ctx.make(mainPushEnv());
    await acquire(settings, store, ctx.clock, ctx.out);

    await release(settings, store, ctx.out);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_type, "manual");
    assert.equal(lock.holder_key, "manual#U123");
    assert.equal(lock.reason, "testing the new connector");
    assert.equal(lock.expires_at, START + 7200);
    assert.equal(lock.preempted_by, settings.runUrl);
    assert.equal(lock.run_ids, undefined);
    assert.equal(lock.preempted_hold, undefined);
  });

  it("frees the lock when the hold ran out during the deploy", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual({ expiresAt: START + 10 });
    const { settings, store } = ctx.make(mainPushEnv());
    await acquire(settings, store, ctx.clock, ctx.out);
    ctx.clock.current = START + 60;

    await release(settings, store, ctx.out);

    assert.equal(await ctx.currentLock(), null);
  });

  it("keeps the lease while a sibling run is still deploying, and gives the hold back after the last one", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const first = ctx.make(mainPushEnv());
    const sibling = ctx.make(mainPushEnv({ GITHUB_JOB: "deploy-development-2" }));
    await acquire(first.settings, first.store, ctx.clock, ctx.out);
    await acquire(sibling.settings, sibling.store, ctx.clock, ctx.out);

    await release(first.settings, first.store, ctx.out);
    assert.equal((await ctx.currentLock()).holder_key, first.settings.holderKey);

    await release(sibling.settings, sibling.store, ctx.out);
    assert.equal((await ctx.currentLock()).holder_key, "manual#U123");
  });
});

describe("a takeover lease that expires before its post step releases it", () => {
  // The merge's runner was cancelled or killed, so its post step never gave the hold back.
  async function expiredTakeover(ctx, { holdExpiresAt = START + 5 * 3600, hold = {} } = {}) {
    await ctx.setMode("enforce");
    await ctx.holdAsManual({ expiresAt: holdExpiresAt });
    if (Object.keys(hold).length) await ctx.put({ ...(await ctx.currentLock()), ...hold });
    const merge = ctx.make(mainPushEnv());
    await acquire(merge.settings, merge.store, ctx.clock, ctx.out);
    assert.equal((await ctx.currentLock()).preempted_hold.holder_key, "manual#U123");
    ctx.clock.current = START + merge.settings.ttlSeconds + 1;
    return merge;
  }

  it("gives the hold back to its holder instead of letting a PR deploy take dev", async () => {
    const ctx = await lab.fresh();
    await expiredTakeover(ctx);
    const pr = ctx.make(githubEnv());

    assert.equal(await acquire(pr.settings, pr.store, ctx.clock, ctx.out), 1);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_type, "manual");
    assert.equal(lock.holder_key, "manual#U123");
    assert.equal(lock.started_at, START - 60);
    assert.equal(lock.expires_at, START + 5 * 3600);
    assert.equal(lock.preempted_hold, undefined);
    assert.equal(lock.run_ids, undefined);
    assert.equal(ctx.out.outputs.blocked, "true");
  });

  it("lets the next merge to main take the given-back hold over again, keeping it to give back", async () => {
    const ctx = await lab.fresh();
    await expiredTakeover(ctx);
    const next = ctx.make(mainPushEnv({ GITHUB_RUN_ID: "1009" }));

    assert.equal(await acquire(next.settings, next.store, ctx.clock, ctx.out), 0);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, next.settings.holderKey);
    assert.deepEqual([...lock.run_ids], [next.settings.runToken]);
    assert.equal(lock.preempted_hold.holder_key, "manual#U123");
    assert.equal(lock.preempted_hold.expires_at, START + 5 * 3600);
  });

  it("frees dev as usual when the hold ran out too", async () => {
    const ctx = await lab.fresh();
    await expiredTakeover(ctx, { holdExpiresAt: START + 600 });
    const pr = ctx.make(githubEnv());

    assert.equal(await acquire(pr.settings, pr.store, ctx.clock, ctx.out), 0);

    assert.equal((await ctx.currentLock()).holder_key, pr.settings.holderKey);
  });

  it("gives back a hold that started as a steal without the steal, so it is not announced again", async () => {
    const ctx = await lab.fresh();
    const steal = { stolen_from_key: "manual#U555", stolen_from_type: "manual", stolen_from_actor: "frank", steal_reason: "hotfix" };
    await expiredTakeover(ctx, { hold: { ...steal, stolen_from_slack_user: "U555", stolen_preempted_key: "manual#U777" } });
    const pr = ctx.make(githubEnv());

    await acquire(pr.settings, pr.store, ctx.clock, ctx.out);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, "manual#U123");
    assert.deepEqual(
      Object.keys(lock).filter((field) => field.startsWith("stolen_") || field === "steal_reason"),
      [],
    );
  });

  it("an ordinary release also gives back a stolen hold without the steal", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    await ctx.put({ ...(await ctx.currentLock()), stolen_from_key: "ci#x", stolen_from_type: "ci", steal_reason: "hotfix" });
    const merge = ctx.make(mainPushEnv());
    await acquire(merge.settings, merge.store, ctx.clock, ctx.out);

    await release(merge.settings, merge.store, ctx.out);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, "manual#U123");
    assert.equal(lock.stolen_from_key, undefined);
    assert.equal(lock.steal_reason, undefined);
  });

  it("does not give back a hold `/dev unlock` dropped while the restore was in flight", async () => {
    const ctx = await lab.fresh();
    await expiredTakeover(ctx);
    let unlocked = false;
    const doc = {
      send: async (command) => {
        if (!unlocked && command instanceof PutCommand && command.input.Item.holder_type === "manual") {
          unlocked = true;
          await ctx.doc.send(
            new UpdateCommand({ TableName: ctx.tableName, Key: { pk: "LOCK#dev", sk: "CURRENT" }, UpdateExpression: "REMOVE preempted_hold" }),
          );
        }
        return ctx.doc.send(command);
      },
    };
    const pr = ctx.make(githubEnv(), {}, doc);

    assert.equal(await acquire(pr.settings, new LockStore(doc, ctx.tableName, () => ctx.clock.now()), ctx.clock, ctx.out), 0);

    assert.ok(unlocked);
    assert.equal((await ctx.currentLock()).holder_key, pr.settings.holderKey);
  });
});

describe("matrix jobs: every leg has the same run id, attempt and job name", () => {
  it("the first leg to finish does not free the lock while another leg is still deploying", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const legs = [ctx.make(), ctx.make()];
    for (const { settings, store } of legs) assert.equal(await acquire(settings, store, ctx.clock, ctx.out), 0);

    await release(legs[0].settings, legs[0].store, ctx.out);

    const lock = await ctx.currentLock();
    assert.deepEqual([...lock.run_ids], [legs[1].settings.runToken]);

    await release(legs[1].settings, legs[1].store, ctx.out);
    assert.equal(await ctx.currentLock(), null);
  });

  it("acquire saves its token as action state, and a post step given that state releases exactly that share", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const { settings, store } = ctx.make();
    await acquire(settings, store, ctx.clock, ctx.out);

    assert.equal(ctx.out.state.run_token, settings.runToken);
    const post = ctx.make(githubEnv({ STATE_run_token: ctx.out.state.run_token }));
    await release(post.settings, post.store, ctx.out);
    assert.equal(await ctx.currentLock(), null);
  });
});

describe("the Slack bot changing a taken-over hold while the lease is being released", () => {
  /** A client that runs `change` once, right after release reads the lock to decide whether to give the hold back. */
  function changeAfterDecidingRead(doc, change) {
    let releasing = false;
    let fired = false;
    return {
      send: async (command) => {
        const response = await doc.send(command);
        if (command instanceof UpdateCommand && command.input.UpdateExpression === "DELETE run_ids :run") releasing = true;
        else if (releasing && !fired && command instanceof GetCommand && command.input.Key.pk === "LOCK#dev") {
          fired = true;
          await change();
        }
        return response;
      },
    };
  }

  async function takenOver(ctx) {
    await ctx.setMode("enforce");
    await ctx.holdAsManual();
    const merge = ctx.make(mainPushEnv());
    await acquire(merge.settings, merge.store, ctx.clock, ctx.out);
    return merge.settings;
  }

  it("`/dev unlock` in between (preempted_hold removed) is not undone: the lock is freed, not the hold put back", async () => {
    const ctx = await lab.fresh();
    const settings = await takenOver(ctx);
    const doc = changeAfterDecidingRead(ctx.doc, () =>
      ctx.doc.send(new UpdateCommand({ TableName: ctx.tableName, Key: { pk: "LOCK#dev", sk: "CURRENT" }, UpdateExpression: "REMOVE preempted_hold" })),
    );
    const { store } = ctx.make(githubEnv(), {}, doc);

    await release(settings, store, ctx.out);

    assert.equal(await ctx.currentLock(), null);
  });

  it("`/dev extend` in between gives back the extended hold, not the one read before it", async () => {
    const ctx = await lab.fresh();
    const settings = await takenOver(ctx);
    const doc = changeAfterDecidingRead(ctx.doc, () =>
      ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: { pk: "LOCK#dev", sk: "CURRENT" },
          UpdateExpression: "SET preempted_hold.expires_at = :e",
          ExpressionAttributeValues: { ":e": START + 9000 },
        }),
      ),
    );
    const { store } = ctx.make(githubEnv(), {}, doc);

    await release(settings, store, ctx.out);

    const lock = await ctx.currentLock();
    assert.equal(lock.holder_key, "manual#U123");
    assert.equal(lock.expires_at, START + 9000);
  });

  it("a sibling joining in between keeps the lease", async () => {
    const ctx = await lab.fresh();
    const settings = await takenOver(ctx);
    const sibling = ctx.make(mainPushEnv({ GITHUB_JOB: "deploy-development-2" }));
    const doc = changeAfterDecidingRead(ctx.doc, () => sibling.store.joinIfMine(sibling.settings));
    const { store } = ctx.make(githubEnv(), {}, doc);

    await release(settings, store, ctx.out);

    assert.deepEqual([...(await ctx.currentLock()).run_ids], [sibling.settings.runToken]);
  });
});
