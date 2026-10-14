// The real DynamoDB client, against a server that goes silent. The SDK's `requestTimeout` only logs a warning unless the
// handler is told to throw, so without that a connection that is accepted and then never answered would hang the action
// (and its post step) until the job's own timeout. Nothing in an in-memory DynamoDB can show this, so these tests use a
// plain TCP server that accepts, reads, and never replies.
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { LIMITS, createDocumentClient, requestHandlerOptions } from "../src/client.js";
import { run } from "../src/runner.js";
import { LockStore } from "../src/store.js";
import { Lab, githubEnv } from "./support.js";

const lab = new Lab();
const FAST = { connectionTimeout: 200, requestTimeout: 300, maxAttempts: 1 };
let silent;
let silentUrl;
const sockets = new Set(); // a raw TCP server has no closeAllConnections(), and close() would wait for these forever
before(async () => {
  await lab.start();
  silent = net
    .createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => {});
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    })
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => silent.once("listening", resolve));
  silentUrl = `http://127.0.0.1:${silent.address().port}`;
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => silent.close(resolve));
  await lab.stop();
});

/** Fail the test, instead of hanging it, if `promise` has not settled in `ms`. */
function within(ms, promise, what) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

const key = { pk: "CONFIG", sk: "mode" };

describe("the DynamoDB client's timeouts", () => {
  it("abandons a request when the server accepts the connection and then never answers", async () => {
    const doc = createDocumentClient({ region: "us-east-1" }, { AWS_ENDPOINT_URL: silentUrl }, FAST);

    await assert.rejects(within(3000, doc.send(new GetCommand({ TableName: "t", Key: key })), "a silent server"), (error) => error.name === "TimeoutError");
  });

  it("works against a real endpoint with the same options (so the options object is accepted, not ignored)", async () => {
    const ctx = await lab.fresh();
    const doc = createDocumentClient({ region: "us-east-1" }, { AWS_ENDPOINT_URL: lab.endpoint }, FAST);

    await doc.send(new PutCommand({ TableName: ctx.tableName, Item: { ...key, value: "enforce" } }));
    const { Item } = await doc.send(new GetCommand({ TableName: ctx.tableName, Key: key }));

    assert.equal(Item.value, "enforce");
  });

  it("a silent store fails open instead of hanging: acquire and release both exit 0 and say it was not a block", async () => {
    const ctx = await lab.fresh();
    const env = githubEnv({ AWS_ENDPOINT_URL: silentUrl });
    const makeStore = (settings, runEnv) => new LockStore(createDocumentClient(settings, runEnv, FAST), settings.tableName, () => ctx.clock.now());

    assert.equal(await within(3000, run("acquire", { env, clock: ctx.clock, out: ctx.out, makeStore }), "acquire against a silent store"), 0);
    assert.match(ctx.out.messages[0][1], /TimeoutError/);
    assert.equal(ctx.out.outputs.blocked, "false");

    assert.equal(await within(3000, run("release", { env, clock: ctx.clock, out: ctx.out, makeStore }), "release against a silent store"), 0);
  });

  it("hands the SDK a real NodeHttpHandler instance carrying those options", async () => {
    const doc = createDocumentClient({ region: "us-east-1" }, {});
    const handler = doc.config.requestHandler;

    assert.ok(handler instanceof NodeHttpHandler);
    const config = await handler.configProvider;
    assert.equal(config.connectionTimeout, LIMITS.connectionTimeout);
    assert.equal(config.requestTimeout, LIMITS.requestTimeout);
    assert.equal(config.throwOnRequestTimeout, true);
  });

  it("the handler options always ask the SDK to throw on a request timeout, with the documented limits", () => {
    assert.deepEqual(requestHandlerOptions(), { connectionTimeout: 5000, requestTimeout: 10000, throwOnRequestTimeout: true });
    assert.deepEqual({ ...LIMITS }, { connectionTimeout: 5000, requestTimeout: 10000, maxAttempts: 3 });
  });
});
