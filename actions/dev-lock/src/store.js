import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const LOCK_KEY = Object.freeze({ pk: "LOCK#dev", sk: "CURRENT" });
export const CONFIG_KEY = Object.freeze({ pk: "CONFIG", sk: "mode" });
export const QUEUE_PK = "QUEUE#dev";
export const QUEUE_ENTRY_TTL_SECONDS = 4 * 60 * 60; // garbage collection only; entries are also removed explicitly
export const POLL_ENTRY_STALE_SECONDS = 120; // a polling job refreshes its entry every few seconds; older means its runner died

const isConditionFailure = (error) => error?.name === "ConditionalCheckFailedException";

/** The current holder of the dev lock. */
export class Lock {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  /** Build a lock from a DynamoDB item. */
  static fromItem(item) {
    return new Lock({
      holderType: item.holder_type ?? "ci",
      holderKey: item.holder_key,
      actor: item.actor ?? "unknown",
      repo: item.repo ?? null,
      ref: item.ref ?? null,
      reason: item.reason ?? null,
      startedAt: Number(item.started_at ?? 0),
      expiresAt: Number(item.expires_at),
    });
  }

  /** Whether this lock is free to take. Same rule as the conditional write: `expires_at < now`, in whole seconds. */
  isExpired(now) {
    return this.expiresAt < now;
  }
}

/** A queue entry still counts while it is unexpired and, for a polling job, still being refreshed. */
function isLive(entry, now) {
  if (Number(entry.ttl ?? now + 1) <= now) return false;
  // A `notify` entry belongs to a job that already failed and does not poll, so only `poll` entries can go stale.
  return !(entry.kind === "poll" && now - Number(entry.heartbeat_at ?? now) > POLL_ENTRY_STALE_SECONDS);
}

/**
 * All DynamoDB access for the dev lock.
 *
 * Lock expiry is decided here, in the conditions of the writes (`expires_at < now`), never by DynamoDB TTL:
 * TTL deletes lazily, up to about 48 hours late.
 */
export class LockStore {
  /** @param {{send: Function}} doc a DynamoDBDocumentClient @param {string} tableName @param {() => number} clock epoch seconds */
  constructor(doc, tableName, clock) {
    this.doc = doc;
    this.tableName = tableName;
    this.clock = clock;
  }

  /** Return the current time in whole seconds. Every expiry decision uses this, so the store and the runner cannot disagree. */
  now() {
    return Math.floor(this.clock());
  }

  // --- config -----------------------------------------------------------------------------------------------------

  /** Return the runtime mode string, or null when CONFIG/mode has never been written. */
  async getMode() {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: CONFIG_KEY, ConsistentRead: true }));
    return Item?.value ?? null;
  }

  // --- the lock ---------------------------------------------------------------------------------------------------

  /** Return the current lock (expired or not), or null when nothing is held. */
  async getLock() {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: LOCK_KEY, ConsistentRead: true }));
    return Item ? Lock.fromItem(Item) : null;
  }

  /** Take the lock if nobody holds it or the holder's lock has expired. A fresh start: new `started_at`, only this run. */
  async putIfFree(settings) {
    const now = this.now();
    const item = {
      ...LOCK_KEY,
      holder_type: "ci",
      holder_key: settings.holderKey,
      run_ids: new Set([settings.runToken]),
      repo: settings.repo,
      actor: settings.actor,
      ref: settings.ref,
      started_at: now,
      expires_at: now + settings.ttlSeconds,
    };
    if (settings.prUrl) item.pr_url = settings.prUrl;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk) OR expires_at < :now",
          ExpressionAttributeValues: { ":now": now },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
    return true;
  }

  /** Add this run to a lock its own holder already has (and push the expiry out). */
  async joinIfMine(settings) {
    const now = this.now();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: LOCK_KEY,
          UpdateExpression: "ADD run_ids :run SET expires_at = :expires",
          ConditionExpression: "holder_key = :me AND expires_at >= :now",
          ExpressionAttributeValues: {
            ":run": new Set([settings.runToken]),
            ":expires": now + settings.ttlSeconds,
            ":me": settings.holderKey,
            ":now": now,
          },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
    return true;
  }

  /**
   * Remove this run from its holder's lock; free the lock when the holder has no runs left. Idempotent.
   * Returns whether this run was actually holding the lock.
   */
  async release(settings) {
    let response;
    try {
      response = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: LOCK_KEY,
          UpdateExpression: "DELETE run_ids :run",
          ConditionExpression: "holder_key = :me",
          ExpressionAttributeValues: { ":run": new Set([settings.runToken]), ":me": settings.holderKey },
          ReturnValues: "ALL_OLD",
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) return false; // not the holder, or nothing held
      throw error;
    }
    const runsBefore = new Set(response.Attributes?.run_ids ?? []);
    const heldByThisRun = runsBefore.has(settings.runToken);
    const otherRuns = [...runsBefore].filter((token) => token !== settings.runToken);
    if (otherRuns.length > 0) return heldByThisRun;
    try {
      // If a sibling run of this holder joined in between, run_ids is back and the lock correctly stays.
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: LOCK_KEY,
          ConditionExpression: "holder_key = :me AND (attribute_not_exists(run_ids) OR size(run_ids) = :zero)",
          ExpressionAttributeValues: { ":me": settings.holderKey, ":zero": 0 },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    return heldByThisRun;
  }

  /** Tell a manual holder (via the Slack Lambda) that a merge to main deployed over their hold. */
  async markPreempted(holderKey, by) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: LOCK_KEY,
          UpdateExpression: "SET preempted_by = :by, preempted_at = :now",
          ConditionExpression: "holder_key = :hk",
          ExpressionAttributeValues: { ":by": by, ":now": this.now(), ":hk": holderKey },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  // --- the queue --------------------------------------------------------------------------------------------------

  async #queue() {
    const items = [];
    let startKey;
    do {
      const page = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": QUEUE_PK },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items.sort((a, b) => (a.sk < b.sk ? -1 : 1)); // sort keys are unique
  }

  async #liveQueue() {
    const now = this.now();
    return (await this.#queue()).filter((entry) => isLive(entry, now));
  }

  /**
   * Add this holder to the queue, or refresh its entry. Returns its 1-based position.
   *
   * `notify`: a failed deploy asking to be pinged when dev is free (kept until it gets the lock or leaves).
   * `poll`: a deploy that is waiting in its job (removed when it stops waiting).
   */
  async enqueue(settings, kind) {
    const now = this.now();
    const mine = (await this.#liveQueue()).filter((entry) => entry.holder_key === settings.holderKey);
    if (mine.length > 0) {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: QUEUE_PK, sk: mine[0].sk },
          UpdateExpression: "SET #kind = :kind, heartbeat_at = :now, run_url = :run_url, #ttl = :ttl",
          ExpressionAttributeNames: { "#kind": "kind", "#ttl": "ttl" },
          ExpressionAttributeValues: { ":kind": kind, ":now": now, ":run_url": settings.runUrl, ":ttl": now + QUEUE_ENTRY_TTL_SECONDS },
        }),
      );
    } else {
      const item = {
        pk: QUEUE_PK,
        sk: `${String(Math.floor(this.clock() * 1000)).padStart(13, "0")}#${settings.holderKey}`,
        kind,
        holder_key: settings.holderKey,
        repo: settings.repo,
        actor: settings.actor,
        ref: settings.ref,
        run_url: settings.runUrl,
        enqueued_at: now,
        heartbeat_at: now,
        ttl: now + QUEUE_ENTRY_TTL_SECONDS,
      };
      if (settings.prUrl) item.pr_url = settings.prUrl;
      await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
    }
    const holders = (await this.#liveQueue()).map((entry) => entry.holder_key);
    return holders.indexOf(settings.holderKey) + 1;
  }

  /** Remove a holder's queue entries of the given kinds. */
  async removeQueueEntries(holderKey, kinds = ["notify", "poll"]) {
    for (const entry of await this.#queue()) {
      if (entry.holder_key === holderKey && kinds.includes(entry.kind)) {
        await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: QUEUE_PK, sk: entry.sk } }));
      }
    }
  }
}
