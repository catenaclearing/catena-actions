from dev_lock.runner import acquire, release
from dev_lock_support import START, current_lock, github_env, hold_as_ci, queue_items, set_mode


def test_release_frees_the_lock(table, make, clock, out):
    set_mode(table, "enforce")
    settings, store = make()
    acquire(settings, store, clock, out)

    assert release(settings, store, out) == 0

    assert current_lock(table) is None


def test_release_is_idempotent(table, make, clock, out):
    set_mode(table, "enforce")
    settings, store = make()
    acquire(settings, store, clock, out)

    assert release(settings, store, out) == 0
    assert release(settings, store, out) == 0
    assert current_lock(table) is None


def test_release_when_nothing_is_held_is_a_no_op(table, make, out):
    settings, store = make()

    assert release(settings, store, out) == 0

    assert current_lock(table) is None


def test_release_never_touches_someone_elses_lock(table, make, out):
    key = hold_as_ci(table)
    settings, store = make()

    assert release(settings, store, out) == 0
    assert not store.release(settings)

    lock = current_lock(table)
    assert lock["holder_key"] == key
    assert lock["run_ids"] == {"2002-1-deploy-development"}


def test_the_lock_stays_held_until_the_last_run_of_a_holder_releases(table, make, clock, out):
    set_mode(table, "enforce")
    first, store = make(github_env(GITHUB_RUN_ID="1001"))
    second, _ = make(github_env(GITHUB_RUN_ID="1002"))
    acquire(first, store, clock, out)
    acquire(second, store, clock, out)

    release(first, store, out)
    assert current_lock(table)["run_ids"] == {second.run_token}

    release(second, store, out)
    assert current_lock(table) is None


def test_a_second_release_call_in_the_same_job_is_harmless(table, make, clock, out):
    """deploy-cdk may call the action twice in one job, so the post step runs twice."""
    set_mode(table, "enforce")
    settings, store = make()
    acquire(settings, store, clock, out)
    acquire(settings, store, clock, out)

    release(settings, store, out)
    release(settings, store, out)

    assert current_lock(table) is None


def test_release_removes_a_waiting_entry_but_keeps_the_notify_me_entry(table, make, clock, out):
    """A blocked PR deploy fails, then its post step runs; it must still be in the queue to be pinged."""
    set_mode(table, "enforce")
    hold_as_ci(table)
    settings, store = make()
    acquire(settings, store, clock, out)  # blocked: notify entry
    table.put_item(
        Item={
            "pk": "QUEUE#dev",
            "sk": f"{START + 1:013d}#{settings.holder_key}",
            "kind": "poll",
            "holder_key": settings.holder_key,
            "ttl": START + 999,
        },
    )

    release(settings, store, out)

    assert [item["kind"] for item in queue_items(table)] == ["notify"]


def test_release_does_not_remove_other_peoples_queue_entries(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    waiting, store = make(github_env(GITHUB_ACTOR="carol"))
    acquire(waiting, store, clock, out)
    mine, _ = make()
    release(mine, store, out)

    assert len(queue_items(table)) == 1


def test_a_run_that_never_held_the_lock_does_not_claim_to_release_it(table, make, clock, out):
    """A blocked deploy's post step also runs; its log must not say it released a lock it never had."""
    set_mode(table, "enforce")
    hold_as_ci(table)
    settings, store = make()
    acquire(settings, store, clock, out)
    out.messages.clear()

    release(settings, store, out)

    assert not [message for _, message in out.messages if "Released" in message]


def test_a_run_that_held_the_lock_says_so_when_it_releases(table, make, clock, out):
    set_mode(table, "enforce")
    settings, store = make()
    acquire(settings, store, clock, out)
    out.messages.clear()

    release(settings, store, out)

    assert [message for _, message in out.messages if "Released" in message]


def test_store_release_reports_whether_this_run_held_the_lock(table, make, clock, out):
    set_mode(table, "enforce")
    settings, store = make()
    acquire(settings, store, clock, out)

    assert store.release(settings) is True
    assert store.release(settings) is False
