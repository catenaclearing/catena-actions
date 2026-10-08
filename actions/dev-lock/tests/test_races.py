"""The timing-sensitive paths: another run changing the lock between two of our calls."""

import dev_lock.runner as runner_module
import pytest
from dev_lock.runner import acquire, main, release
from dev_lock.store import LockStore
from dev_lock_support import START, current_lock, github_env, hold_as_ci, queue_items, set_mode


class FlakyStore(LockStore):
    """Loses the first write because 'someone else' held the lock at that instant, then finds it freed."""

    def __init__(self, *args, lose: int, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.lose = lose

    def put_if_free(self, settings) -> bool:
        if self.lose > 0:
            self.lose -= 1
            return False
        return super().put_if_free(settings)


def test_a_lock_freed_between_the_write_and_the_read_is_just_retried(table, clock, out):
    set_mode(table, "enforce")
    settings = runner_module.Settings.from_env(github_env())
    store = FlakyStore(table, clock=clock.now, lose=1)

    assert acquire(settings, store, clock, out) == 0

    assert current_lock(table)["holder_key"] == settings.holder_key
    assert out.outputs["acquired"] == "true"


def test_a_lock_that_keeps_changing_gives_up_rather_than_spinning(table, clock, out):
    set_mode(table, "enforce")
    settings = runner_module.Settings.from_env(github_env())
    store = FlakyStore(table, clock=clock.now, lose=10_000)

    with pytest.raises(RuntimeError, match="kept changing"):
        acquire(settings, store, clock, out)


def test_giving_up_on_a_changing_lock_fails_open(table, clock, out, monkeypatch):
    set_mode(table, "enforce")
    monkeypatch.setattr(runner_module, "LockStore", lambda tbl, clock: FlakyStore(tbl, clock=clock, lose=10_000))

    assert main(["acquire"], github_env(), clock=clock, out=out) == 0
    assert "kept changing" in out.messages[0][1]


class JoinsMidRelease:
    """A table that lets a sibling run of the same holder join right after our first release write."""

    def __init__(self, table, sibling_join) -> None:
        self.table = table
        self.sibling_join = sibling_join
        self.done = False

    def __getattr__(self, name):
        return getattr(self.table, name)

    def update_item(self, **kwargs):
        response = self.table.update_item(**kwargs)
        if not self.done and kwargs.get("UpdateExpression") == "DELETE run_ids :run":
            self.done = True
            self.sibling_join()
        return response


def test_the_lock_survives_a_sibling_run_joining_in_the_middle_of_a_release(table, make, clock, out):
    """Release is two writes (drop my run, then delete the empty lock). A join between them must keep the lock."""
    set_mode(table, "enforce")
    first, store = make(github_env(GITHUB_RUN_ID="1001"))
    second, _ = make(github_env(GITHUB_RUN_ID="1002"))
    acquire(first, store, clock, out)

    racing = LockStore(JoinsMidRelease(table, lambda: store.join_if_mine(second)), clock=clock.now)
    release(first, racing, out)

    assert current_lock(table)["run_ids"] == {second.run_token}


class PagedQueue:
    """A table whose queue query returns one item per page, like a big queue would."""

    def __init__(self, table) -> None:
        self.table = table

    def __getattr__(self, name):
        return getattr(self.table, name)

    def query(self, **kwargs):
        start = kwargs.pop("ExclusiveStartKey", None)
        items = self.table.query(**kwargs)["Items"]
        index = 0 if start is None else int(start["index"]) + 1
        page = {"Items": items[index : index + 1]}
        if index + 1 < len(items):
            page["LastEvaluatedKey"] = {"index": index}
        return page


def test_queue_position_counts_entries_beyond_the_first_page(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    for actor in ("carol", "dave", "erin"):
        settings, store = make(github_env(GITHUB_ACTOR=actor))
        acquire(settings, store, clock, out)
        clock.current += 1
    last, _ = make(github_env(GITHUB_ACTOR="frank"))

    acquire(last, LockStore(PagedQueue(table), clock=clock.now), clock, out)

    assert len(queue_items(table)) == 4
    assert "#4" in out.messages[-1][1]


def test_the_queue_entry_records_the_pr_url(table, make, clock, out, tmp_path):
    set_mode(table, "enforce")
    hold_as_ci(table)
    event = tmp_path / "event.json"
    event.write_text('{"pull_request": {"html_url": "https://github.com/o/r/pull/42"}}')
    settings, store = make(github_env(GITHUB_EVENT_PATH=str(event)))

    acquire(settings, store, clock, out)

    assert queue_items(table)[0]["pr_url"] == "https://github.com/o/r/pull/42"


def test_a_waiting_entry_whose_runner_died_stops_counting_towards_the_queue(table, make, clock, out):
    """A polling job refreshes its entry; one that stopped (runner killed) must not hold a place in the queue."""
    set_mode(table, "enforce")
    hold_as_ci(table)
    ghost = "ci#catenaclearing/ghost#dave#refs/heads/main"
    table.put_item(
        Item={
            "pk": "QUEUE#dev",
            "sk": f"{START - 600:013d}#{ghost}",
            "kind": "poll",
            "holder_key": ghost,
            "heartbeat_at": START - 600,  # last seen ten minutes ago
            "ttl": START + 3600,
        },
    )
    settings, store = make()

    acquire(settings, store, clock, out)

    assert "#1" in out.messages[-1][1]


def test_a_waiting_entry_that_is_still_polling_counts(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    waiting = "ci#catenaclearing/other#erin#refs/heads/main"
    table.put_item(
        Item={
            "pk": "QUEUE#dev",
            "sk": f"{START - 20:013d}#{waiting}",
            "kind": "poll",
            "holder_key": waiting,
            "heartbeat_at": START - 20,
            "ttl": START + 3600,
        },
    )
    settings, store = make()

    acquire(settings, store, clock, out)

    assert "#2" in out.messages[-1][1]


def test_a_notify_me_entry_is_not_dropped_for_having_no_heartbeat(table, make, clock, out):
    """Failed deploys do not poll; their entry lives until they get the lock, leave, or it expires."""
    set_mode(table, "enforce")
    hold_as_ci(table)
    first, store = make(github_env(GITHUB_ACTOR="carol"))
    acquire(first, store, clock, out)
    clock.current += 1800
    hold_as_ci(table, expires_at=START + 99999)
    second, _ = make(github_env(GITHUB_ACTOR="dave"))

    acquire(second, store, clock, out)

    assert "#2" in out.messages[-1][1]
