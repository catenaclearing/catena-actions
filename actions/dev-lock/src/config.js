import { randomUUID } from "node:crypto";
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

/**
 * Parse a whole-number input of at least `min`. Zero or a negative TTL would write a lock that has already expired, and a
 * zero or negative poll interval would spin against the table, so each input has its own lower bound.
 */
function integer(text, name, min) {
  const value = Number(text);
  if (!/^-?\d+$/.test(String(text)) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${min}, got ${JSON.stringify(text)}`);
  }
  return value;
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

/** The action state name the run token is saved under, for the post step. */
export const RUN_TOKEN_STATE = "run_token";

/**
 * One call of this action's share of a holder; a holder keeps the lock until its last share is released.
 *
 * Run id, attempt and job name alone are not unique: every leg of a matrix job has the same three, as does a job that
 * calls the action twice. A shared token would let the first of them to finish release the lock out from under the
 * others, so each call adds a random part. The readable prefix is only there for people looking at the table.
 */
export function newRunToken(env) {
  return `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}-${env.GITHUB_JOB ?? ""}-${randomUUID().slice(0, 8)}`;
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
      ttlSeconds: integer(input(env, "TTL_MINUTES", String(DEFAULTS.ttlMinutes)), "ttl_minutes", 1) * 60,
      waitSeconds: integer(input(env, "WAIT_MINUTES", String(DEFAULTS.waitMinutes)), "wait_minutes", 0) * 60,
      pollSeconds: integer(input(env, "POLL_SECONDS", String(DEFAULTS.pollSeconds)), "poll_seconds", 1),
      repo: required(env, "GITHUB_REPOSITORY"),
      actor: required(env, "GITHUB_ACTOR"),
      ref: required(env, "GITHUB_REF"),
      runId: required(env, "GITHUB_RUN_ID"),
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? "1",
      job: env.GITHUB_JOB ?? "",
      eventName: env.GITHUB_EVENT_NAME ?? "",
      serverUrl: env.GITHUB_SERVER_URL ?? "https://github.com",
      prUrl: pullRequestUrl(env),
      // The post step gets the token its own main step made (saved as action state), so it releases exactly that share.
      runToken: env[`STATE_${RUN_TOKEN_STATE}`] || newRunToken(env),
      ...overrides,
    });
  }

  /** Who holds the lock: every run started by one repo + actor + ref shares one holder. */
  get holderKey() {
    return `ci#${this.repo}#${this.actor}#${this.ref}`;
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
