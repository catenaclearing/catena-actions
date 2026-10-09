import os
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

import boto3
from botocore.config import Config

from dev_lock.config import Settings
from dev_lock.github import Output
from dev_lock.policy import Decision, Mode, decide, parse_mode
from dev_lock.store import Lock, LockStore


MAX_RACE_RETRIES = 5


class Clock(Protocol):
    """Time, injectable so tests can move it without sleeping."""

    def now(self) -> float:
        """Return the current time in epoch seconds."""
        ...

    def sleep(self, seconds: float) -> None:
        """Wait for this many seconds."""
        ...


class SystemClock:
    """The real clock."""

    def now(self) -> float:
        """Return the current time in epoch seconds."""
        return time.time()

    def sleep(self, seconds: float) -> None:
        """Wait for this many seconds."""
        time.sleep(seconds)


def _holder_label(lock: Lock) -> str:
    if lock.holder_type == "manual":
        reason = f" ({lock.reason})" if lock.reason else ""
        return f"a manual hold by {lock.actor}{reason}"
    return f"{lock.actor}'s deploy of {lock.repo} ({lock.ref})"


def _timing(lock: Lock, now: float) -> str:
    since = datetime.fromtimestamp(lock.started_at, UTC).strftime("%H:%M UTC")
    minutes = max(0, int((lock.expires_at - now) // 60))
    expires = f"about {minutes} min" if minutes else "under a minute"
    return f"since {since}, expires in {expires}"


def _try_take(settings: Settings, store: LockStore) -> bool:
    return store.put_if_free(settings) or store.join_if_mine(settings)


@dataclass
class _Wait:
    """When a merge to main started waiting for the lock."""

    since: float | None = None


def _took_lock(settings: Settings, store: LockStore, out: Output, mode: Mode) -> int:
    store.remove_queue_entries(settings.holder_key)
    out.set_output("acquired", "true")
    out.set_output("blocked", "false")
    out.notice(f"Holding the dev lock for {settings.holder_key} (mode: {mode.value}).")
    return 0


def _held_by_someone_else(
    settings: Settings,
    store: LockStore,
    clock: Clock,
    out: Output,
    mode: Mode,
    lock: Lock,
    wait: _Wait,
) -> int | None:
    """Act on a live lock held by someone else. Returns the exit code, or None to keep waiting."""
    decision = decide(mode, lock.holder_type, is_main_push=settings.is_main_push)
    holder = f"{_holder_label(lock)}, {_timing(lock, clock.now())}"

    if decision is Decision.CONTINUE:
        out.warning(f"Dev is held by {holder}. dev-lock is in report-only mode, so this deploy would have been blocked; continuing.")
        return 0

    if decision is Decision.PREEMPT:
        store.mark_preempted(lock.holder_key, settings.run_url)
        store.remove_queue_entries(settings.holder_key, ("poll",))
        out.warning(
            f"Dev is held by {holder}. A merge to main must not be stalled by a manual hold (production waits on this deploy), "
            f"so it is going ahead; {lock.actor} has been told.",
        )
        return 0

    if decision is Decision.BLOCK:
        position = store.enqueue(settings, "notify")
        out.error(
            f"Dev is locked by {holder}. You are #{position} in the queue; the #dev-deploys bot will ping you when it is your turn. "
            "Re-run this job once dev is free.",
        )
        return 1

    # Decision.WAIT: a merge to main waits for the CI deploy ahead of it.
    position = store.enqueue(settings, "poll")
    if wait.since is None:
        wait.since = clock.now()
        out.notice(f"Dev is locked by {holder}. Waiting up to {settings.wait_seconds // 60} min (queue position #{position}).")
    if clock.now() - wait.since < settings.wait_seconds:
        return None
    store.remove_queue_entries(settings.holder_key, ("poll",))
    out.error(
        f"Gave up after {settings.wait_seconds // 60} min: dev is still locked by {holder}. "
        "Production waits on this job, so re-run it once dev is free.",
    )
    return 1


def acquire(settings: Settings, store: LockStore, clock: Clock, out: Output) -> int:
    """Take the dev lock for this run. Returns 1 only when the deploy must stop; every other outcome is 0."""
    mode = parse_mode(store.get_mode())
    if mode is Mode.OFF:
        out.notice("dev-lock is off (table CONFIG/mode); deploying without the lock.")
        out.set_output("acquired", "false")
        out.set_output("blocked", "false")
        return 0

    wait = _Wait()
    races = 0
    while True:
        if _try_take(settings, store):
            return _took_lock(settings, store, out, mode)

        lock = store.get_lock()
        if lock is None or lock.is_expired(store.now()):
            # Freed or expired between our write and our read: someone else may be racing us, so just try again.
            races += 1
            if races > MAX_RACE_RETRIES:
                msg = "the dev lock kept changing while trying to take it"
                raise RuntimeError(msg)
            continue

        exit_code = _held_by_someone_else(settings, store, clock, out, mode, lock, wait)
        if exit_code is not None:
            out.set_output("acquired", "false")
            out.set_output("blocked", "true" if exit_code else "false")
            return exit_code
        clock.sleep(settings.poll_seconds)


def release(settings: Settings, store: LockStore, out: Output) -> int:
    """Give this run's share of the lock back. Safe to call any number of times, and never fails the job."""
    held = store.release(settings)
    # A blocked deploy's `notify` entry stays: it is how that deployer gets pinged when dev is free.
    store.remove_queue_entries(settings.holder_key, ("poll",))
    if held:
        out.notice(f"Released the dev lock for run {settings.run_token}.")
    return 0


def _dynamodb_table(settings: Settings) -> Any:
    config = Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 3, "mode": "standard"})
    return boto3.resource("dynamodb", region_name=settings.region, config=config).Table(settings.table_name)


def main(
    argv: Sequence[str],
    env: Mapping[str, str] | None = None,
    *,
    table_factory: Callable[[Settings], Any] | None = None,
    clock: Clock | None = None,
    out: Output | None = None,
) -> int:
    """Run `acquire` or `release`. Fails open: only a deliberate block (1) or a wiring bug (2) is a non-zero exit."""
    env = os.environ if env is None else env
    out = out or Output(output_file=env.get("GITHUB_OUTPUT"))
    command = argv[0] if argv else ""
    if command not in {"acquire", "release"}:
        out.error(f"dev-lock: unknown command {command!r} (expected 'acquire' or 'release'); this is a bug in the action wiring.")
        return 2

    clock = clock or SystemClock()
    try:
        settings = Settings.from_env(env)
        store = LockStore((table_factory or _dynamodb_table)(settings), clock=clock.now)
        return acquire(settings, store, clock, out) if command == "acquire" else release(settings, store, out)
    except Exception as error:  # noqa: BLE001 - fail open by design: the lock is coordination, not a security control
        out.warning(
            f"dev-lock could not use the lock table ({type(error).__name__}: {error}); continuing without the lock. "
            "Concurrent dev deploys are possible until this is fixed.",
        )
        out.debug_traceback()
        out.set_output("acquired", "false")
        out.set_output("blocked", "false")
        return 0
