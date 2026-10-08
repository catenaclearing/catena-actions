import json

import pytest
from dev_lock.config import Settings
from dev_lock_support import github_env, main_push_env


def test_ci_holder_is_repo_actor_and_ref():
    settings = Settings.from_env(github_env())
    assert settings.holder_key == "ci#catenaclearing/telematics-data-service#alice#refs/pull/42/merge"


def test_runs_of_one_pr_share_a_holder_but_have_their_own_token():
    """Two platform modules deployed by one PR are two workflow runs: same holder, different token."""
    first = Settings.from_env(github_env(GITHUB_RUN_ID="1001"))
    second = Settings.from_env(github_env(GITHUB_RUN_ID="1002"))
    assert first.holder_key == second.holder_key
    assert first.run_token != second.run_token


def test_rerun_attempt_and_job_change_the_token():
    base = Settings.from_env(github_env())
    assert base.run_token == "1001-1-deploy-development"
    assert Settings.from_env(github_env(GITHUB_RUN_ATTEMPT="2")).run_token != base.run_token
    assert Settings.from_env(github_env(GITHUB_JOB="other-job")).run_token != base.run_token


def test_different_actor_or_ref_is_a_different_holder():
    base = Settings.from_env(github_env())
    assert Settings.from_env(github_env(GITHUB_ACTOR="bob")).holder_key != base.holder_key
    assert Settings.from_env(github_env(GITHUB_REF="refs/pull/43/merge")).holder_key != base.holder_key


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (github_env(), False),
        (main_push_env(), True),
        (github_env(GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/feature"), False),
        (github_env(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/main"), False),
    ],
)
def test_only_a_push_to_main_counts_as_a_merge_to_main(env, expected):
    assert Settings.from_env(env).is_main_push is expected


def test_defaults_match_the_agreed_policy():
    settings = Settings.from_env(github_env())
    assert settings.table_name == "catena-dev-lock"
    assert settings.ttl_seconds == 60 * 60
    assert settings.wait_seconds == 30 * 60
    assert settings.poll_seconds == 15


def test_inputs_override_defaults():
    env = github_env(
        INPUT_TABLE_NAME="t", INPUT_TTL_MINUTES="5", INPUT_WAIT_MINUTES="2", INPUT_POLL_SECONDS="3", INPUT_AWS_REGION="eu-west-1"
    )
    settings = Settings.from_env(env)
    assert (settings.table_name, settings.ttl_seconds, settings.wait_seconds, settings.poll_seconds, settings.region) == (
        "t",
        300,
        120,
        3,
        "eu-west-1",
    )


def test_blank_inputs_fall_back_to_defaults():
    """GitHub passes an empty string for an input that is declared but unset."""
    settings = Settings.from_env(github_env(INPUT_TABLE_NAME="", INPUT_TTL_MINUTES=""))
    assert (settings.table_name, settings.ttl_seconds) == ("catena-dev-lock", 3600)


def test_pr_url_comes_from_the_event_payload(tmp_path):
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"pull_request": {"html_url": "https://github.com/o/r/pull/42"}}))
    assert Settings.from_env(github_env(GITHUB_EVENT_PATH=str(event))).pr_url == "https://github.com/o/r/pull/42"


def test_pr_url_is_absent_without_a_payload():
    assert Settings.from_env(github_env()).pr_url is None
    assert Settings.from_env(github_env(GITHUB_EVENT_PATH="/does/not/exist.json")).pr_url is None


def test_run_url_is_built_from_the_environment():
    assert Settings.from_env(github_env()).run_url == "https://github.com/catenaclearing/telematics-data-service/actions/runs/1001"
