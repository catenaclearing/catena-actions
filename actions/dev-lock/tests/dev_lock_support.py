"""Helpers shared by the dev-lock tests (kept out of conftest so tests can import them)."""

TABLE_NAME = "catena-dev-lock"
START = 1_800_000_000  # a fixed "now" (epoch seconds) so expiry maths is exact


class FakeClock:
    """Time that only moves when the code under test sleeps."""

    def __init__(self, now: float = START) -> None:
        self.current = now
        self.slept: list[float] = []

    def now(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.current += seconds


def github_env(**overrides: str) -> dict[str, str]:
    """The environment GitHub gives a Docker action for a PR-label dev deploy."""
    env = {
        "GITHUB_REPOSITORY": "catenaclearing/telematics-data-service",
        "GITHUB_ACTOR": "alice",
        "GITHUB_REF": "refs/pull/42/merge",
        "GITHUB_RUN_ID": "1001",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_JOB": "deploy-development",
        "GITHUB_EVENT_NAME": "pull_request",
        "GITHUB_SERVER_URL": "https://github.com",
        "AWS_DEFAULT_REGION": "us-east-1",
    }
    env.update(overrides)
    return env


def main_push_env(**overrides: str) -> dict[str, str]:
    return github_env(GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/main", **overrides)


def set_mode(table, mode: str) -> None:
    table.put_item(Item={"pk": "CONFIG", "sk": "mode", "value": mode})


def current_lock(table) -> dict | None:
    return table.get_item(Key={"pk": "LOCK#dev", "sk": "CURRENT"}, ConsistentRead=True).get("Item")


def queue_items(table) -> list[dict]:
    return table.query(
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": "QUEUE#dev"},
        ConsistentRead=True,
    )["Items"]


def hold_as_manual(table, *, user: str = "U123", expires_at: int = START + 7200) -> None:
    table.put_item(
        Item={
            "pk": "LOCK#dev",
            "sk": "CURRENT",
            "holder_type": "manual",
            "holder_key": f"manual#{user}",
            "actor": user,
            "reason": "testing the new connector",
            "started_at": START - 60,
            "expires_at": expires_at,
        },
    )


def hold_as_ci(table, *, repo: str = "catenaclearing/catena-platform", actor: str = "bob", expires_at: int = START + 3600) -> str:
    key = f"ci#{repo}#{actor}#refs/pull/7/merge"
    table.put_item(
        Item={
            "pk": "LOCK#dev",
            "sk": "CURRENT",
            "holder_type": "ci",
            "holder_key": key,
            "run_ids": {"2002-1-deploy-development"},
            "repo": repo,
            "actor": actor,
            "ref": "refs/pull/7/merge",
            "started_at": START - 60,
            "expires_at": expires_at,
        },
    )
    return key
