import { readFileSync } from "node:fs";

export const DEFAULTS = Object.freeze({
  tableName: "catena-dev-lock",
  region: "us-east-1",
  ttlMinutes: 60,
  waitMinutes: 30,
  pollSeconds: 15,
});

/** Read an action input. GitHub passes an empty string for an input that is declared but unset. */
function input(env, name, fallback) {
  const value = (env[`INPUT_${name}`] ?? "").trim();
  return value || fallback;
}

function required(env, name) {
  if (env[name] === undefined) throw new Error(`missing environment variable ${name}`);
  return env[name];
}

function integer(text, name) {
  if (!/^-?\d+$/.test(String(text))) throw new Error(`${name} must be a whole number, got ${JSON.stringify(text)}`);
  return Number.parseInt(text, 10);
}

function pullRequestUrl(env) {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const url = JSON.parse(readFileSync(path, "utf8"))?.pull_request?.html_url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

/** Everything the action needs, read from the GitHub environment and the action inputs. */
export class Settings {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  /** Build settings from the GitHub environment; `overrides` replace fields (used by tests). */
  static fromEnv(env, overrides = {}) {
    return new Settings({
      tableName: input(env, "TABLE_NAME", DEFAULTS.tableName),
      region: input(env, "AWS_REGION", env.AWS_REGION || env.AWS_DEFAULT_REGION || DEFAULTS.region),
      ttlSeconds: integer(input(env, "TTL_MINUTES", String(DEFAULTS.ttlMinutes)), "ttl_minutes") * 60,
      waitSeconds: integer(input(env, "WAIT_MINUTES", String(DEFAULTS.waitMinutes)), "wait_minutes") * 60,
      pollSeconds: integer(input(env, "POLL_SECONDS", String(DEFAULTS.pollSeconds)), "poll_seconds"),
      repo: required(env, "GITHUB_REPOSITORY"),
      actor: required(env, "GITHUB_ACTOR"),
      ref: required(env, "GITHUB_REF"),
      runId: required(env, "GITHUB_RUN_ID"),
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? "1",
      job: env.GITHUB_JOB ?? "",
      eventName: env.GITHUB_EVENT_NAME ?? "",
      serverUrl: env.GITHUB_SERVER_URL ?? "https://github.com",
      prUrl: pullRequestUrl(env),
      ...overrides,
    });
  }

  /** Who holds the lock: every run started by one repo + actor + ref shares one holder. */
  get holderKey() {
    return `ci#${this.repo}#${this.actor}#${this.ref}`;
  }

  /** One workflow run's share of a holder. A holder keeps the lock until its last run releases. */
  get runToken() {
    return `${this.runId}-${this.runAttempt}-${this.job}`;
  }

  /** A merge to main. Its dev deploy gates the production deploy, so it is treated differently. */
  get isMainPush() {
    return this.eventName === "push" && this.ref === "refs/heads/main";
  }

  /** Link to this workflow run, shown to people who are told about it. */
  get runUrl() {
    return `${this.serverUrl}/${this.repo}/actions/runs/${this.runId}`;
  }
}
