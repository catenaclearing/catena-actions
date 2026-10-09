from botocore.exceptions import ClientError, EndpointConnectionError
from dev_lock.runner import main
from dev_lock_support import github_env, hold_as_ci, set_mode


class BrokenTable:
    """A table whose every call fails the way AWS (or the network) can."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    def __getattr__(self, name):
        def fail(*_args, **_kwargs):
            raise self.error

        return fail


def client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "boom"}}, "PutItem")


def run(command: str, table, clock, out, env=None) -> int:
    return main([command], env or github_env(), table_factory=lambda _settings: table, clock=clock, out=out)


def test_access_denied_does_not_fail_the_deploy(clock, out):
    broken = BrokenTable(client_error("AccessDeniedException"))

    assert run("acquire", broken, clock, out) == 0
    assert run("release", broken, clock, out) == 0
    assert out.messages[0][0] == "warning"
    assert "AccessDeniedException" in out.messages[0][1]
    assert out.outputs["blocked"] == "false"  # an outage must never read as a deliberate block


def test_a_missing_table_does_not_fail_the_deploy(clock, out):
    """Before the DevLock stack is deployed the table does not exist."""
    assert run("acquire", BrokenTable(client_error("ResourceNotFoundException")), clock, out) == 0


def test_throttling_does_not_fail_the_deploy(clock, out):
    assert run("acquire", BrokenTable(client_error("ThrottlingException")), clock, out) == 0


def test_a_network_failure_does_not_fail_the_deploy(clock, out):
    assert run("acquire", BrokenTable(EndpointConnectionError(endpoint_url="https://dynamodb")), clock, out) == 0


def test_a_bug_in_the_action_does_not_fail_the_deploy(clock, out):
    assert run("acquire", BrokenTable(RuntimeError("unexpected")), clock, out) == 0
    assert "RuntimeError" in out.messages[0][1]


def test_missing_github_environment_does_not_fail_the_deploy(clock, out):
    assert main(["acquire"], {}, table_factory=lambda _s: None, clock=clock, out=out) == 0


def test_an_unknown_command_fails_loudly_because_it_is_a_wiring_bug(clock, out):
    assert main(["nope"], github_env(), table_factory=lambda _s: None, clock=clock, out=out) == 2


def test_a_real_block_is_not_swallowed_by_the_fail_open_wrapper(table, clock, out):
    set_mode(table, "enforce")
    hold_as_ci(table)

    assert run("acquire", table, clock, out) == 1


def test_release_never_fails_the_job_even_on_a_real_error(clock, out):
    assert run("release", BrokenTable(client_error("InternalServerError")), clock, out) == 0
