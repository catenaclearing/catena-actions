"""How composite/deploy-cdk deploys TypeScript CDK apps as well as Python ones (FE-1016).

`language` defaults to "python", which runs exactly the steps it always did. "typescript" swaps the Python environment
for pnpm and Node and installs the caller's workspace instead. The deploy steps then run without a virtual environment,
and export the machine user's token as NODE_AUTH_TOKEN so a Docker image asset can install private @catenaclearing
packages.
"""

import os
import subprocess
from pathlib import Path

import pytest
import yaml


ACTION = yaml.safe_load((Path(__file__).resolve().parent.parent / "composite" / "deploy-cdk" / "action.yaml").read_text())
STEPS = ACTION["runs"]["steps"]


def step(name_or_id: str) -> dict:
    return next(item for item in STEPS if name_or_id in {item.get("id"), item.get("name")})


CHECK = step("Check the language input")
PYTHON_ONLY = [step("Set Up Environment and load Cached Dependencies"), step("Setup Node.js")]
TYPESCRIPT_ONLY = [
    step("Set up pnpm"),
    step("Set up Node.js with pnpm"),
    step("Log in to the GitHub Container registry"),
    step("Configure git PAT to access our private repositories"),
    step("Install Node dependencies"),
]
INSTALL = step("Install Node dependencies")
PREBUILD = step("prebuild")
DEPLOY = step("CDK Deploy")


def run_script(tmp_path: Path, script: str, *, with_venv: bool, **overrides: str) -> tuple[int, list[str], str]:
    """Run a step's script the way GitHub does against stand-in npx and pnpm; returns (exit code, calls, output).

    Each call is logged as "<NODE_AUTH_TOKEN>|<arguments>", so a test can see which token the command ran with.
    """
    project = tmp_path / "project"
    project.mkdir(exist_ok=True)
    if with_venv:
        (project / ".venv" / "bin").mkdir(parents=True, exist_ok=True)
        (project / ".venv" / "bin" / "activate").write_text("")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "calls.log"
    for tool in ("npx", "pnpm"):
        stand_in = bin_dir / tool
        stand_in.write_text(
            "#!/bin/bash\n"
            f'echo "$NODE_AUTH_TOKEN|$*" >> "{log}"\n'
            '[ "$3" = "--version" ] && { echo "2.1147.0 (build abc1234)"; exit 0; }\n'
            "exit 0\n"
        )
        stand_in.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GITHUB_OUTPUT": str(tmp_path / "github_output"),
        "RUNNER_TEMP": str(tmp_path / "runner-temp"),
        "DIRECTORY": str(project),
        "CDK_VERSION": "latest",
        "STACK_NAME": "Example-Development",
        "THIS_REPO": "catenaclearing/example",
        "EXCLUSIVELY_FLAG": "false",
        "ASSET_BUILD_CONCURRENCY": "1",
        "PREBUILT_ASSEMBLY": "",
        "GITHUB_TOKEN": "machine-user-pat",
        **overrides,
    }
    # GitHub runs composite `shell: bash` steps as `bash --noprofile --norc -eo pipefail {0}`.
    result = subprocess.run(  # noqa: S603 - runs this repo's own action script
        ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
        env=env,
        cwd=project,
        capture_output=True,
        text=True,
        check=False,
    )
    calls = log.read_text().splitlines() if log.exists() else []
    return result.returncode, calls, result.stdout + result.stderr


def test_the_input_is_optional_and_defaults_to_python():
    """Callers that don't set it keep the Python deploy they have today."""
    assert ACTION["inputs"]["language"]["required"] is False
    assert ACTION["inputs"]["language"]["default"] == "python"


def test_the_language_is_checked_before_anything_else():
    assert STEPS[0] is CHECK
    assert CHECK["env"]["LANGUAGE"] == "${{ inputs.language }}"


@pytest.mark.parametrize("language", ["python", "typescript"])
def test_both_languages_pass_the_check(tmp_path, language):
    code, _, _ = run_script(tmp_path, CHECK["run"], with_venv=False, LANGUAGE=language)
    assert code == 0


@pytest.mark.parametrize("language", ["", "node", "Python", "typescript ", "python; rm -rf /"])
def test_anything_else_stops_the_deploy_naming_the_accepted_values(tmp_path, language):
    code, _, output = run_script(tmp_path, CHECK["run"], with_venv=False, LANGUAGE=language)
    assert code != 0
    assert "python" in output
    assert "typescript" in output


@pytest.mark.parametrize("item", PYTHON_ONLY, ids=lambda item: item["name"])
def test_python_setup_only_runs_for_python(item):
    assert item["if"] == "inputs.language == 'python'"


@pytest.mark.parametrize("item", TYPESCRIPT_ONLY, ids=lambda item: item["name"])
def test_node_setup_only_runs_for_typescript(item):
    assert item["if"] == "inputs.language == 'typescript'"


def test_pnpm_comes_from_the_callers_package_manager_field():
    assert "version" not in (step("Set up pnpm").get("with") or {})


def test_setup_node_leaves_no_placeholder_token_for_the_rest_of_the_job():
    """registry-url makes setup-node write NODE_AUTH_TOKEN=XXXXX-... to GITHUB_ENV, which beats a caller's job env."""
    node = step("Set up Node.js with pnpm")["with"]
    assert node["cache"] == "pnpm"
    assert node["cache-dependency-path"] == "**/pnpm-lock.yaml"  # not just the root, where setup-node looks by default
    assert "registry-url" not in node


def test_typescript_apps_get_the_same_private_access_as_python_ones():
    """ghcr.io base images and private GitHub dependencies, as setup-python provides."""
    login = step("Log in to the GitHub Container registry")["with"]
    assert login["registry"] == "ghcr.io"
    assert login["password"] == "${{ inputs.machine_user_pat }}"
    git = step("Configure git PAT to access our private repositories")
    assert git["env"]["MACHINE_USER_PAT"] == "${{ inputs.machine_user_pat }}"
    assert "git credential approve" in git["run"]


def test_the_install_runs_in_the_cdk_directory_with_a_step_only_npmrc():
    assert INSTALL["working-directory"] == "${{ inputs.directory }}"
    assert INSTALL["env"]["NODE_AUTH_TOKEN"] == "${{ inputs.machine_user_pat }}"
    assert INSTALL["env"]["NPM_CONFIG_USERCONFIG"] == "${{ runner.temp }}/deploy-cdk.npmrc"


def test_the_install_writes_a_token_reference_and_installs_from_the_lockfile(tmp_path):
    npmrc = tmp_path / "deploy-cdk.npmrc"
    code, calls, output = run_script(
        tmp_path, INSTALL["run"], with_venv=False, NODE_AUTH_TOKEN="machine-user-pat", NPM_CONFIG_USERCONFIG=str(npmrc)
    )
    assert code == 0, output
    assert calls == ["machine-user-pat|install --frozen-lockfile"]
    assert npmrc.read_text().splitlines() == [
        "@catenaclearing:registry=https://npm.pkg.github.com",
        "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}",
    ]


@pytest.mark.parametrize("item", [PREBUILD, DEPLOY], ids=["prebuild", "deploy"])
def test_the_deploy_steps_know_the_language_and_add_no_token_of_their_own(item):
    """The token is exported in the script for TypeScript only, so Python steps see the environment they always did."""
    assert item["env"]["LANGUAGE"] == "${{ inputs.language }}"
    assert "NODE_AUTH_TOKEN" not in item["env"]


@pytest.mark.parametrize("item", [PREBUILD, DEPLOY], ids=["prebuild", "deploy"])
def test_typescript_deploys_run_cdk_without_a_venv_and_with_the_machine_user_token(tmp_path, item):
    code, calls, output = run_script(tmp_path, item["run"], with_venv=False, LANGUAGE="typescript")
    assert code == 0, output
    cdk = [call for call in calls if " deploy " in call or " publish-assets " in call]
    assert cdk
    assert all(call.startswith("machine-user-pat|") for call in cdk)


@pytest.mark.parametrize("item", [PREBUILD, DEPLOY], ids=["prebuild", "deploy"])
def test_python_deploys_still_use_the_venv(tmp_path, item):
    """Without a .venv the step fails before running cdk, which shows it still activates one."""
    code, calls, _ = run_script(tmp_path, item["run"], with_venv=False, LANGUAGE="python")
    assert code != 0
    assert calls == []


@pytest.mark.parametrize("item", [PREBUILD, DEPLOY], ids=["prebuild", "deploy"])
@pytest.mark.parametrize("token", ["", "callers-own-token"])
def test_python_deploys_keep_their_own_node_auth_token(tmp_path, item, token):
    code, calls, output = run_script(tmp_path, item["run"], with_venv=True, LANGUAGE="python", NODE_AUTH_TOKEN=token)
    assert code == 0, output
    assert calls
    assert all(call.startswith(f"{token}|") for call in calls)
