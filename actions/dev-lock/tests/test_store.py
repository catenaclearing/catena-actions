"""Properties of the store that moto cannot show on its own, so the tests look at how it talks to DynamoDB."""

from dev_lock.runner import acquire, release
from dev_lock.store import LockStore
from dev_lock_support import github_env, hold_as_ci, set_mode


class RecordingTable:
    """Passes every call through to the real table and remembers how it was called."""

    def __init__(self, table) -> None:
        self._table = table
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, name):
        attribute = getattr(self._table, name)
        if not callable(attribute):
            return attribute

        def record(*args, **kwargs):
            self.calls.append((name, kwargs))
            return attribute(*args, **kwargs)

        return record


def test_every_read_is_strongly_consistent(table, make, clock, out):
    """A stale read of the lock or the mode would let two deploys believe they are alone. moto ignores this flag."""
    set_mode(table, "enforce")
    hold_as_ci(table)
    recording = RecordingTable(table)
    settings, _ = make()
    store = LockStore(recording, clock=clock.now)

    acquire(settings, store, clock, out)  # blocked: reads the mode, the lock and the queue
    release(settings, store, out)

    reads = [(name, kwargs) for name, kwargs in recording.calls if name in {"get_item", "query"}]
    assert {name for name, _ in reads} == {"get_item", "query"}
    assert all(kwargs.get("ConsistentRead") is True for _, kwargs in reads)


def test_release_reports_true_for_each_run_while_siblings_remain(table, make, clock, out):
    set_mode(table, "enforce")
    first, store = make(github_env(GITHUB_RUN_ID="1001"))
    second, _ = make(github_env(GITHUB_RUN_ID="1002"))
    acquire(first, store, clock, out)
    acquire(second, store, clock, out)

    assert store.release(first) is True  # a sibling is still running, so the lock stays, but this run did hold it
    assert store.release(first) is False  # already gone
    assert store.release(second) is True


def test_release_reports_false_for_a_run_that_is_not_in_its_holders_set(table, make, clock, out):
    """Same holder, different run: it never held a share of the lock."""
    set_mode(table, "enforce")
    holder, store = make(github_env(GITHUB_RUN_ID="1001"))
    other_run, _ = make(github_env(GITHUB_RUN_ID="1002"))
    acquire(holder, store, clock, out)

    assert store.release(other_run) is False
    assert store.release(holder) is True


def test_taking_a_free_lock_is_a_single_write(table, make, clock, out):
    """No second write to confirm or refresh what the first one just did: each extra write is a window for a race."""
    set_mode(table, "enforce")
    recording = RecordingTable(table)
    settings, _ = make()
    store = LockStore(recording, clock=clock.now)

    acquire(settings, store, clock, out)

    assert [name for name, _ in recording.calls if name in {"put_item", "update_item", "delete_item"}] == ["put_item"]
