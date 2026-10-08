import threading

import boto3
from dev_lock.config import Settings
from dev_lock.github import Output
from dev_lock.runner import acquire
from dev_lock.store import LockStore
from dev_lock_support import TABLE_NAME, FakeClock, current_lock, github_env, set_mode


class AtomicCalls:
    """Make every single table call atomic, the way DynamoDB does, while threads still interleave between calls.

    moto's in-memory backend is not thread-safe: with plain boto3 calls and none of this code, a conditional put can
    be granted twice when failed conditional updates and reads run alongside it (about 1 round in 600 under CPU load),
    and a query can crash with "dictionary changed size during iteration". Real DynamoDB makes each conditional
    write atomic, so the emulation here is what the lock's correctness is built on, not a loophole in the test.
    """

    def __init__(self, table, lock: threading.Lock) -> None:
        self._table = table
        self._lock = lock

    def __getattr__(self, name):
        attribute = getattr(self._table, name)
        if not callable(attribute):
            return attribute

        def atomic(*args, **kwargs):
            with self._lock:
                return attribute(*args, **kwargs)

        return atomic


def test_only_one_of_many_simultaneous_deploys_takes_the_lock(table):
    set_mode(table, "enforce")
    contenders = 12
    barrier = threading.Barrier(contenders)
    dynamodb_call = threading.Lock()
    results: dict[str, tuple[int, str]] = {}

    def contend(actor: str) -> None:
        # boto3 resources are not thread-safe, so every contender gets its own.
        own_table = AtomicCalls(boto3.resource("dynamodb", region_name="us-east-1").Table(TABLE_NAME), dynamodb_call)
        clock = FakeClock()
        out = Output(echo=False)
        settings = Settings.from_env(github_env(GITHUB_ACTOR=actor))
        store = LockStore(own_table, clock=clock.now)
        barrier.wait()
        results[actor] = (acquire(settings, store, clock, out), out.outputs["acquired"])

    threads = [threading.Thread(target=contend, args=(f"user{i}",)) for i in range(contenders)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == contenders
    holders = [actor for actor, (_, acquired) in results.items() if acquired == "true"]
    assert len(holders) == 1
    # Everyone else was told to stop: nobody is left believing they have the lock.
    assert sorted(code for code, _ in results.values()) == [0] + [1] * (contenders - 1)
    assert current_lock(table)["actor"] == holders[0]
