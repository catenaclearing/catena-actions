// Shared helpers. Every test gets its own table in an in-memory DynamoDB (dynalite), so conditional writes, set
// operations, reserved words and consistent reads behave like the real service instead of like a stub.
import { randomUUID } from "node:crypto";
import dynalite from "dynalite";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Settings } from "../src/config.js";
import { Output } from "../src/github.js";
import { LockStore } from "../src/store.js";

export const START = 1_800_000_000; // a fixed "now" (epoch seconds) so expiry maths is exact

// The SDK reads credentials from the real process environment.
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AWS_REGION ??= "us-east-1";

/** Time that only moves when the code under test sleeps. */
export class FakeClock {
  constructor(now = START) {
    this.current = now;
    this.slept = [];
  }

  now() {
    return this.current;
  }

  async sleep(seconds) {
    this.slept.push(seconds);
    this.current += seconds;
  }
}

/** The environment GitHub gives an action for a PR-label dev deploy. */
export function githubEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "catenaclearing/telematics-data-service",
    GITHUB_ACTOR: "alice",
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_RUN_ID: "1001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "deploy-development",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SERVER_URL: "https://github.com",
    AWS_REGION: "us-east-1",
    ...overrides,
  };
}

export function mainPushEnv(overrides = {}) {
  return githubEnv({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", ...overrides });
}

/** One in-memory DynamoDB for a test file; `fresh()` gives each test its own table, clock and output. */
export class Lab {
  async start() {
    this.server = dynalite({ createTableMs: 0, deleteTableMs: 0 });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
    this.raw = new DynamoDBClient({
      endpoint: this.endpoint,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    });
    this.doc = DynamoDBDocumentClient.from(this.raw);
  }

  async stop() {
    this.raw.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  async fresh() {
    const tableName = `catena-dev-lock-${randomUUID().slice(0, 8)}`;
    await this.raw.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      }),
    );
    // A table is briefly CREATING; operations on it fail with "resource not found" until it is ACTIVE.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { Table } = await this.raw.send(new DescribeTableCommand({ TableName: tableName }));
      if (Table.TableStatus === "ACTIVE") return new Context(this, tableName);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`table ${tableName} never became active`);
  }
}

export class Context {
  constructor(lab, tableName) {
    this.lab = lab;
    this.doc = lab.doc;
    this.tableName = tableName;
    this.clock = new FakeClock();
    this.out = new Output({ echo: false });
  }

  /** Settings and a store for a given GitHub environment, on this test's table and clock. */
  make(env = githubEnv(), overrides = {}, doc = this.doc) {
    const settings = Settings.fromEnv({ ...env, INPUT_TABLE_NAME: this.tableName }, overrides);
    return { settings, store: new LockStore(doc, this.tableName, () => this.clock.now()) };
  }

  async put(item) {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async setMode(mode) {
    await this.put({ pk: "CONFIG", sk: "mode", value: mode });
  }

  async currentLock() {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: "LOCK#dev", sk: "CURRENT" }, ConsistentRead: true }),
    );
    return Item ?? null;
  }

  async queueItems() {
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "QUEUE#dev" },
        ConsistentRead: true,
      }),
    );
    return Items;
  }

  async deleteLock() {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: "LOCK#dev", sk: "CURRENT" } }));
  }

  async holdAsManual({ user = "U123", expiresAt = START + 7200 } = {}) {
    await this.put({
      pk: "LOCK#dev",
      sk: "CURRENT",
      holder_type: "manual",
      holder_key: `manual#${user}`,
      actor: user,
      reason: "testing the new connector",
      started_at: START - 60,
      expires_at: expiresAt,
    });
  }

  async holdAsCi({ repo = "catenaclearing/catena-platform", actor = "bob", expiresAt = START + 3600 } = {}) {
    const key = `ci#${repo}#${actor}#refs/pull/7/merge`;
    await this.put({
      pk: "LOCK#dev",
      sk: "CURRENT",
      holder_type: "ci",
      holder_key: key,
      run_ids: new Set(["2002-1-deploy-development"]),
      repo,
      actor,
      ref: "refs/pull/7/merge",
      started_at: START - 60,
      expires_at: expiresAt,
    });
    return key;
  }
}

export const levels = (out) => out.messages.map(([level]) => level);
export const text = (out) => out.messages.map(([, message]) => message).join("\n");
