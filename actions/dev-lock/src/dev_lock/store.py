from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError

from dev_lock.config import Settings


LOCK_KEY = {"pk": "LOCK#dev", "sk": "CURRENT"}
CONFIG_KEY = {"pk": "CONFIG", "sk": "mode"}
QUEUE_PK = "QUEUE#dev"
QUEUE_ENTRY_TTL_SECONDS = 4 * 60 * 60  # garbage collection only; entries are also removed explicitly
POLL_ENTRY_STALE_SECONDS = 120  # a polling job refreshes its entry every few seconds; older means its runner died


def _is_condition_failure(error: ClientError) -> bool:
    return error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


def _is_live(entry: dict[str, Any], now: int) -> bool:
    if int(entry.get("ttl", now + 1)) <= now:
        return False
    # A `notify` entry belongs to a job that already failed and does not poll, so only `poll` entries can go stale.
    return not (entry.get("kind") == "poll" and now - int(entry.get("heartbeat_at", now)) > POLL_ENTRY_STALE_SECONDS)


@dataclass(frozen=True)
class Lock:
    """The current holder of the dev lock."""

    holder_type: str
    holder_key: str
    actor: str
    repo: str | None
    ref: str | None
    reason: str | None
    started_at: int
    expires_at: int

    def is_expired(self, now: int) -> bool:
        """Whether this lock is free to take. Same rule as the conditional write: `expires_at < now`, in whole seconds."""
        return self.expires_at < now

    @classmethod
    def from_item(cls, item: dict[str, Any]) -> "Lock":
        """Build a lock from a DynamoDB item."""
        return cls(
            holder_type=item.get("holder_type", "ci"),
            holder_key=item["holder_key"],
            actor=item.get("actor", "unknown"),
            repo=item.get("repo"),
            ref=item.get("ref"),
            reason=item.get("reason"),
            started_at=int(item.get("started_at", 0)),
            expires_at=int(item["expires_at"]),
        )


class LockStore:
    """All DynamoDB access for the dev lock.

    Lock expiry is decided here, in the conditions of the writes (`expires_at < now`), never by DynamoDB TTL:
    TTL deletes lazily, up to about 48 hours late.
    """

    def __init__(self, table: Any, *, clock: Callable[[], float]) -> None:  # boto3 Table resource has no public type
        self.table = table
        self.clock = clock

    def now(self) -> int:
        """Return the current time in whole seconds. Every expiry decision uses this, so the store and the runner cannot disagree."""
        return int(self.clock())

    # --- config -----------------------------------------------------------------------------------------------------

    def get_mode(self) -> str | None:
        """Return the runtime mode string, or None when CONFIG/mode has never been written."""
        item = self.table.get_item(Key=CONFIG_KEY, ConsistentRead=True).get("Item")
        return item.get("value") if item else None

    # --- the lock ---------------------------------------------------------------------------------------------------

    def get_lock(self) -> Lock | None:
        """Return the current lock (expired or not), or None when nothing is held."""
        item = self.table.get_item(Key=LOCK_KEY, ConsistentRead=True).get("Item")
        return Lock.from_item(item) if item else None

    def put_if_free(self, settings: Settings) -> bool:
        """Take the lock if nobody holds it or the holder's lock has expired. A fresh start: new `started_at`, only this run."""
        now = self.now()
        item = {
            **LOCK_KEY,
            "holder_type": "ci",
            "holder_key": settings.holder_key,
            "run_ids": {settings.run_token},
            "repo": settings.repo,
            "actor": settings.actor,
            "ref": settings.ref,
            "started_at": now,
            "expires_at": now + settings.ttl_seconds,
        }
        if settings.pr_url:
            item["pr_url"] = settings.pr_url
        try:
            self.table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(pk) OR expires_at < :now",
                ExpressionAttributeValues={":now": now},
            )
        except ClientError as error:
            if _is_condition_failure(error):
                return False
            raise
        return True

    def join_if_mine(self, settings: Settings) -> bool:
        """Add this run to a lock its own holder already has (and push the expiry out)."""
        now = self.now()
        try:
            self.table.update_item(
                Key=LOCK_KEY,
                UpdateExpression="ADD run_ids :run SET expires_at = :expires",
                ConditionExpression="holder_key = :me AND expires_at >= :now",
                ExpressionAttributeValues={
                    ":run": {settings.run_token},
                    ":expires": now + settings.ttl_seconds,
                    ":me": settings.holder_key,
                    ":now": now,
                },
            )
        except ClientError as error:
            if _is_condition_failure(error):
                return False
            raise
        return True

    def release(self, settings: Settings) -> bool:
        """Remove this run from its holder's lock; free the lock when the holder has no runs left. Idempotent.

        Returns whether this run was actually holding the lock.
        """
        try:
            response = self.table.update_item(
                Key=LOCK_KEY,
                UpdateExpression="DELETE run_ids :run",
                ConditionExpression="holder_key = :me",
                ExpressionAttributeValues={":run": {settings.run_token}, ":me": settings.holder_key},
                ReturnValues="ALL_OLD",
            )
        except ClientError as error:
            if _is_condition_failure(error):
                return False  # not the holder, or nothing held
            raise
        runs_before = set(response["Attributes"].get("run_ids", ()))
        if runs_before - {settings.run_token}:
            return settings.run_token in runs_before
        try:
            # If a sibling run of this holder joined in between, run_ids is back and the lock correctly stays.
            self.table.delete_item(
                Key=LOCK_KEY,
                ConditionExpression="holder_key = :me AND (attribute_not_exists(run_ids) OR size(run_ids) = :zero)",
                ExpressionAttributeValues={":me": settings.holder_key, ":zero": 0},
            )
        except ClientError as error:
            if not _is_condition_failure(error):
                raise
        return settings.run_token in runs_before

    def mark_preempted(self, holder_key: str, by: str) -> None:
        """Tell a manual holder (via the Slack Lambda) that a merge to main deployed over their hold."""
        try:
            self.table.update_item(
                Key=LOCK_KEY,
                UpdateExpression="SET preempted_by = :by, preempted_at = :now",
                ConditionExpression="holder_key = :hk",
                ExpressionAttributeValues={":by": by, ":now": self.now(), ":hk": holder_key},
            )
        except ClientError as error:
            if not _is_condition_failure(error):
                raise

    # --- the queue --------------------------------------------------------------------------------------------------

    def _queue(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "pk = :pk",
            "ExpressionAttributeValues": {":pk": QUEUE_PK},
            "ConsistentRead": True,
        }
        while True:
            page = self.table.query(**kwargs)
            items.extend(page["Items"])
            if "LastEvaluatedKey" not in page:
                return sorted(items, key=lambda item: item["sk"])
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def _live_queue(self) -> list[dict[str, Any]]:
        """Queue entries that still count: not expired, and for a polling job, still being refreshed."""
        now = self.now()
        return [item for item in self._queue() if _is_live(item, now)]

    def enqueue(self, settings: Settings, kind: str) -> int:
        """Add this holder to the queue, or refresh its entry. Returns its 1-based position.

        `notify`: a failed deploy asking to be pinged when dev is free (kept until it gets the lock or leaves).
        `poll`: a deploy that is waiting in its job (removed when it stops waiting).
        """
        now = self.now()
        mine = [item for item in self._live_queue() if item["holder_key"] == settings.holder_key]
        if mine:
            self.table.update_item(
                Key={"pk": QUEUE_PK, "sk": mine[0]["sk"]},
                UpdateExpression="SET kind = :kind, heartbeat_at = :now, run_url = :run_url, #ttl = :ttl",
                ExpressionAttributeNames={"#ttl": "ttl"},
                ExpressionAttributeValues={
                    ":kind": kind,
                    ":now": now,
                    ":run_url": settings.run_url,
                    ":ttl": now + QUEUE_ENTRY_TTL_SECONDS,
                },
            )
        else:
            item = {
                "pk": QUEUE_PK,
                "sk": f"{int(self.clock() * 1000):013d}#{settings.holder_key}",
                "kind": kind,
                "holder_key": settings.holder_key,
                "repo": settings.repo,
                "actor": settings.actor,
                "ref": settings.ref,
                "run_url": settings.run_url,
                "enqueued_at": now,
                "heartbeat_at": now,
                "ttl": now + QUEUE_ENTRY_TTL_SECONDS,
            }
            if settings.pr_url:
                item["pr_url"] = settings.pr_url
            self.table.put_item(Item=item)
        holders = [item["holder_key"] for item in self._live_queue()]
        return holders.index(settings.holder_key) + 1

    def remove_queue_entries(self, holder_key: str, kinds: tuple[str, ...] = ("notify", "poll")) -> None:
        """Remove a holder's queue entries of the given kinds."""
        for item in self._queue():
            if item["holder_key"] == holder_key and item.get("kind") in kinds:
                self.table.delete_item(Key={"pk": QUEUE_PK, "sk": item["sk"]})
