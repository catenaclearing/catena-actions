"""The dev-lock action must stay a JavaScript action (PLAT-473).

GitHub builds or pulls the image of every Docker action in a job before the first step runs, including actions nested in
a composite and including steps whose `if` is false. So a Docker action referenced from composite/deploy-cdk would be built
by every job in every repo that uses deploy-cdk@v0, production included, and a registry or package-index outage would fail
all of those deploys during job setup, where `continue-on-error` cannot help. A JavaScript action is only downloaded.
"""

import re
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent.parent
ACTION_DIR = ROOT / "actions" / "dev-lock"
ACTION = yaml.safe_load((ACTION_DIR / "action.yaml").read_text())


def test_the_action_runs_a_committed_javascript_bundle():
    runs = ACTION["runs"]
    assert runs["using"] == "node24"
    assert runs["main"] == "dist/main.cjs"
    assert runs["post"] == "dist/post.cjs"
    assert runs["post-if"] == "always()"
    for file in (runs["main"], runs["post"]):
        assert (ACTION_DIR / file).is_file(), f"{file} must be committed: a JavaScript action runs from its bundle"


def test_the_bundle_is_not_git_ignored():
    """This repo ignores `dist/`; the action's own bundle must be the exception or it would never be committed."""
    ignore = (ROOT / ".gitignore").read_text().splitlines()
    assert "!actions/dev-lock/dist/" in ignore
    assert ignore.index("!actions/dev-lock/dist/") > ignore.index("dist/")  # a negation only works after the rule it undoes


def test_no_docker_files_are_left_in_the_action():
    assert not (ACTION_DIR / "Dockerfile").exists()
    assert "image" not in ACTION["runs"]
    assert "entrypoint" not in ACTION["runs"]


def test_nothing_deploy_cdk_references_is_a_docker_action():
    """Every action under actions/ that a composite pulls in must run on node, never in a container that needs building."""
    composite = (ROOT / "composite" / "deploy-cdk" / "action.yaml").read_text()
    referenced = set(re.findall(r"catenaclearing/catena-actions/actions/([a-z0-9-]+)@", composite))
    for name in referenced:
        runs = yaml.safe_load((ROOT / "actions" / name / "action.yaml").read_text())["runs"]
        assert runs["using"] != "docker", f"actions/{name} is a Docker action: GitHub would build it in every job that uses deploy-cdk"


def test_the_inputs_and_outputs_the_composite_relies_on_exist():
    assert set(ACTION["inputs"]) == {"table_name", "aws_region", "ttl_minutes", "wait_minutes", "poll_seconds"}
    assert set(ACTION["outputs"]) == {"acquired", "blocked"}
