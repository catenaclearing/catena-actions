import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path


DEFAULT_TABLE_NAME = "catena-dev-lock"
DEFAULT_REGION = "us-east-1"
DEFAULT_TTL_MINUTES = 60
DEFAULT_WAIT_MINUTES = 30
DEFAULT_POLL_SECONDS = 15


def _input(env: Mapping[str, str], name: str, default: str) -> str:
    """Read an action input. GitHub passes an empty string for an input that is declared but unset."""
    return env.get(f"INPUT_{name}", "").strip() or default


def _pr_url(env: Mapping[str, str]) -> str | None:
    path = env.get("GITHUB_EVENT_PATH")
    if not path:
        return None
    try:
        event = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None
    pull_request = event.get("pull_request") if isinstance(event, dict) else None
    return pull_request.get("html_url") if isinstance(pull_request, dict) else None


@dataclass(frozen=True)
class Settings:
    """Everything the action needs, read from the GitHub environment and the action inputs."""

    table_name: str
    region: str
    ttl_seconds: int
    wait_seconds: int
    poll_seconds: int
    repo: str
    actor: str
    ref: str
    run_id: str
    run_attempt: str
    job: str
    event_name: str
    server_url: str
    pr_url: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str], **overrides) -> "Settings":
        """Build settings from the GitHub environment; `overrides` replace fields (used by tests)."""
        settings = cls(
            table_name=_input(env, "TABLE_NAME", DEFAULT_TABLE_NAME),
            region=_input(env, "AWS_REGION", env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION") or DEFAULT_REGION),
            ttl_seconds=int(_input(env, "TTL_MINUTES", str(DEFAULT_TTL_MINUTES))) * 60,
            wait_seconds=int(_input(env, "WAIT_MINUTES", str(DEFAULT_WAIT_MINUTES))) * 60,
            poll_seconds=int(_input(env, "POLL_SECONDS", str(DEFAULT_POLL_SECONDS))),
            repo=env["GITHUB_REPOSITORY"],
            actor=env["GITHUB_ACTOR"],
            ref=env["GITHUB_REF"],
            run_id=env["GITHUB_RUN_ID"],
            run_attempt=env.get("GITHUB_RUN_ATTEMPT", "1"),
            job=env.get("GITHUB_JOB", ""),
            event_name=env.get("GITHUB_EVENT_NAME", ""),
            server_url=env.get("GITHUB_SERVER_URL", "https://github.com"),
            pr_url=_pr_url(env),
        )
        return replace(settings, **overrides) if overrides else settings

    @property
    def holder_key(self) -> str:
        """Who holds the lock: every run started by one repo + actor + ref shares one holder."""
        return f"ci#{self.repo}#{self.actor}#{self.ref}"

    @property
    def run_token(self) -> str:
        """One workflow run's share of a holder. A holder keeps the lock until its last run releases."""
        return f"{self.run_id}-{self.run_attempt}-{self.job}"

    @property
    def is_main_push(self) -> bool:
        """A merge to main. Its dev deploy gates the production deploy, so it is treated differently."""
        return self.event_name == "push" and self.ref == "refs/heads/main"

    @property
    def run_url(self) -> str:
        """Link to this workflow run, shown to people who are told about it."""
        return f"{self.server_url}/{self.repo}/actions/runs/{self.run_id}"
