"""How composite/deploy-cdk takes the dev lock (PLAT-478).

Every repo that deploys with `deploy-cdk@v0` runs these steps, prod and management included, so what matters is that
nothing here can fail a deploy by accident and that only the agreed repos in the dev account ever touch the lock.
"""

import importlib.util
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml


ACTION_DIR = Path(__file__).resolve().parent.parent / "composite" / "deploy-cdk"
GATE_SCRIPT = ACTION_DIR / "dev-lock-gate.sh"


def _catena_cdk_account_ids() -> dict[str, str]:
    """The account IDs in catena_cdk, read from its source: importing it starts a Node runtime (~10 s per process)."""
    spec = importlib.util.find_spec("catena_cdk")
    constants = Path(spec.submodule_search_locations[0]) / "constants.py"
    return dict(re.findall(r'^\s+(DEVELOPMENT|PRODUCTION|MANAGEMENT)\s*=\s*"(\d{12})"', constants.read_text(), re.MULTILINE))


ACCOUNTS = _catena_cdk_account_ids()
assert set(ACCOUNTS) == {"DEVELOPMENT", "PRODUCTION", "MANAGEMENT"}, "could not read the account IDs from catena_cdk"

DEV = ACCOUNTS["DEVELOPMENT"]
PROD = ACCOUNTS["PRODUCTION"]
MANAGEMENT = ACCOUNTS["MANAGEMENT"]

IN_SCOPE = [
    "catenaclearing/catena-platform",
    "catenaclearing/telematics-data-service",
    "catenaclearing/telematics-integrations-service",
    "catenaclearing/telematics-intelligence-service",
    "catenaclearing/telematics-notifications-service",
    "catenaclearing/telematics-organizations-service",
]
REPOS = ",".join(IN_SCOPE)


@pytest.fixture(name="fake_aws")
def fake_aws_fixture(tmp_path: Path) -> Path:
    """A stand-in `aws` CLI on PATH: prints FAKE_AWS_ACCOUNT, or fails when FAKE_AWS_FAIL is set."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    aws = bin_dir / "aws"
    aws.write_text('#!/bin/sh\n[ -n "$FAKE_AWS_FAIL" ] && { echo "boom" >&2; exit 255; }\necho "$FAKE_AWS_ACCOUNT"\n')
    aws.chmod(0o755)
    return bin_dir


def run_gate_logged(tmp_path: Path, fake_aws: Path, **overrides: str | None) -> tuple[int, str | None, str]:
    """Run the gate script; returns (exit code, the value written to is_dev_lock or None, what it printed)."""
    output = tmp_path / "github_output"
    env = {
        "PATH": f"{fake_aws}{os.pathsep}{os.environ['PATH']}",
        "GITHUB_OUTPUT": str(output),
        "GITHUB_REPOSITORY": "catenaclearing/telematics-data-service",
        "DEV_LOCK_REPOS": REPOS,
        "DEV_LOCK_ACCOUNT_ID": DEV,
        "FAKE_AWS_ACCOUNT": DEV,
    }
    env.update({key: value for key, value in overrides.items() if value is not None})
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
    result = subprocess.run(["/bin/bash", str(GATE_SCRIPT)], env=env, capture_output=True, text=True, check=False)  # noqa: S603
    written = output.read_text().strip() if output.exists() else None
    return result.returncode, written.removeprefix("is_dev_lock=") if written else None, result.stdout


def run_gate(tmp_path: Path, fake_aws: Path, **overrides: str | None) -> tuple[int, str | None]:
    """Run the gate script; returns (exit code, the value written to is_dev_lock, or None if nothing was written)."""
    code, value, _ = run_gate_logged(tmp_path, fake_aws, **overrides)
    return code, value


# --- the gate: only in-scope repos in the dev account -------------------------------------------------------------


@pytest.mark.parametrize("repo", IN_SCOPE)
def test_every_in_scope_repo_in_the_dev_account_takes_the_lock(tmp_path, fake_aws, repo):
    assert run_gate(tmp_path, fake_aws, GITHUB_REPOSITORY=repo) == (0, "true")


@pytest.mark.parametrize(
    "repo",
    [
        "catenaclearing/customer-arrive--parking-session-service",
        "catenaclearing/catena-website",
        "catenaclearing/catena-fleet-connect",
        "catenaclearing/batch-ingestion-service",
        "catenaclearing/catena-keycloak-service",
        "catenaclearing/telematics-usage-service",
    ],
)
def test_out_of_scope_repos_never_take_the_lock(tmp_path, fake_aws, repo):
    assert run_gate(tmp_path, fake_aws, GITHUB_REPOSITORY=repo) == (0, "false")


@pytest.mark.parametrize("account", [PROD, MANAGEMENT, "000000000000"], ids=["production", "management", "unknown-account"])
def test_production_and_management_deploys_never_take_the_lock(tmp_path, fake_aws, account):
    """deploy-cdk@v0 also deploys prod and management; those jobs must not touch the lock at all."""
    assert run_gate(tmp_path, fake_aws, FAKE_AWS_ACCOUNT=account) == (0, "false")


@pytest.mark.parametrize(
    "repo",
    [
        "catenaclearing/catena-platform-extra",  # longer name that contains an in-scope name
        "catenaclearing/catena-plat",  # prefix of an in-scope name
        "attacker/catena-platform",  # same repo name, different owner
        "attacker/catenaclearing/catena-platform",
        "catena-platform",
    ],
)
def test_the_repo_has_to_match_an_entry_exactly(tmp_path, fake_aws, repo):
    assert run_gate(tmp_path, fake_aws, GITHUB_REPOSITORY=repo) == (0, "false")


def test_spaces_and_newlines_around_entries_are_ignored(tmp_path, fake_aws):
    messy = " catenaclearing/catena-platform ,\n  catenaclearing/telematics-data-service\n"
    assert run_gate(tmp_path, fake_aws, DEV_LOCK_REPOS=messy) == (0, "true")


# --- the gate says why, so a rename or a typo cannot turn the lock off silently -----------------------------------


def test_the_gate_says_it_is_using_the_lock(tmp_path, fake_aws):
    _, value, log = run_gate_logged(tmp_path, fake_aws)
    assert value == "true"
    assert "dev lock: on" in log
    assert "catenaclearing/telematics-data-service" in log


def test_the_gate_says_when_the_repo_is_not_in_the_list(tmp_path, fake_aws):
    """A renamed repo or a typo in dev_lock_repos would otherwise just stop locking without a trace."""
    _, value, log = run_gate_logged(tmp_path, fake_aws, GITHUB_REPOSITORY="catenaclearing/telematics-data-service-renamed")
    assert value == "false"
    assert "dev lock: off" in log
    assert "catenaclearing/telematics-data-service-renamed is not in dev_lock_repos" in log


def test_the_gate_says_when_it_is_not_the_development_account(tmp_path, fake_aws):
    _, value, log = run_gate_logged(tmp_path, fake_aws, FAKE_AWS_ACCOUNT=PROD)
    assert value == "false"
    assert "dev lock: off" in log
    assert "not the development account" in log


def test_the_gate_says_when_it_cannot_tell_which_account_it_is(tmp_path, fake_aws):
    _, value, log = run_gate_logged(tmp_path, fake_aws, FAKE_AWS_FAIL="1")
    assert value == "false"
    assert "could not tell which AWS account" in log


def test_the_gate_says_when_it_has_been_switched_off_by_a_blank_setting(tmp_path, fake_aws):
    _, value, log = run_gate_logged(tmp_path, fake_aws, DEV_LOCK_REPOS="")
    assert value == "false"
    assert "dev_lock_repos or dev_lock_account_id is blank" in log


def test_a_blank_account_setting_is_never_equal_to_a_failed_account_lookup(tmp_path, fake_aws):
    """If `aws` fails the answer is empty; an empty setting must not be mistaken for a match."""
    for name, answer in {"aws-fails": {"FAKE_AWS_FAIL": "1"}, "aws-answers-nothing": {"FAKE_AWS_ACCOUNT": ""}}.items():
        run_dir = tmp_path / name
        run_dir.mkdir()
        assert run_gate(run_dir, fake_aws, DEV_LOCK_ACCOUNT_ID="", **answer) == (0, "false"), name


def test_a_blank_repository_never_matches_an_empty_entry_in_the_list(tmp_path, fake_aws):
    """`a/b,,c/d` has an empty entry; a blank GITHUB_REPOSITORY must not match it."""
    assert run_gate(tmp_path, fake_aws, GITHUB_REPOSITORY="", DEV_LOCK_REPOS="a/b,,c/d") == (0, "false")


# --- the gate can never fail a deploy ----------------------------------------------------------------------------


def test_a_failing_aws_cli_means_no_lock_and_no_failure(tmp_path, fake_aws):
    assert run_gate(tmp_path, fake_aws, FAKE_AWS_FAIL="1") == (0, "false")


@pytest.mark.parametrize("answer", ["", "None", "not-an-account", "339"], ids=["empty", "none", "garbage", "too-short"])
def test_an_unusable_account_answer_means_no_lock(tmp_path, fake_aws, answer):
    assert run_gate(tmp_path, fake_aws, FAKE_AWS_ACCOUNT=answer) == (0, "false")


@pytest.mark.parametrize("name", ["DEV_LOCK_REPOS", "DEV_LOCK_ACCOUNT_ID"])
def test_a_blank_setting_turns_the_lock_off(tmp_path, fake_aws, name):
    assert run_gate(tmp_path, fake_aws, **{name: ""}) == (0, "false")


def test_a_missing_output_file_does_not_crash_the_gate(tmp_path, fake_aws):
    code, _ = run_gate(tmp_path, fake_aws, GITHUB_OUTPUT=None)
    assert code == 0


# --- the composite: where the steps sit and how they are wired ---------------------------------------------------

ACTION = yaml.safe_load((ACTION_DIR / "action.yaml").read_text())
STEPS = ACTION["runs"]["steps"]


def step(name_or_id: str) -> dict:
    return next(item for item in STEPS if name_or_id in {item.get("id"), item.get("name")})


def position(name_or_id: str) -> int:
    return STEPS.index(step(name_or_id))


def test_the_lock_is_taken_after_credentials_and_before_anything_is_deployed():
    order = [
        position("Configure AWS credentials"),
        position("dev-lock-gate"),
        position("dev-lock"),
        position("dev-lock-blocked"),
        position("Guard against overwriting another service's stack"),
        position("CDK Deploy"),
    ]
    assert order == sorted(order)
    assert len(set(order)) == len(order)


def test_the_gate_cannot_fail_the_job_and_runs_the_script_next_to_the_action():
    gate = step("dev-lock-gate")
    assert gate["continue-on-error"] is True
    assert gate["shell"] == "bash"
    assert '"$ACTION_PATH/dev-lock-gate.sh"' in gate["run"]
    assert gate["env"]["ACTION_PATH"] == "${{ github.action_path }}"
    assert gate["env"]["DEV_LOCK_REPOS"] == "${{ inputs.dev_lock_repos }}"
    assert gate["env"]["DEV_LOCK_ACCOUNT_ID"] == "${{ inputs.dev_lock_account_id }}"


def test_the_lock_step_runs_only_when_the_gate_says_so_and_cannot_fail_the_job_by_itself():
    """An action bug or an unreachable lock store must not stop a deploy; only a deliberate block does, in the next step."""
    lock = step("dev-lock")
    assert lock["if"] == "steps.dev-lock-gate.outputs.is_dev_lock == 'true'"
    assert lock["continue-on-error"] is True
    assert lock["with"]["aws_region"] == "${{ inputs.aws_region }}"


def test_the_lock_action_is_pinned_to_the_floating_v0_not_a_branch():
    """A branch pin is fine for a canary, but merged it would break every deploy once the branch is deleted."""
    assert step("dev-lock")["uses"] == "catenaclearing/catena-actions/actions/dev-lock@v0"


def test_a_deliberate_block_stops_the_deploy_and_nothing_else_does():
    blocked = step("dev-lock-blocked")
    assert blocked["if"] == "steps.dev-lock.outputs.blocked == 'true'"
    assert blocked["shell"] == "bash"
    assert "exit 1" in blocked["run"]
    assert "continue-on-error" not in blocked


def test_the_steps_that_were_already_there_are_unchanged_and_in_order():
    original = [
        "Set Up Environment and load Cached Dependencies",
        "Set up Docker Buildx",
        "Expose GitHub Runtime (for gha cache)",
        "Cache CDK",
        "Setup Node.js",
        "Configure AWS credentials",
        "Guard against overwriting another service's stack",
        "CDK Deploy",
    ]
    names = [item["name"] for item in STEPS if item.get("name") in original]
    assert names == original


def test_the_default_scope_is_exactly_the_agreed_repos():
    assert ACTION["inputs"]["dev_lock_repos"]["default"].replace(" ", "").split(",") == IN_SCOPE
    assert ACTION["inputs"]["dev_lock_repos"]["required"] is False


def test_the_default_dev_account_is_the_real_dev_account():
    default = ACTION["inputs"]["dev_lock_account_id"]["default"]
    assert default == DEV
    assert default not in {PROD, MANAGEMENT}
    assert ACTION["inputs"]["dev_lock_account_id"]["required"] is False


def test_existing_inputs_are_unchanged():
    for name in ("role_to_assume", "aws_region", "stack_name", "machine_user_pat"):
        assert ACTION["inputs"][name]["required"] is True
    assert ACTION["inputs"]["exclusively"]["default"] == "false"
