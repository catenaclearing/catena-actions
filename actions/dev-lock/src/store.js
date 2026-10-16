import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const LOCK_KEY = Object.freeze({ pk: "LOCK#dev", sk: "CURRENT" });
export const CONFIG_KEY = Object.freeze({ pk: "CONFIG", sk: "mode" });
export const QUEUE_PK = "QUEUE#dev";
export const QUEUE_CLAIM_PK = "QUEUE_CLAIM#dev"; // one item per holder, naming its single queue entry
export const QUEUE_ENTRY_TTL_SECONDS = 4 * 60 * 60; // garbage collection only; entries are also removed explicitly
export const POLL_ENTRY_STALE_SECONDS = 120; // a polling job refreshes its entry every few seconds; older means its runner died

const MAX_QUEUE_RETRIES = 5;
const MAX_FINISH_RETRIES = 5;

const isConditionFailure = (error) => error?.name === "ConditionalCheckFailedException";

/**
 * The lock item that gives a preempted manual hold back, from the takeover lease that kept it.
 *
 * Without the record of a steal the hold may have started as (`stolen_from_*`, `steal_reason`): the Slack bot announces
 * a new holder that carries one as a steal, and that steal is long over.
 */
function restoredHold(lease) {
  const kept = Object.fromEntries(
    Object.entries(lease.preempted_hold).filter(([field]) => !field.startsWith("stolen_") && field !== "steal_reason"),
  );
  const item = { ...kept, ...LOCK_KEY };
  if (lease.preempted_by !== undefined) item.preempted_by = lease.preempted_by;
  if (lease.preempted_at !== undefined) item.preempted_at = lease.preempted_at;
  return item;
}

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
  return !(entry.kind === "poll" && now - Number(entry.heartbeat_at ?? now) > POLL_ENTRY_STALE_SECONDS + Number(entry.poll_seconds ?? 0));
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

  /**
   * Take the lock if nobody holds it or the holder's lock has expired. A fresh start: new `started_at`, only this run.
   *
   * An expired takeover lease whose preempted manual hold is still live is not free: the hold is given back first (the
   * merge's post step never did), and this returns false so the caller reads the lock again and acts on the hold.
   */
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
          ConditionExpression:
            "attribute_not_exists(pk) OR (expires_at < :now AND (attribute_not_exists(preempted_hold) OR preempted_hold.expires_at < :now))",
          ExpressionAttributeValues: { ":now": now },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      await this.restoreExpiredTakeover();
      return false;
    }
    return true;
  }

  /**
   * Give back the manual hold an expired takeover lease kept, if that hold is still live. Returns whether it did.
   *
   * The lease ran out before the merge's post step released it (a cancelled or killed runner), so nothing else would:
   * replacing or deleting the expired lease would lose the hold. The write is conditional on the lease and its hold
   * being exactly what was read and the lease still expired, as in #finishRelease, so a release, `/dev unlock`,
   * `/dev extend` or another restore in between makes it do nothing.
   */
  async restoreExpiredTakeover() {
    const now = this.now();
    const { Item: lease } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: LOCK_KEY, ConsistentRead: true }));
    const hold = lease?.preempted_hold;
    if (!hold || Number(lease.expires_at) >= now || Number(hold.expires_at) < now) return false;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: restoredHold(lease),
          ConditionExpression:
            "holder_key = :lk AND started_at = :ls AND expires_at = :le AND expires_at < :now AND " +
            "preempted_hold.holder_key = :hk AND preempted_hold.started_at = :hs AND preempted_hold.expires_at = :he",
          ExpressionAttributeValues: {
            ":lk": lease.holder_key,
            ":ls": lease.started_at,
            ":le": lease.expires_at,
            ":now": now,
            ":hk": hold.holder_key,
            ":hs": hold.started_at,
            ":he": hold.expires_at,
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
   * Add this run to a lock its own holder already has, and push the expiry out to at least this run's TTL.
   */
  async joinIfMine(settings) {
    const now = this.now();
    const expires = now + settings.ttlSeconds;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: LOCK_KEY,
          UpdateExpression: "SET expires_at = :expires ADD run_ids :run",
          ConditionExpression: "holder_key = :me AND expires_at >= :now AND expires_at < :expires",
          ExpressionAttributeValues: {
            ":run": new Set([settings.runToken]),
            ":me": settings.holderKey,
            ":now": now,
            ":expires": expires,
          },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: LOCK_KEY,
            UpdateExpression: "ADD run_ids :run",
            ConditionExpression: "holder_key = :me AND expires_at >= :now AND expires_at >= :expires",
            ExpressionAttributeValues: { ":run": new Set([settings.runToken]), ":me": settings.holderKey, ":now": now, ":expires": expires },
          }),
        );
      } catch (fallbackError) {
        if (isConditionFailure(fallbackError)) return false;
        throw fallbackError;
      }
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
    await this.#finishRelease(settings.holderKey);
    return heldByThisRun;
  }

  /**
   * The holder has no runs left: give back the manual hold it preempted (if that hold is still wanted and live), or free
   * the lock.
   *
   * Every write is conditional on the item being what was just read: still this holder's, still empty, and with the same
   * `preempted_hold` (holder, start and expiry) or still none. So a `/dev unlock` or `/dev extend` that lands in between (the Slack
   * bot removes or edits `preempted_hold`) is never undone: the write fails and the item is read again. A sibling run
   * that joined in between makes run_ids non-empty again, and the lock correctly stays.
   */
  async #finishRelease(holderKey) {
    for (let attempt = 0; attempt <= MAX_FINISH_RETRIES; attempt += 1) {
      const { Item: item } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: LOCK_KEY, ConsistentRead: true }));
      if (!item || item.holder_key !== holderKey || (item.run_ids && item.run_ids.size > 0)) return;
      const hold = item.preempted_hold;
      // The hold is matched on its identifying fields, not as a whole map: equality on maps is not something to rely on.
      const unchanged =
        "holder_key = :me AND (attribute_not_exists(run_ids) OR size(run_ids) = :zero) AND " +
        (hold
          ? "preempted_hold.holder_key = :hk AND preempted_hold.started_at = :hs AND preempted_hold.expires_at = :he"
          : "attribute_not_exists(preempted_hold)");
      const values = {
        ":me": holderKey,
        ":zero": 0,
        ...(hold ? { ":hk": hold.holder_key, ":hs": hold.started_at, ":he": hold.expires_at } : {}),
      };
      try {
        if (hold && Number(hold.expires_at) >= this.now()) {
          // This lease preempted a manual hold that has not run out: give it back, so the holder still has dev.
          await this.doc.send(
            new PutCommand({
              TableName: this.tableName,
              Item: restoredHold(item),
              ConditionExpression: unchanged,
              ExpressionAttributeValues: values,
            }),
          );
        } else {
          await this.doc.send(
            new DeleteCommand({ TableName: this.tableName, Key: LOCK_KEY, ConditionExpression: unchanged, ExpressionAttributeValues: values }),
          );
        }
        return;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    // Still changing under us: leave it. The lease expires on its own, and nobody is let in early.
  }

  /**
   * Take the lock over from a manual hold, for a merge to main that must not wait on it.
   *
   * The run becomes an ordinary CI holder (so its siblings can join, every other deploy waits behind it, and its post
   * step releases it), and the hold is kept in `preempted_hold` so release can give it back. `preempted_by` and
   * `preempted_at` are how the Slack Lambda tells the holder.
   *
   * Returns whether it took over. False means the hold ended, changed or was replaced since it was read, so the caller
   * must look at the lock again.
   */
  async takeOverHold(settings, holderKey) {
    const now = this.now();
    const { Item: hold } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: LOCK_KEY, ConsistentRead: true }));
    if (!hold || hold.holder_key !== holderKey || hold.holder_type !== "manual" || Number(hold.expires_at) < now) return false;
    const { pk, sk, ...kept } = hold;
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
      preempted_by: settings.runUrl,
      preempted_at: now,
      preempted_hold: kept,
    };
    if (settings.prUrl) item.pr_url = settings.prUrl;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          // Exactly the hold that was read, still live: an unlock, an extension or a new holder in between all fail this.
          ConditionExpression: "holder_type = :manual AND holder_key = :hk AND started_at = :started AND expires_at = :expires AND expires_at >= :now",
          ExpressionAttributeValues: {
            ":manual": "manual",
            ":hk": holderKey,
            ":started": hold.started_at,
            ":expires": hold.expires_at,
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
      let claimMoved = false;
      for (const entry of live.filter((e) => e.holder_key === settings.holderKey && e.sk !== sk)) {
        if (!(await this.#deleteDuplicate(settings.holderKey, sk, entry.sk))) {
          claimMoved = true;
          break;
        }
      }
      if (claimMoved) continue;
      // Count holders, not entries, so another holder's leftover (mid-race) does not push everyone behind it back. This
      // holder counts only at its claimed entry: the duplicates just deleted must not move it ahead of anyone.
      const remaining = live.filter((entry) => entry.holder_key !== settings.holderKey || entry.sk === sk);
      const holders = [...new Set(remaining.map((entry) => entry.holder_key))];
      return holders.indexOf(settings.holderKey) + 1;
    }
    throw new Error("this deploy's queue entry kept changing while trying to write it");
  }

  /** Return the sort key of this holder's entry, claiming a new one when it has none (or only a dead one). Null on a lost race. */
  async #claimEntry(settings) {
    const now = this.now();
    const claimKey = { pk: QUEUE_CLAIM_PK, sk: settings.holderKey };
    const { Item: claim } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: claimKey, ConsistentRead: true }));
    let entry;
    if (claim) {
      ({ Item: entry } = await this.doc.send(
        new GetCommand({ TableName: this.tableName, Key: { pk: QUEUE_PK, sk: claim.entry_sk }, ConsistentRead: true }),
      ));
      if (entry && isLive(entry, now)) return claim.entry_sk;
    }
    // A missing or dead entry is not kept: the holder goes to the back of the queue, as a new arrival.
    const sk = `${String(Math.floor(this.clock() * 1000)).padStart(13, "0")}#${randomUUID()}#${settings.holderKey}`;
    try {
      if (claim) {
        const condition = this.#staleEntryCondition(entry, now);
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: { pk: QUEUE_PK, sk: claim.entry_sk },
                  ...condition,
                },
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: claimKey,
                  UpdateExpression: "SET entry_sk = :next, #ttl = :ttl",
                  ConditionExpression: "entry_sk = :old",
                  ExpressionAttributeNames: { "#ttl": "ttl" },
                  ExpressionAttributeValues: {
                    ":old": claim.entry_sk,
                    ":next": sk,
                    ":ttl": now + QUEUE_ENTRY_TTL_SECONDS,
                  },
                },
              },
            ],
          }),
        );
      } else {
        await this.doc.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { ...claimKey, entry_sk: sk, ttl: now + QUEUE_ENTRY_TTL_SECONDS },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      }
    } catch (error) {
      if (isConditionFailure(error) || error?.name === "TransactionCanceledException") return null;
      throw error;
    }
    if (claim && claim.entry_sk !== sk) await this.#deleteEntry(claim.entry_sk);
    return sk;
  }

  #staleEntryCondition(entry, now) {
    if (!entry) return { ConditionExpression: "attribute_not_exists(pk)" };
    if (Number(entry.ttl ?? now + 1) <= now) {
      return {
        ConditionExpression: "#ttl = :observed AND #ttl <= :now", // `ttl` is a DynamoDB reserved word
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":observed": entry.ttl, ":now": now },
      };
    }
    const heartbeat = Number(entry.heartbeat_at ?? now);
    const pollSeconds = Number(entry.poll_seconds ?? 0);
    const cutoff = now - POLL_ENTRY_STALE_SECONDS - pollSeconds;
    return {
      ConditionExpression:
        "#kind = :poll AND heartbeat_at = :heartbeat AND heartbeat_at < :cutoff AND " +
        (entry.poll_seconds === undefined ? "attribute_not_exists(poll_seconds)" : "poll_seconds = :pollSeconds"),
      ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: {
        ":poll": "poll",
        ":heartbeat": heartbeat,
        ":cutoff": cutoff,
        ...(entry.poll_seconds === undefined ? {} : { ":pollSeconds": entry.poll_seconds }),
      },
    };
  }

  /** Create or refresh the entry at `sk`. An upsert, so two runs writing the same entry leave one item. */
  async #writeEntry(settings, kind, sk) {
    const now = this.now();
    const always = {
      kind,
      heartbeat_at: now,
      run_url: settings.runUrl,
      ttl: now + QUEUE_ENTRY_TTL_SECONDS,
      ...(kind === "poll" ? { poll_seconds: settings.pollSeconds } : {}),
    };
    const once = { holder_key: settings.holderKey, repo: settings.repo, actor: settings.actor, ref: settings.ref, enqueued_at: now };
    if (settings.prUrl) once.pr_url = settings.prUrl;
    const names = {};
    const values = {};
    const sets = [];
    Object.entries({ ...always, ...once }).forEach(([field, value], i) => {
      names[`#f${i}`] = field;
      values[`:v${i}`] = value;
      sets.push(
        field === "kind" && kind === "poll"
          ? `#f${i} = if_not_exists(#f${i}, :v${i})`
          : field in always
            ? `#f${i} = :v${i}`
            : `#f${i} = if_not_exists(#f${i}, :v${i})`,
      );
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

  /** Delete a leftover only while the claim still points at this run's confirmed entry. */
  async #deleteDuplicate(holderKey, confirmedSk, duplicateSk) {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: QUEUE_CLAIM_PK, sk: holderKey },
                ConditionExpression: "entry_sk = :sk",
                ExpressionAttributeValues: { ":sk": confirmedSk },
              },
            },
            { Delete: { TableName: this.tableName, Key: { pk: QUEUE_PK, sk: duplicateSk } } },
          ],
        }),
      );
    } catch (error) {
      if (error?.name === "TransactionCanceledException") {
        const { Item: claim } = await this.doc.send(
          new GetCommand({ TableName: this.tableName, Key: { pk: QUEUE_CLAIM_PK, sk: holderKey }, ConsistentRead: true }),
        );
        if (claim?.entry_sk !== confirmedSk) return false;
      }
      throw error;
    }
    return true;
  }

  /** Remove a holder's queue entries of the given kinds, and its claim when that named one of them. */
  async removeQueueEntries(holderKey, kinds = ["notify", "poll"]) {
    for (const entry of await this.#queue()) {
      if (entry.holder_key !== holderKey || !kinds.includes(entry.kind)) continue;
      for (let attempt = 0; attempt <= MAX_QUEUE_RETRIES; attempt += 1) {
        const kindValues = Object.fromEntries(kinds.map((kind, index) => [`:kind${index}`, kind]));
        try {
          await this.doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Delete: {
                    TableName: this.tableName,
                    Key: { pk: QUEUE_PK, sk: entry.sk },
                    ConditionExpression: `holder_key = :holder AND #kind IN (${kinds.map((_, index) => `:kind${index}`).join(", ")})`,
                    ExpressionAttributeNames: { "#kind": "kind" },
                    ExpressionAttributeValues: { ":holder": holderKey, ...kindValues },
                  },
                },
                {
                  Delete: {
                    TableName: this.tableName,
                    Key: { pk: QUEUE_CLAIM_PK, sk: holderKey },
                    ConditionExpression: "entry_sk = :sk",
                    ExpressionAttributeValues: { ":sk": entry.sk },
                  },
                },
              ],
            }),
          );
          break;
        } catch (error) {
          if (error?.name !== "TransactionCanceledException") throw error;
          const [{ Item: current }, { Item: claim }] = await Promise.all([
            this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk: QUEUE_PK, sk: entry.sk }, ConsistentRead: true })),
            this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk: QUEUE_CLAIM_PK, sk: holderKey }, ConsistentRead: true })),
          ]);
          if (!current || current.holder_key !== holderKey || !kinds.includes(current.kind)) break;
          if (claim?.entry_sk !== entry.sk) {
            try {
              await this.doc.send(
                new DeleteCommand({
                  TableName: this.tableName,
                  Key: { pk: QUEUE_PK, sk: entry.sk },
                  ConditionExpression: `holder_key = :holder AND #kind IN (${kinds.map((_, index) => `:kind${index}`).join(", ")})`,
                  ExpressionAttributeNames: { "#kind": "kind" },
                  ExpressionAttributeValues: { ":holder": holderKey, ...kindValues },
                }),
              );
            } catch (deleteError) {
              if (!isConditionFailure(deleteError)) throw deleteError;
            }
            break;
          }
          if (attempt === MAX_QUEUE_RETRIES) throw error;
        }
      }
    }
  }
}
