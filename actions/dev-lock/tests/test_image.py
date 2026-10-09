"""The built image, started the way GitHub starts a container action.

Everything else in this suite calls the Python code directly, which cannot see the one thing that broke in practice:
GitHub runs the container with `--workdir /github/workspace`, ignoring the image's WORKDIR, so anything that relies on
the working directory (like `python -m dev_lock` finding the package) works on a laptop and fails on a runner.
"""

import shutil
import subprocess
import uuid
from pathlib import Path

import pytest


ACTION_DIR = Path(__file__).resolve().parent.parent
DOCKERFILE = ACTION_DIR / "Dockerfile"

GITHUB_ENV = {
    "GITHUB_REPOSITORY": "catenaclearing/telematics-data-service",
    "GITHUB_ACTOR": "alice",
    "GITHUB_REF": "refs/pull/42/merge",
    "GITHUB_RUN_ID": "1001",
    "GITHUB_RUN_ATTEMPT": "1",
    "GITHUB_JOB": "deploy-development",
    "GITHUB_EVENT_NAME": "pull_request",
    "GITHUB_SERVER_URL": "https://github.com",
    # Nothing listens here, so the action takes its fail-open path after importing and running its own code.
    "AWS_ENDPOINT_URL": "http://127.0.0.1:1",
    "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test",
    "AWS_REGION": "us-east-1",
}


def _docker_works() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "info"], capture_output=True, check=False, timeout=60).returncode == 0  # noqa: S607


def test_the_image_does_not_depend_on_the_working_directory():
    """Cheap guard that runs everywhere: the package must be importable from any directory."""
    text = DOCKERFILE.read_text()
    assert "PYTHONPATH=/app" in text.replace(" ", "").replace("\\\n", "").replace("\n", "")


@pytest.fixture(scope="module", name="image")
def image_fixture():
    if not _docker_works():
        pytest.skip("docker is not available")
    tag = f"dev-lock-test-{uuid.uuid4().hex[:8]}"
    build = subprocess.run(["docker", "build", "-q", "-t", tag, str(ACTION_DIR)], capture_output=True, text=True, check=False)  # noqa: S603, S607
    assert build.returncode == 0, build.stderr
    yield tag
    subprocess.run(["docker", "image", "rm", "-f", tag], capture_output=True, check=False)  # noqa: S603, S607


def run_like_github(image: str, *, entrypoint: str | None = None) -> subprocess.CompletedProcess:
    """`docker run` with the flags GitHub adds to a container action that matter here."""
    command = ["docker", "run", "--rm", "--workdir", "/github/workspace", "-e", "HOME=/github/home"]
    for name, value in GITHUB_ENV.items():
        command += ["-e", f"{name}={value}"]
    if entrypoint:
        command += ["--entrypoint", entrypoint]
    return subprocess.run([*command, image], capture_output=True, text=True, check=False, timeout=120)  # noqa: S603


@pytest.mark.parametrize("entrypoint", [None, "/post.sh"], ids=["acquire", "release"])
def test_the_scripts_run_from_githubs_working_directory(image, entrypoint):
    result = run_like_github(image, entrypoint=entrypoint)

    assert "No module named" not in result.stdout + result.stderr
    # The store is unreachable, so reaching this message proves the code really ran and failed open.
    assert "dev-lock could not use the lock table" in result.stdout
    assert result.returncode == 0
