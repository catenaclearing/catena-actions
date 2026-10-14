import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const LOCK_KEY = Object.freeze({ pk: "LOCK#dev", sk: "CURRENT" });
export const CONFIG_KEY = Object.freeze({ pk: "CONFIG", sk: "mode" });
export const QUEUE_PK = "QUEUE#dev";
export const QUEUE_CLAIM_PK = "QUEUE_CLAIM#dev"; // one item per holder, naming its single queue entry
export const QUEUE_ENTRY_TTL_SECONDS = 4 * 60 * 60; // garbage collection only; entries are also removed explicitly
export const POLL_ENTRY_STALE_SECONDS = 120; // a polling job refreshes its entry every few seconds; older means its runner died

const MAX_QUEUE_RETRIES = 5;

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

  /**
   * Tell a manual holder (via the Slack Lambda) that a merge to main deployed over their hold.
   *
   * Returns whether that hold is still the live lock and was stamped. False means it ended (or was replaced) since the
   * caller read it, so there is nobody to preempt and the caller must look at the lock again.
   */
  async markPreempted(holderKey, by) {
    const now = this.now();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: LOCK_KEY,
          UpdateExpression: "SET preempted_by = :by, preempted_at = :now",
          ConditionExpression: "holder_key = :hk AND expires_at >= :now",
          ExpressionAttributeValues: { ":by": by, ":now": now, ":hk": holderKey },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
    return true;
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
   *
   * A holder has one entry, named by its claim item (`QUEUE_CLAIM#dev` / holder key). The claim only ever moves by a
   * conditional write, and only to a brand-new sort key, so every run of a holder agrees on which entry is the real one,
   * and any other entry of that holder can be deleted without ever deleting the one the claim names.
   */
  async enqueue(settings, kind) {
    for (let attempt = 0; attempt <= MAX_QUEUE_RETRIES; attempt += 1) {
      const sk = await this.#claimEntry(settings);
      if (sk === null) continue; // another run of this holder moved the claim first
      await this.#writeEntry(settings, kind, sk);
      if (!(await this.#confirmClaim(settings.holderKey, sk))) {
        // The claim moved while we wrote (or the holder left the queue): this entry is not the holder's any more.
        await this.#deleteEntry(sk);
        continue;
      }
      const live = await this.#liveQueue();
      for (const entry of live.filter((e) => e.holder_key === settings.holderKey && e.sk !== sk)) {
        await this.#deleteEntry(entry.sk); // a leftover from a run that lost the claim and has not cleaned up yet
      }
      // Count holders, not entries, so another holder's leftover (mid-race) does not push everyone behind it back.
      const holders = [...new Set(live.map((entry) => entry.holder_key))];
      return holders.indexOf(settings.holderKey) + 1;
    }
    throw new Error("this deploy's queue entry kept changing while trying to write it");
  }

  /** Return the sort key of this holder's entry, claiming a new one when it has none (or only a dead one). Null on a lost race. */
  async #claimEntry(settings) {
    const now = this.now();
    const claimKey = { pk: QUEUE_CLAIM_PK, sk: settings.holderKey };
    const { Item: claim } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: claimKey, ConsistentRead: true }));
    if (claim) {
      const { Item: entry } = await this.doc.send(
        new GetCommand({ TableName: this.tableName, Key: { pk: QUEUE_PK, sk: claim.entry_sk }, ConsistentRead: true }),
      );
      if (entry && isLive(entry, now)) return claim.entry_sk;
    }
    // A missing or dead entry is not kept: the holder goes to the back of the queue, as a new arrival.
    const sk = `${String(Math.floor(this.clock() * 1000)).padStart(13, "0")}#${settings.holderKey}`;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...claimKey, entry_sk: sk, ttl: now + QUEUE_ENTRY_TTL_SECONDS },
          ...(claim
            ? { ConditionExpression: "entry_sk = :old", ExpressionAttributeValues: { ":old": claim.entry_sk } }
            : { ConditionExpression: "attribute_not_exists(pk)" }),
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) return null;
      throw error;
    }
    if (claim && claim.entry_sk !== sk) await this.#deleteEntry(claim.entry_sk);
    return sk;
  }

  /** Create or refresh the entry at `sk`. An upsert, so two runs writing the same entry leave one item. */
  async #writeEntry(settings, kind, sk) {
    const now = this.now();
    const always = { kind, heartbeat_at: now, run_url: settings.runUrl, ttl: now + QUEUE_ENTRY_TTL_SECONDS };
    const once = { holder_key: settings.holderKey, repo: settings.repo, actor: settings.actor, ref: settings.ref, enqueued_at: now };
    if (settings.prUrl) once.pr_url = settings.prUrl;
    const names = {};
    const values = {};
    const sets = [];
    Object.entries({ ...always, ...once }).forEach(([field, value], i) => {
      names[`#f${i}`] = field;
      values[`:v${i}`] = value;
      sets.push(field in always ? `#f${i} = :v${i}` : `#f${i} = if_not_exists(#f${i}, :v${i})`);
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: QUEUE_PK, sk },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  /** Check the claim still names `sk`, and keep it alive as long as the entry. */
  async #confirmClaim(holderKey, sk) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: QUEUE_CLAIM_PK, sk: holderKey },
          UpdateExpression: "SET #ttl = :ttl",
          ConditionExpression: "entry_sk = :sk",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":ttl": this.now() + QUEUE_ENTRY_TTL_SECONDS, ":sk": sk },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
    return true;
  }

  async #deleteEntry(sk) {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: QUEUE_PK, sk } }));
  }

  /** Remove a holder's queue entries of the given kinds, and its claim when that named one of them. */
  async removeQueueEntries(holderKey, kinds = ["notify", "poll"]) {
    for (const entry of await this.#queue()) {
      if (entry.holder_key !== holderKey || !kinds.includes(entry.kind)) continue;
      await this.#deleteEntry(entry.sk);
      try {
        await this.doc.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: { pk: QUEUE_CLAIM_PK, sk: holderKey },
            ConditionExpression: "entry_sk = :sk",
            ExpressionAttributeValues: { ":sk": entry.sk },
          }),
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error; // the claim names another entry (or none): leave it
      }
    }
  }
}
