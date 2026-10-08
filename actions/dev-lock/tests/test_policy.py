import pytest
from dev_lock.policy import Decision, Mode, decide, parse_mode


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, Mode.REPORT_ONLY),  # nothing seeds CONFIG/mode: absent means report-only
        ("report-only", Mode.REPORT_ONLY),
        ("enforce", Mode.ENFORCE),
        ("off", Mode.OFF),
        ("ENFORCE", Mode.REPORT_ONLY),  # unknown values never enforce
        ("", Mode.REPORT_ONLY),
        ("disabled", Mode.REPORT_ONLY),
    ],
)
def test_parse_mode_defaults_to_report_only(raw, expected):
    assert parse_mode(raw) is expected


@pytest.mark.parametrize("holder_type", ["ci", "manual"])
@pytest.mark.parametrize("is_main_push", [True, False])
def test_report_only_never_blocks(holder_type, is_main_push):
    assert decide(Mode.REPORT_ONLY, holder_type, is_main_push=is_main_push) is Decision.CONTINUE


def test_pr_deploy_fails_fast_whoever_holds_the_lock():
    assert decide(Mode.ENFORCE, "ci", is_main_push=False) is Decision.BLOCK
    assert decide(Mode.ENFORCE, "manual", is_main_push=False) is Decision.BLOCK


def test_merge_to_main_waits_for_a_ci_deploy():
    assert decide(Mode.ENFORCE, "ci", is_main_push=True) is Decision.WAIT


def test_merge_to_main_is_never_blocked_by_a_manual_hold():
    """Prod needs the dev job to pass, so a test hold must not stall a prod release."""
    assert decide(Mode.ENFORCE, "manual", is_main_push=True) is Decision.PREEMPT
