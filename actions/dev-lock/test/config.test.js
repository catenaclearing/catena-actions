import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Settings } from "../src/config.js";
import { githubEnv, mainPushEnv } from "./support.js";

describe("Settings", () => {
  it("the CI holder is repo, actor and ref", () => {
    assert.equal(Settings.fromEnv(githubEnv()).holderKey, "ci#catenaclearing/telematics-data-service#alice#refs/pull/42/merge");
  });

  it("runs started by one PR share a holder but have their own token", () => {
    const first = Settings.fromEnv(githubEnv({ GITHUB_RUN_ID: "1001" }));
    const second = Settings.fromEnv(githubEnv({ GITHUB_RUN_ID: "1002" }));
    assert.equal(first.holderKey, second.holderKey);
    assert.notEqual(first.runToken, second.runToken);
  });

  it("a re-run attempt and a different job change the token", () => {
    const base = Settings.fromEnv(githubEnv());
    assert.equal(base.runToken, "1001-1-deploy-development");
    assert.notEqual(Settings.fromEnv(githubEnv({ GITHUB_RUN_ATTEMPT: "2" })).runToken, base.runToken);
    assert.notEqual(Settings.fromEnv(githubEnv({ GITHUB_JOB: "other-job" })).runToken, base.runToken);
  });

  it("a different actor or ref is a different holder", () => {
    const base = Settings.fromEnv(githubEnv());
    assert.notEqual(Settings.fromEnv(githubEnv({ GITHUB_ACTOR: "bob" })).holderKey, base.holderKey);
    assert.notEqual(Settings.fromEnv(githubEnv({ GITHUB_REF: "refs/pull/43/merge" })).holderKey, base.holderKey);
  });

  const mainPushCases = [
    ["a pull request", githubEnv(), false],
    ["a push to main", mainPushEnv(), true],
    ["a push to another branch", githubEnv({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feature" }), false],
    ["a manual run on main", githubEnv({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" }), false],
  ];
  for (const [name, env, expected] of mainPushCases) {
    it(`only a push to main counts as a merge to main (${name})`, () => assert.equal(Settings.fromEnv(env).isMainPush, expected));
  }

  it("the defaults match the agreed policy", () => {
    const settings = Settings.fromEnv(githubEnv());
    assert.equal(settings.tableName, "catena-dev-lock");
    assert.equal(settings.ttlSeconds, 60 * 60);
    assert.equal(settings.waitSeconds, 30 * 60);
    assert.equal(settings.pollSeconds, 15);
  });

  it("inputs override the defaults", () => {
    const settings = Settings.fromEnv(
      githubEnv({ INPUT_TABLE_NAME: "t", INPUT_TTL_MINUTES: "5", INPUT_WAIT_MINUTES: "2", INPUT_POLL_SECONDS: "3", INPUT_AWS_REGION: "eu-west-1" }),
    );
    assert.deepEqual([settings.tableName, settings.ttlSeconds, settings.waitSeconds, settings.pollSeconds, settings.region], ["t", 300, 120, 3, "eu-west-1"]);
  });

  it("blank inputs fall back to the defaults (GitHub passes an empty string for an unset input)", () => {
    const settings = Settings.fromEnv(githubEnv({ INPUT_TABLE_NAME: "", INPUT_TTL_MINUTES: "  " }));
    assert.deepEqual([settings.tableName, settings.ttlSeconds], ["catena-dev-lock", 3600]);
  });

  it("a number input that is not a number is an error, not a silent default", () => {
    assert.throws(() => Settings.fromEnv(githubEnv({ INPUT_TTL_MINUTES: "soon" })), /ttl_minutes must be a whole number/);
  });

  it("a missing GitHub variable is an error", () => {
    const env = githubEnv();
    delete env.GITHUB_REPOSITORY;
    assert.throws(() => Settings.fromEnv(env), /missing environment variable GITHUB_REPOSITORY/);
  });

  describe("region", () => {
    it("defaults to us-east-1", () => {
      const env = githubEnv();
      delete env.AWS_REGION;
      assert.equal(Settings.fromEnv(env).region, "us-east-1");
    });

    it("comes from the environment in order", () => {
      const env = githubEnv();
      delete env.AWS_REGION;
      env.AWS_DEFAULT_REGION = "eu-west-1";
      assert.equal(Settings.fromEnv(env).region, "eu-west-1");
      env.AWS_REGION = "ap-south-1"; // what configure-aws-credentials exports; it wins over the default region
      assert.equal(Settings.fromEnv(env).region, "ap-south-1");
      env.INPUT_AWS_REGION = "us-west-2"; // an explicit input wins over everything
      assert.equal(Settings.fromEnv(env).region, "us-west-2");
    });
  });

  describe("the PR URL", () => {
    it("comes from the event payload", () => {
      const path = join(mkdtempSync(join(tmpdir(), "dev-lock-")), "event.json");
      writeFileSync(path, JSON.stringify({ pull_request: { html_url: "https://github.com/o/r/pull/42" } }));
      assert.equal(Settings.fromEnv(githubEnv({ GITHUB_EVENT_PATH: path })).prUrl, "https://github.com/o/r/pull/42");
    });

    it("is absent without a payload, with an unreadable one, or when the payload has no PR", () => {
      assert.equal(Settings.fromEnv(githubEnv()).prUrl, null);
      assert.equal(Settings.fromEnv(githubEnv({ GITHUB_EVENT_PATH: "/does/not/exist.json" })).prUrl, null);
      const path = join(mkdtempSync(join(tmpdir(), "dev-lock-")), "event.json");
      writeFileSync(path, "not json");
      assert.equal(Settings.fromEnv(githubEnv({ GITHUB_EVENT_PATH: path })).prUrl, null);
      writeFileSync(path, JSON.stringify({ pull_request: "nope" }));
      assert.equal(Settings.fromEnv(githubEnv({ GITHUB_EVENT_PATH: path })).prUrl, null);
    });
  });

  it("the server URL defaults to github.com and can be overridden (GitHub Enterprise)", () => {
    const env = githubEnv();
    delete env.GITHUB_SERVER_URL;
    assert.equal(Settings.fromEnv(env).runUrl, "https://github.com/catenaclearing/telematics-data-service/actions/runs/1001");
    assert.equal(Settings.fromEnv(githubEnv({ GITHUB_SERVER_URL: "https://ghe.example" })).runUrl, "https://ghe.example/catenaclearing/telematics-data-service/actions/runs/1001");
  });

  it("the run URL is built from the environment", () => {
    assert.equal(Settings.fromEnv(githubEnv()).runUrl, "https://github.com/catenaclearing/telematics-data-service/actions/runs/1001");
  });
});
