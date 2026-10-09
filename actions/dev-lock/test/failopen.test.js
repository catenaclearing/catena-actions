import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { run } from "../src/runner.js";
import { LockStore } from "../src/store.js";
import { Lab, githubEnv } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

/** A document client whose every call fails the way AWS (or the network) can. */
const brokenDoc = (error) => ({
  send: async () => {
    throw error;
  },
});

const awsError = (name) => Object.assign(new Error("boom"), { name });

async function runWith(command, ctx, error, env = githubEnv()) {
  return run(command, { env, clock: ctx.clock, out: ctx.out, makeStore: () => new LockStore(brokenDoc(error), "catena-dev-lock", () => ctx.clock.now()) });
}

describe("fails open: a problem with the lock store never fails a deploy", () => {
  it("AccessDenied", async () => {
    const ctx = await lab.fresh();
    const error = awsError("AccessDeniedException");

    assert.equal(await runWith("acquire", ctx, error), 0);
    assert.equal(await runWith("release", ctx, error), 0);

    assert.equal(ctx.out.messages[0][0], "warning");
    assert.match(ctx.out.messages[0][1], /AccessDeniedException/);
    assert.equal(ctx.out.outputs.blocked, "false"); // an outage must never read as a deliberate block
  });

  for (const name of ["ThrottlingException", "InternalServerError", "ProvisionedThroughputExceededException", "TimeoutError"]) {
    it(name, async () => {
      const ctx = await lab.fresh();
      assert.equal(await runWith("acquire", ctx, awsError(name)), 0);
    });
  }

  it("a bug in the action", async () => {
    const ctx = await lab.fresh();
    assert.equal(await runWith("acquire", ctx, new TypeError("unexpected")), 0);
    assert.match(ctx.out.messages[0][1], /TypeError/);
  });

  it("a missing GitHub environment", async () => {
    const ctx = await lab.fresh();
    assert.equal(await run("acquire", { env: {}, clock: ctx.clock, out: ctx.out, makeStore: () => null }), 0);
  });

  it("says not acquired and keeps the stack for debugging", async () => {
    const ctx = await lab.fresh();
    await runWith("acquire", ctx, awsError("AccessDeniedException"));

    assert.equal(ctx.out.outputs.acquired, "false");
    assert.deepEqual(ctx.out.messages.map(([level]) => level), ["warning", "debug"]);
    assert.match(ctx.out.messages[1][1], /at /);
  });

  it("release never fails the job, even on a real error", async () => {
    const ctx = await lab.fresh();
    assert.equal(await runWith("release", ctx, awsError("InternalServerError")), 0);
  });
});

describe("fails open against the real SDK", () => {
  it("a table that does not exist (before the DevLock stack is deployed)", async () => {
    const ctx = await lab.fresh();
    const env = githubEnv({ AWS_ENDPOINT_URL: lab.endpoint, INPUT_TABLE_NAME: "catena-no-such-table" });

    assert.equal(await run("acquire", { env, clock: ctx.clock, out: ctx.out }), 0);

    assert.match(ctx.out.messages[0][1], /ResourceNotFoundException/);
  });

  it("an endpoint nothing listens on", async () => {
    const ctx = await lab.fresh();
    const env = githubEnv({ AWS_ENDPOINT_URL: "http://127.0.0.1:1", INPUT_TABLE_NAME: ctx.tableName });
    const started = Date.now();

    assert.equal(await run("acquire", { env, clock: ctx.clock, out: ctx.out }), 0);

    assert.equal(ctx.out.messages[0][0], "warning");
    assert.ok(Date.now() - started < 30_000, "gave up in bounded time");
  });
});

describe("what is not swallowed", () => {
  it("a real block still stops the deploy", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await ctx.holdAsCi();
    const env = githubEnv({ AWS_ENDPOINT_URL: lab.endpoint, INPUT_TABLE_NAME: ctx.tableName });

    assert.equal(await run("acquire", { env, clock: ctx.clock, out: ctx.out }), 1);
  });

  it("an unknown command names itself, and an empty one is also a wiring bug", async () => {
    const ctx = await lab.fresh();

    assert.equal(await run("nope", { env: githubEnv(), clock: ctx.clock, out: ctx.out }), 2);
    assert.deepEqual(ctx.out.messages, [
      ["error", "dev-lock: unknown command 'nope' (expected 'acquire' or 'release'); this is a bug in the action wiring."],
    ]);
    assert.equal(await run(undefined, { env: githubEnv(), clock: ctx.clock, out: ctx.out }), 2);
  });
});

describe("run() with its real defaults", () => {
  it("writes the step outputs to the GITHUB_OUTPUT file when it is given no output object", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const file = join(mkdtempSync(join(tmpdir(), "dev-lock-")), "github_output");
    const env = githubEnv({ AWS_ENDPOINT_URL: lab.endpoint, INPUT_TABLE_NAME: ctx.tableName, GITHUB_OUTPUT: file });

    assert.equal(await run("acquire", { env, clock: ctx.clock }), 0);

    assert.equal(readFileSync(file, "utf8"), "acquired=true\nblocked=false\n");
  });

  it("a failure that is not an Error object still produces a readable warning", async () => {
    const ctx = await lab.fresh();
    const store = new LockStore({ send: () => Promise.reject("boom") }, "catena-dev-lock", () => ctx.clock.now());

    assert.equal(await run("acquire", { env: githubEnv(), clock: ctx.clock, out: ctx.out, makeStore: () => store }), 0);

    assert.match(ctx.out.messages[0][1], /\(Error: boom\)/);
  });
});
