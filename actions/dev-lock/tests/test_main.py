"""`main` with the real boto3 client (against moto), as the container runs it."""

from dev_lock.runner import main
from dev_lock_support import current_lock, github_env, queue_items, set_mode


def test_acquire_then_release_through_the_real_client(table, out):
    set_mode(table, "enforce")
    env = github_env()

    assert main(["acquire"], env, out=out) == 0
    assert current_lock(table)["actor"] == "alice"
    assert out.outputs["acquired"] == "true"

    assert main(["release"], env, out=out) == 0
    assert current_lock(table) is None


def test_the_table_and_region_come_from_the_action_inputs(table, out):
    """A wrong table name must fail open, proving the input is really used."""
    set_mode(table, "enforce")

    assert main(["acquire"], github_env(INPUT_TABLE_NAME="catena-some-other-table"), out=out) == 0

    assert current_lock(table) is None
    assert "ResourceNotFoundException" in out.messages[0][1]


def test_a_second_deployer_is_blocked_through_the_real_client(table, out):
    set_mode(table, "enforce")
    assert main(["acquire"], github_env(GITHUB_ACTOR="alice"), out=out) == 0

    assert main(["acquire"], github_env(GITHUB_ACTOR="bob", GITHUB_RUN_ID="1002"), out=out) == 1

    assert [item["actor"] for item in queue_items(table)] == ["bob"]
    assert current_lock(table)["actor"] == "alice"
