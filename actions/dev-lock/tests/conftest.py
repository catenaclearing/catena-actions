import boto3
import pytest
from dev_lock.config import Settings
from dev_lock.github import Output
from dev_lock.store import LockStore
from dev_lock_support import TABLE_NAME, FakeClock, github_env
from moto import mock_aws


@pytest.fixture(name="table")
def table_fixture():
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="us-east-1")
        resource.create_table(
            TableName=TABLE_NAME,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield resource.Table(TABLE_NAME)


@pytest.fixture(name="clock")
def clock_fixture() -> FakeClock:
    return FakeClock()


@pytest.fixture(name="out")
def out_fixture() -> Output:
    return Output(echo=False)


@pytest.fixture(name="make")
def make_fixture(table, clock):
    """Build (settings, store) for a given GitHub environment."""

    def _make(env: dict[str, str] | None = None, **settings_overrides) -> tuple[Settings, LockStore]:
        settings = Settings.from_env(env or github_env(), **settings_overrides)
        return settings, LockStore(table, clock=clock.now)

    return _make
