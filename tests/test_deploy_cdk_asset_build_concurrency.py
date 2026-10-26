"""How composite/deploy-cdk passes --asset-build-concurrency to `cdk deploy` (PLAT-543).

The CDK CLI gives --asset-build-concurrency a command-line default of 1, which overrides an "assetBuildConcurrency"
in a repo's cdk.json, so the only way for a repo to build its Docker images in parallel is through this input.
CDK CLIs before 2.1109.0 reject the flag, so it is only passed when a caller asks for more than 1: a repo that keeps
the default, or pins an older cdk_version, runs exactly the deploy command it always did.
"""

import os
import subprocess
from pathlib import Path

import pytest
import yaml


ACTION = yaml.safe_load((Path(__file__).resolve().parent.parent / "composite" / "deploy-cdk" / "action.yaml").read_text())
DEPLOY = next(item for item in ACTION["runs"]["steps"] if item.get("name") == "CDK Deploy")


def run_deploy_step(tmp_path: Path, concurrency: str) -> tuple[int, list[str], str]:
    """Run the step's script against a stand-in npx; returns (exit code, npx arguments, output)."""
    project = tmp_path / "project"
    (project / ".venv" / "bin").mkdir(parents=True)
    (project / ".venv" / "bin" / "activate").write_text("")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args_file = tmp_path / "npx-args"
    npx = bin_dir / "npx"
    npx.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{args_file}"\n')
    npx.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "DIRECTORY": str(project),
        "CDK_VERSION": "latest",
        "STACK_NAME": "Example-Development",
        "THIS_REPO": "catenaclearing/example",
        "EXCLUSIVELY_FLAG": "false",
        "ASSET_BUILD_CONCURRENCY": concurrency,
    }
    # GitHub runs composite `shell: bash` steps as `bash --noprofile --norc -eo pipefail {0}`.
    result = subprocess.run(  # noqa: S603 - runs this repo's own action script
        ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", DEPLOY["run"]],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    args = args_file.read_text().splitlines() if args_file.exists() else []
    return result.returncode, args, result.stdout + result.stderr


def test_the_input_is_optional_and_defaults_to_cdks_own_default():
    """Repos that don't set it keep building one image at a time, exactly as before."""
    assert ACTION["inputs"]["asset_build_concurrency"]["required"] is False
    assert ACTION["inputs"]["asset_build_concurrency"]["default"] == "1"


def test_the_deploy_step_reads_the_input():
    assert DEPLOY["env"]["ASSET_BUILD_CONCURRENCY"] == "${{ inputs.asset_build_concurrency }}"


def test_the_default_leaves_the_deploy_command_unchanged(tmp_path):
    """No flag at all, so a cdk_version pinned before 2.1109.0 (which rejects it) keeps working."""
    code, args, _ = run_deploy_step(tmp_path, "1")
    assert code == 0
    assert args == [
        "-y",
        "aws-cdk@latest",
        "deploy",
        "Example-Development",
        "--force",
        "--tags",
        "catena:managed-by=catenaclearing/example",
    ]


def test_a_higher_value_is_passed_on_the_command_line(tmp_path):
    code, args, _ = run_deploy_step(tmp_path, "4")
    assert code == 0
    assert args[-2:] == ["--asset-build-concurrency", "4"]


@pytest.mark.parametrize("value", ["0", "-2", "four", "4 --hotswap", ""])
def test_anything_but_a_positive_integer_stops_the_deploy(tmp_path, value):
    code, args, output = run_deploy_step(tmp_path, value)
    assert code != 0
    assert args == []  # cdk deploy never ran
    assert "asset_build_concurrency must be a positive integer" in output
