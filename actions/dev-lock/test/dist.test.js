// The built bundles, run as the GitHub runner runs them: separate `node` processes, from a directory that has nothing to do
// with the action, with inputs as INPUT_* variables and step outputs read back from the GITHUB_OUTPUT file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { bundle } from "../scripts/build.mjs";
import { Lab, githubEnv, mainPushEnv } from "./support.js";

const dist = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));
const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

/** Run a bundle in a fresh directory and return what the runner would see. */
function runBundle(file, env) {
  const cwd = mkdtempSync(join(tmpdir(), "dev-lock-cwd-"));
  const outputFile = join(cwd, "github_output");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dist(file)], {
      cwd,
      env: { PATH: process.env.PATH, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", ...env, GITHUB_OUTPUT: outputFile },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => {
      let outputs = "";
      try {
        outputs = readFileSync(outputFile, "utf8");
      } catch {
        /* the action wrote no outputs */
      }
      resolve({ code, stdout, outputs });
    });
  });
}

const forTable = (ctx, extra = {}) => githubEnv({ AWS_ENDPOINT_URL: lab.endpoint, INPUT_TABLE_NAME: ctx.tableName, ...extra });

describe("dist/main.cjs and dist/post.cjs", () => {
  it("main takes the lock and post gives it back (so a swapped entry point is caught)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");

    const main = await runBundle("main.cjs", forTable(ctx));
    assert.equal(main.code, 0);
    assert.match(main.stdout, /::notice::Holding the dev lock/);
    assert.equal(main.outputs, "acquired=true\nblocked=false\n");
    assert.equal((await ctx.currentLock()).actor, "alice");

    const post = await runBundle("post.cjs", forTable(ctx));
    assert.equal(post.code, 0);
    assert.match(post.stdout, /::notice::Released the dev lock/);
    assert.equal(await ctx.currentLock(), null);
  });

  it("a deploy blocked by another holder exits 1 with blocked=true, and its post step keeps its place in the queue", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    await runBundle("main.cjs", forTable(ctx));

    const blocked = await runBundle("main.cjs", forTable(ctx, { GITHUB_ACTOR: "bob", GITHUB_RUN_ID: "1002" }));
    assert.equal(blocked.code, 1);
    assert.equal(blocked.outputs, "acquired=false\nblocked=true\n");
    assert.match(blocked.stdout, /::error::Dev is locked by alice's deploy/);

    const post = await runBundle("post.cjs", forTable(ctx, { GITHUB_ACTOR: "bob", GITHUB_RUN_ID: "1002" }));
    assert.equal(post.code, 0);
    assert.equal((await ctx.currentLock()).actor, "alice"); // the other lock is intact
    assert.deepEqual((await ctx.queueItems()).map((item) => [item.kind, item.actor]), [["notify", "bob"]]);
  });

  it("works whatever directory it is started from (GitHub starts a container action in /github/workspace)", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const result = await runBundle("main.cjs", forTable(ctx)); // runBundle uses a fresh temp directory every time
    assert.equal(result.code, 0);
  });

  it("a merge to main waits for an expiring lock and takes it", async () => {
    const ctx = await lab.fresh();
    await ctx.setMode("enforce");
    const nowSeconds = Math.floor(Date.now() / 1000);
    await ctx.holdAsCi({ expiresAt: nowSeconds + 3 });

    const result = await runBundle("main.cjs", forTable(ctx, { ...mainPushEnv(), INPUT_POLL_SECONDS: "1", INPUT_WAIT_MINUTES: "1" }));

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Waiting up to 1 min/);
    assert.equal((await ctx.currentLock()).actor, "alice");
  });

  it("fails open when the lock store cannot be reached", async () => {
    const ctx = await lab.fresh();
    const env = forTable(ctx, { AWS_ENDPOINT_URL: "http://127.0.0.1:1" });

    const main = await runBundle("main.cjs", env);
    const post = await runBundle("post.cjs", env);

    assert.equal(main.code, 0);
    assert.equal(post.code, 0);
    assert.match(main.stdout, /::warning::dev-lock could not use the lock table/);
    assert.equal(main.outputs, "acquired=false\nblocked=false\n");
  });

  it("the post step never fails the job, even with no environment at all", async () => {
    const result = await runBundle("post.cjs", {});
    assert.equal(result.code, 0);
  });
});

describe("the committed dist/", () => {
  it("is exactly what `npm run build` produces (CI fails if someone edits src/ and forgets to rebuild)", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "dev-lock-dist-"));
    await bundle(fresh);
    assert.deepEqual(readdirSync(fresh).sort(), ["main.cjs", "post.cjs"]);
    for (const file of ["main.cjs", "post.cjs"]) {
      assert.equal(readFileSync(join(fresh, file), "utf8") === readFileSync(dist(file), "utf8"), true, `${file} is stale: run npm run build`);
    }
  });
});
