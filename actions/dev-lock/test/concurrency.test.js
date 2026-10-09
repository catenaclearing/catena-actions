import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { acquire } from "../src/runner.js";
import { Lab, githubEnv } from "./support.js";

const lab = new Lab();
before(() => lab.start());
after(() => lab.stop());

it("only one of many simultaneous deploys takes the lock", async () => {
  const ctx = await lab.fresh();
  await ctx.setMode("enforce");
  const contenders = 12;

  const results = await Promise.all(
    Array.from({ length: contenders }, async (_, index) => {
      const { settings, store } = ctx.make(githubEnv({ GITHUB_ACTOR: `user${index}` }));
      const out = { outputs: {}, messages: [], notice() {}, warning() {}, error() {}, debug() {}, setOutput(name, value) { this.outputs[name] = value; } };
      const code = await acquire(settings, store, ctx.clock, out);
      return { actor: `user${index}`, code, acquired: out.outputs.acquired };
    }),
  );

  const holders = results.filter(({ acquired }) => acquired === "true");
  assert.equal(results.length, contenders);
  assert.equal(holders.length, 1);
  // Everyone else was told to stop: nobody is left believing they have the lock.
  assert.deepEqual(results.map(({ code }) => code).sort(), [0, ...Array(contenders - 1).fill(1)]);
  assert.equal((await ctx.currentLock()).actor, holders[0].actor);
});
