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
        position("early-guard"),
        position("prebuild"),
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


def test_the_lock_action_is_pinned_to_a_released_commit_that_contains_it():
    """Job setup must not depend on the v0 release workflow racing the first deploy after merge."""
    assert step("dev-lock")["uses"] == "catenaclearing/catena-actions/actions/dev-lock@4b4c87221e8243cc1a57f4de5cca10f4968a317b"


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


# --- building before the lock (PLAT-590) ----------------------------------------------------------------------------

PREBUILD = step("prebuild")
DEPLOY = step("CDK Deploy")


def test_only_deploys_that_take_the_lock_build_before_it_and_the_build_cannot_fail_the_job():
    """Production, management and repos outside dev_lock_repos skip it, and run the single cdk deploy they always did."""
    assert PREBUILD["if"] == "steps.dev-lock-gate.outputs.is_dev_lock == 'true' && steps.early-guard.outcome == 'success'"
    assert PREBUILD["continue-on-error"] is True
    assert PREBUILD["shell"] == "bash"


def test_the_build_gets_what_the_deploy_gets():
    for name in (
        "GITHUB_TOKEN",
        "DOCKER_BUILDKIT",
        "BUILDX_BUILDER",
        "DIRECTORY",
        "CDK_VERSION",
        "STACK_NAME",
        "EXCLUSIVELY_FLAG",
        "ASSET_BUILD_CONCURRENCY",
    ):
        assert PREBUILD["env"][name] == DEPLOY["env"][name], name


def test_the_deploy_reads_the_assembly_only_from_the_build_step():
    assert DEPLOY["env"]["PREBUILT_ASSEMBLY"] == "${{ steps.prebuild.outputs.assembly }}"
    assert "if" not in DEPLOY  # every deploy still deploys


@pytest.fixture(name="fake_npx")
def fake_npx_fixture(tmp_path: Path) -> Path:
    """A stand-in npx: logs each call's arguments on one line, prints FAKE_CDK_VERSION for --version, and fails the
    sub-command named in FAKE_NPX_FAIL."""
    bin_dir = tmp_path / "npx-bin"
    bin_dir.mkdir()
    npx = bin_dir / "npx"
    npx.write_text(
        "#!/bin/bash\n"
        'echo "$*" >> "$NPX_LOG"\n'
        '[ -n "$FAKE_NPX_FAIL" ] && [ "$3" = "$FAKE_NPX_FAIL" ] && { echo "failed" >&2; exit 1; }\n'
        '[ "$3" = "--version" ] && { echo "$FAKE_CDK_VERSION (build abc1234)"; exit 0; }\n'
        "exit 0\n"
    )
    npx.chmod(0o755)
    return bin_dir


def run_composite_step(tmp_path: Path, fake_npx: Path, script: str, **overrides: str) -> tuple[int, list[str], str, str]:
    """Run a step's script the way GitHub does; returns (exit code, npx calls, what it wrote to GITHUB_OUTPUT, log)."""
    project = tmp_path / "project"
    (project / ".venv" / "bin").mkdir(parents=True, exist_ok=True)
    (project / ".venv" / "bin" / "activate").write_text("")
    log = tmp_path / "npx.log"
    log.unlink(missing_ok=True)
    output = tmp_path / "github_output"
    output.unlink(missing_ok=True)
    env = {
        "PATH": f"{fake_npx}{os.pathsep}{os.environ['PATH']}",
        "NPX_LOG": str(log),
        "GITHUB_OUTPUT": str(output),
        "RUNNER_TEMP": str(tmp_path / "runner-temp"),
        "FAKE_CDK_VERSION": "2.1147.0",
        "DIRECTORY": str(project),
        "CDK_VERSION": "latest",
        "STACK_NAME": "Example-Development",
        "THIS_REPO": "catenaclearing/example",
        "EXCLUSIVELY_FLAG": "false",
        "ASSET_BUILD_CONCURRENCY": "1",
        "PREBUILT_ASSEMBLY": "",
        **overrides,
    }
    # GitHub runs composite `shell: bash` steps as `bash --noprofile --norc -eo pipefail {0}`.
    result = subprocess.run(  # noqa: S603 - runs this repo's own action script
        ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    calls = log.read_text().splitlines() if log.exists() else []
    written = output.read_text() if output.exists() else ""
    return result.returncode, calls, written, result.stdout + result.stderr


def test_the_build_synthesizes_then_publishes_only_this_stacks_assets(tmp_path, fake_npx):
    code, calls, written, _ = run_composite_step(tmp_path, fake_npx, PREBUILD["run"])
    assembly = written.removeprefix("assembly=").strip()
    assert code == 0
    assert Path(assembly).parent == tmp_path / "runner-temp"
    assert Path(assembly).name.startswith("deploy-cdk-assembly.")
    assert Path(assembly).is_dir()
    assert calls == [
        "-y aws-cdk@latest --version",
        f"-y aws-cdk@2.1147.0 synth Example-Development --quiet --output {assembly}",
        f"-y aws-cdk@2.1147.0 publish-assets Example-Development --app {assembly} --unstable=publish-assets --concurrency 1",
    ]
    assert written == f"assembly={assembly}\n"


def test_the_build_honours_exclusively_and_the_build_concurrency(tmp_path, fake_npx):
    code, calls, _, _ = run_composite_step(tmp_path, fake_npx, PREBUILD["run"], EXCLUSIVELY_FLAG="true", ASSET_BUILD_CONCURRENCY="4")
    assert code == 0
    assert " synth Example-Development --exclusively --quiet " in calls[1]
    assert " publish-assets Example-Development --exclusively --app " in calls[2]
    assert calls[2].endswith("--concurrency 4")


@pytest.mark.parametrize("version", ["2.1115.0", "2.1109.0", "2.150.0"])
def test_a_cdk_cli_without_publish_assets_builds_after_the_lock_as_before(tmp_path, fake_npx, version):
    code, calls, written, log = run_composite_step(tmp_path, fake_npx, PREBUILD["run"], FAKE_CDK_VERSION=version)
    assert code == 0
    assert len(calls) == 1  # only --version
    assert written == ""
    assert "no publish-assets" in log


@pytest.mark.parametrize("failing", ["synth", "publish-assets", "--version"])
def test_a_failed_build_hands_nothing_on(tmp_path, fake_npx, failing):
    """The step is continue-on-error; without an assembly the deploy synthesizes and builds itself, as it always did."""
    code, _, written, _ = run_composite_step(tmp_path, fake_npx, PREBUILD["run"], FAKE_NPX_FAIL=failing)
    assert code != 0
    assert written == ""


@pytest.mark.parametrize("value", ["0", "four", "4 --force", ""])
def test_a_bad_build_concurrency_hands_nothing_on_and_never_builds(tmp_path, fake_npx, value):
    code, calls, written, _ = run_composite_step(tmp_path, fake_npx, PREBUILD["run"], ASSET_BUILD_CONCURRENCY=value)
    assert code != 0
    assert len(calls) == 1
    assert written == ""


def test_the_deploy_deploys_the_prebuilt_assembly_without_force(tmp_path, fake_npx):
    """`cdk deploy --force` rebuilds and re-pushes every asset; without it CDK skips the ones published before the lock.

    It still deploys whenever the template, tags or parameters differ, so the catena:managed-by tag is still stamped.
    """
    code, calls, _, _ = run_composite_step(
        tmp_path,
        fake_npx,
        DEPLOY["run"],
        PREBUILT_ASSEMBLY=f"{tmp_path}/Example-Development.out",
        EXCLUSIVELY_FLAG="true",
        ASSET_BUILD_CONCURRENCY="4",
    )
    assert code == 0
    assert calls == [
        f"-y aws-cdk@latest deploy Example-Development --app {tmp_path}/Example-Development.out "
        "--tags catena:managed-by=catenaclearing/example --exclusively --asset-build-concurrency 4"
    ]


def test_without_an_assembly_the_deploy_command_is_exactly_what_it_was(tmp_path, fake_npx):
    """Production, repos outside dev_lock_repos, an old CDK CLI and a failed build all get this (a skipped step's output is '')."""
    code, calls, _, _ = run_composite_step(tmp_path, fake_npx, DEPLOY["run"])
    assert code == 0
    assert calls == ["-y aws-cdk@latest deploy Example-Development --force --tags catena:managed-by=catenaclearing/example"]


# --- the ownership guard, before building and before deploying ------------------------------------------------------

GUARD_SCRIPT = ACTION_DIR / "stack-ownership-guard.sh"
EARLY_GUARD = step("early-guard")
GUARD = step("Guard against overwriting another service's stack")
GUARD_ENV = {
    "STACK_NAME": "${{ inputs.stack_name }}",
    "THIS_REPO": "${{ github.repository }}",
    "ENFORCE_OWNERSHIP_TAG": "${{ inputs.enforce_ownership_tag }}",
    "ACTION_PATH": "${{ github.action_path }}",
}


def test_nothing_is_published_until_ownership_is_confirmed():
    """Assets for a stack another repo owns must not reach the bootstrap bucket or repositories."""
    assert position("early-guard") < position("prebuild")
    assert "steps.early-guard.outcome == 'success'" in PREBUILD["if"]


def test_the_early_check_only_runs_for_deploys_that_build_first_and_cannot_fail_the_job_itself():
    """When it fails the build is skipped, and the guard before the deploy stops the deploy, as it always did."""
    assert EARLY_GUARD["if"] == "steps.dev-lock-gate.outputs.is_dev_lock == 'true'"
    assert EARLY_GUARD["continue-on-error"] is True
    assert EARLY_GUARD["run"] == GUARD["run"] == '"$ACTION_PATH/stack-ownership-guard.sh"'
    assert EARLY_GUARD["env"] == GUARD["env"] == GUARD_ENV


def test_the_guard_before_the_deploy_still_runs_for_every_deploy_and_stops_it():
    """It also catches a stack that changed owner while a run waited for the lock."""
    assert "if" not in GUARD
    assert "continue-on-error" not in GUARD
    assert position("dev-lock") < position(GUARD["name"]) < position("CDK Deploy")


@pytest.fixture(name="fake_cfn")
def fake_cfn_fixture(tmp_path: Path) -> Path:
    """A stand-in `aws` CLI for describe-stacks: prints FAKE_OWNER, or fails with FAKE_ERROR on stderr."""
    bin_dir = tmp_path / "cfn-bin"
    bin_dir.mkdir()
    aws = bin_dir / "aws"
    aws.write_text('#!/bin/sh\n[ -n "$FAKE_ERROR" ] && { echo "$FAKE_ERROR" >&2; exit 254; }\necho "$FAKE_OWNER"\n')
    aws.chmod(0o755)
    return bin_dir


def run_guard(tmp_path: Path, fake_cfn: Path, **overrides: str) -> tuple[int, str]:
    env = {
        "PATH": f"{fake_cfn}{os.pathsep}{os.environ['PATH']}",
        "RUNNER_TEMP": str(tmp_path),
        "STACK_NAME": "Example-Development",
        "THIS_REPO": "catenaclearing/example",
        "ENFORCE_OWNERSHIP_TAG": "false",
        "FAKE_OWNER": "catenaclearing/example",
        **overrides,
    }
    result = subprocess.run(["/bin/bash", str(GUARD_SCRIPT)], env=env, capture_output=True, text=True, check=False)  # noqa: S603
    return result.returncode, result.stdout + result.stderr


def test_the_guard_lets_this_repos_own_stack_through(tmp_path, fake_cfn):
    assert run_guard(tmp_path, fake_cfn)[0] == 0


def test_the_guard_stops_a_stack_another_repo_owns(tmp_path, fake_cfn):
    code, output = run_guard(tmp_path, fake_cfn, FAKE_OWNER="catenaclearing/someone-else")
    assert code == 1
    assert "managed by 'catenaclearing/someone-else'" in output


def test_the_guard_lets_a_new_stack_through(tmp_path, fake_cfn):
    code, output = run_guard(tmp_path, fake_cfn, FAKE_ERROR="Stack with id Example-Development does not exist")
    assert code == 0
    assert "does not exist yet" in output


@pytest.mark.parametrize(("enforce", "expected"), [("false", 0), ("true", 1)])
def test_the_guard_on_a_legacy_stack_without_the_tag(tmp_path, fake_cfn, enforce, expected):
    assert run_guard(tmp_path, fake_cfn, FAKE_OWNER="None", ENFORCE_OWNERSHIP_TAG=enforce)[0] == expected


def test_the_guard_fails_closed_when_it_cannot_tell(tmp_path, fake_cfn):
    code, output = run_guard(tmp_path, fake_cfn, FAKE_ERROR="An error occurred (AccessDenied)")
    assert code == 1
    assert "refusing to deploy blindly" in output


@pytest.mark.parametrize(
    ("exclusively", "concurrency", "tail"),
    [
        ("false", "1", []),
        ("true", "4", ["--exclusively", "--asset-build-concurrency", "4"]),
    ],
)
def test_only_the_prebuilt_path_leaves_force_out(tmp_path, fake_npx, exclusively, concurrency, tail):
    """Production, repos outside dev_lock_repos, an old CDK CLI and a failed build all deploy with --force, as before."""
    tags = ["--tags", "catena:managed-by=catenaclearing/example"]
    assembly = f"{tmp_path}/Example-Development.out"
    for prebuilt, middle in (("", ["--force"]), (assembly, ["--app", assembly])):
        code, calls, _, _ = run_composite_step(
            tmp_path,
            fake_npx,
            DEPLOY["run"],
            PREBUILT_ASSEMBLY=prebuilt,
            EXCLUSIVELY_FLAG=exclusively,
            ASSET_BUILD_CONCURRENCY=concurrency,
        )
        assert code == 0
        assert calls == [" ".join(["-y", "aws-cdk@latest", "deploy", "Example-Development", *middle, *tags, *tail])]


@pytest.mark.parametrize("stack_name", ["../../outside", "/etc", "Example-Development"])
def test_the_assembly_path_never_comes_from_the_stack_name(tmp_path, fake_npx, stack_name):
    """stack_name is an input: it is only ever the stack argument to CDK, never part of a path that is created or removed."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("")
    code, calls, written, _ = run_composite_step(tmp_path, fake_npx, PREBUILD["run"], STACK_NAME=stack_name)
    assembly = written.removeprefix("assembly=").strip()
    assert code == 0
    assert stack_name not in assembly
    assert Path(assembly).parent == tmp_path / "runner-temp"
    assert (outside / "keep").exists()
    assert f" synth {stack_name} " in calls[1]
    assert f" publish-assets {stack_name} --app {assembly} " in calls[2]


def test_each_build_gets_its_own_assembly_directory(tmp_path, fake_npx):
    """Two deploy-cdk calls in one job (two stacks, or the same one twice) never share or delete each other's assembly."""
    first = run_composite_step(tmp_path, fake_npx, PREBUILD["run"])[2]
    second = run_composite_step(tmp_path, fake_npx, PREBUILD["run"])[2]
    assert first != second
    assert all(Path(text.removeprefix("assembly=").strip()).is_dir() for text in (first, second))
