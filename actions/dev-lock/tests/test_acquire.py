from dev_lock.github import Output
from dev_lock.runner import acquire
from dev_lock_support import START, current_lock, github_env, hold_as_ci, hold_as_manual, main_push_env, queue_items, set_mode


def levels(out) -> list[str]:
    return [level for level, _ in out.messages]


def text(out) -> str:
    return "\n".join(message for _, message in out.messages)


# --- taking a free lock ---------------------------------------------------------------------------------------------


def test_free_lock_is_taken(table, make, clock, out):
    settings, store = make()
    set_mode(table, "enforce")

    assert acquire(settings, store, clock, out) == 0

    lock = current_lock(table)
    assert lock["holder_type"] == "ci"
    assert lock["holder_key"] == settings.holder_key
    assert lock["run_ids"] == {settings.run_token}
    assert (lock["repo"], lock["actor"], lock["ref"]) == ("catenaclearing/telematics-data-service", "alice", "refs/pull/42/merge")
    assert lock["started_at"] == START
    assert lock["expires_at"] == START + 3600
    assert out.outputs["acquired"] == "true"


def test_lock_records_the_pr_url_when_there_is_one(table, make, clock, out, tmp_path):
    event = tmp_path / "event.json"
    event.write_text('{"pull_request": {"html_url": "https://github.com/o/r/pull/42"}}')
    settings, store = make(github_env(GITHUB_EVENT_PATH=str(event)))

    acquire(settings, store, clock, out)

    assert current_lock(table)["pr_url"] == "https://github.com/o/r/pull/42"


def test_two_calls_in_one_run_are_fine_and_refresh_the_expiry(table, make, clock, out):
    """A job can call deploy-cdk more than once; the second call must not block on the first."""
    settings, store = make()
    set_mode(table, "enforce")
    acquire(settings, store, clock, out)
    clock.current += 600

    assert acquire(settings, store, clock, out) == 0

    lock = current_lock(table)
    assert lock["run_ids"] == {settings.run_token}
    assert lock["started_at"] == START
    assert lock["expires_at"] == START + 600 + 3600


def test_runs_started_by_one_pr_share_the_lock(table, make, clock, out):
    """Two platform modules deployed by one PR must not block each other."""
    set_mode(table, "enforce")
    first, store = make(github_env(GITHUB_RUN_ID="1001"))
    second, _ = make(github_env(GITHUB_RUN_ID="1002"))

    assert acquire(first, store, clock, out) == 0
    assert acquire(second, store, clock, out) == 0

    assert current_lock(table)["run_ids"] == {first.run_token, second.run_token}


def test_an_expired_lock_is_taken_over_even_though_the_item_is_still_there(table, make, clock, out):
    """DynamoDB TTL deletes lazily, so expiry has to be decided by the conditional write."""
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START - 1)
    settings, store = make()

    assert acquire(settings, store, clock, out) == 0

    lock = current_lock(table)
    assert lock["holder_key"] == settings.holder_key
    assert lock["started_at"] == START
    assert lock["run_ids"] == {settings.run_token}


def test_a_lock_expiring_this_very_second_is_still_held(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START)
    settings, store = make()

    assert acquire(settings, store, clock, out) == 1


def test_acquiring_clears_my_earlier_notify_me_queue_entry(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    settings, store = make()
    assert acquire(settings, store, clock, out) == 1  # blocked, queued
    assert [item["holder_key"] for item in queue_items(table)] == [settings.holder_key]
    table.delete_item(Key={"pk": "LOCK#dev", "sk": "CURRENT"})  # the holder finishes

    assert acquire(settings, store, clock, out) == 0

    assert queue_items(table) == []


# --- modes ----------------------------------------------------------------------------------------------------------


def test_missing_config_means_report_only(table, make, clock, out):
    hold_as_ci(table)
    settings, store = make()

    assert acquire(settings, store, clock, out) == 0
    assert "warning" in levels(out)
    assert queue_items(table) == []


def test_report_only_never_blocks_and_leaves_the_lock_alone(table, make, clock, out):
    set_mode(table, "report-only")
    key = hold_as_ci(table)
    settings, store = make()

    assert acquire(settings, store, clock, out) == 0

    assert current_lock(table)["holder_key"] == key
    assert queue_items(table) == []
    assert "report-only" in text(out)
    assert out.outputs["acquired"] == "false"


def test_off_does_not_touch_the_lock_at_all(table, make, clock, out):
    set_mode(table, "off")
    settings, store = make()

    assert acquire(settings, store, clock, out) == 0

    assert current_lock(table) is None
    assert queue_items(table) == []
    assert out.outputs["acquired"] == "false"


def test_an_unknown_mode_value_never_enforces(table, make, clock, out):
    set_mode(table, "ENFORCE ")
    hold_as_ci(table)
    settings, store = make()

    assert acquire(settings, store, clock, out) == 0


# --- PR-label deploys fail fast -------------------------------------------------------------------------------------


def test_pr_deploy_fails_fast_when_ci_holds_the_lock(table, make, clock, out):
    set_mode(table, "enforce")
    key = hold_as_ci(table, actor="bob")
    settings, store = make()

    assert acquire(settings, store, clock, out) == 1

    assert current_lock(table)["holder_key"] == key  # the holder is unaffected
    message = text(out)
    assert "bob" in message
    assert "catena-platform" in message
    assert "#1" in message  # queue position
    assert levels(out)[-1] == "error"
    assert out.outputs["acquired"] == "false"


def test_pr_deploy_fails_fast_when_a_manual_hold_exists(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_manual(table)

    settings, store = make()

    assert acquire(settings, store, clock, out) == 1
    assert "U123" in text(out)


def test_blocked_deploy_is_queued_once_even_if_retried(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    settings, store = make()

    acquire(settings, store, clock, out)
    clock.current += 60
    acquire(settings, store, clock, out)

    items = queue_items(table)
    assert len(items) == 1
    assert items[0]["kind"] == "notify"
    assert items[0]["holder_key"] == settings.holder_key
    assert items[0]["run_url"] == settings.run_url


def test_queue_position_follows_arrival_order(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    first, store = make(github_env(GITHUB_ACTOR="carol"))
    second, _ = make(github_env(GITHUB_ACTOR="dave"))

    acquire(first, store, clock, out)
    clock.current += 5
    out2 = type(out)(echo=False)
    acquire(second, store, clock, out2)

    assert "#1" in text(out)
    assert "#2" in text(out2)


def test_expired_queue_entries_do_not_count_towards_the_position(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    table.put_item(
        Item={"pk": "QUEUE#dev", "sk": f"{START - 99999:013d}#ci#x#y#z", "kind": "notify", "holder_key": "ci#x#y#z", "ttl": START - 1},
    )
    settings, store = make()

    acquire(settings, store, clock, out)

    assert "#1" in text(out)


# --- merge to main --------------------------------------------------------------------------------------------------


def test_merge_to_main_waits_for_a_ci_deploy_then_takes_the_lock(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START + 100)
    settings, store = make(main_push_env())

    assert acquire(settings, store, clock, out) == 0  # waits ~100s for the other lock to expire

    assert clock.slept
    assert all(seconds == 15 for seconds in clock.slept)
    assert sum(clock.slept) >= 100
    assert current_lock(table)["holder_key"] == settings.holder_key
    assert queue_items(table) == []  # no longer waiting


def test_merge_to_main_gives_up_after_the_wait_limit_and_fails_the_job(table, make, clock, out):
    set_mode(table, "enforce")
    key = hold_as_ci(table, expires_at=START + 99999)
    settings, store = make(main_push_env())

    assert acquire(settings, store, clock, out) == 1

    assert sum(clock.slept) >= settings.wait_seconds
    assert current_lock(table)["holder_key"] == key
    assert levels(out)[-1] == "error"
    assert queue_items(table) == []  # a waiting entry is not left behind


def test_merge_to_main_waits_in_the_queue_while_it_polls(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START + 100)
    settings, store = make(main_push_env())
    seen: list[list[str]] = []
    original_sleep = clock.sleep

    def spy(seconds):
        seen.append([item["kind"] for item in queue_items(table)])
        original_sleep(seconds)

    clock.sleep = spy
    acquire(settings, store, clock, out)

    assert seen
    assert all(kinds == ["poll"] for kinds in seen)


def test_merge_to_main_goes_ahead_over_a_manual_hold_and_tells_the_holder(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_manual(table)
    settings, store = make(main_push_env())

    assert acquire(settings, store, clock, out) == 0

    lock = current_lock(table)
    assert lock["holder_key"] == "manual#U123"  # the hold stays
    assert lock["preempted_by"] == settings.run_url
    assert clock.slept == []  # did not wait
    assert "warning" in levels(out)
    assert out.outputs["acquired"] == "false"


def test_merge_to_main_notices_a_manual_hold_that_appears_while_it_waits(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START + 100)
    settings, store = make(main_push_env())
    original_sleep = clock.sleep

    def swap_holder(seconds):
        original_sleep(seconds)
        if len(clock.slept) == 1:
            hold_as_manual(table)

    clock.sleep = swap_holder

    assert acquire(settings, store, clock, out) == 0
    assert current_lock(table)["holder_key"] == "manual#U123"
    assert len(clock.slept) == 1


# --- the step output and messages -----------------------------------------------------------------------------------


def test_waiting_writes_the_step_output_once_not_on_every_poll(table, make, clock, tmp_path):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START + 100)
    settings, store = make(main_push_env())
    output_file = tmp_path / "github_output"
    out = Output(echo=False, output_file=str(output_file))

    acquire(settings, store, clock, out)

    assert len(clock.slept) > 3  # it really did poll several times
    assert output_file.read_text() == "acquired=true\nblocked=false\n"


def test_a_lock_about_to_expire_does_not_say_zero_minutes(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START + 40)
    settings, store = make()

    acquire(settings, store, clock, out)

    assert "about 0 min" not in text(out)
    assert "under a minute" in text(out)


# --- the `blocked` output: how a deliberate stop reaches the workflow when the step is continue-on-error -----------


def test_a_blocked_pr_deploy_says_so_in_its_output(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)
    settings, store = make()

    assert acquire(settings, store, clock, out) == 1

    assert out.outputs["blocked"] == "true"


def test_a_merge_to_main_that_gave_up_waiting_says_so_in_its_output(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table, expires_at=START + 99999)
    settings, store = make(main_push_env())

    assert acquire(settings, store, clock, out) == 1

    assert out.outputs["blocked"] == "true"


def test_every_outcome_that_lets_the_deploy_go_ahead_says_not_blocked(table, make, clock, out):
    set_mode(table, "enforce")
    settings, store = make()
    acquire(settings, store, clock, out)
    assert out.outputs["blocked"] == "false"  # took the lock

    set_mode(table, "off")
    other, _ = make(github_env(GITHUB_ACTOR="bob", GITHUB_RUN_ID="1002"))
    out_off = Output(echo=False)
    acquire(other, store, clock, out_off)
    assert out_off.outputs["blocked"] == "false"  # mode off

    set_mode(table, "report-only")
    out_report = Output(echo=False)
    acquire(other, store, clock, out_report)
    assert out_report.outputs["blocked"] == "false"  # report-only, someone else holds it


def test_preempting_a_manual_hold_is_not_a_block(table, make, clock, out):
    set_mode(table, "enforce")
    hold_as_manual(table)
    settings, store = make(main_push_env())

    acquire(settings, store, clock, out)

    assert out.outputs["blocked"] == "false"
