from enum import Enum, StrEnum


class Mode(StrEnum):
    """Runtime mode, stored in the table so it can be changed without a release."""

    OFF = "off"
    REPORT_ONLY = "report-only"
    ENFORCE = "enforce"


class Decision(Enum):
    """What a deploy does when someone else holds a live lock."""

    CONTINUE = "continue"  # deploy anyway (report-only)
    BLOCK = "block"  # fail the job now and queue for a "your turn" ping
    WAIT = "wait"  # poll until the lock frees, up to the wait limit
    PREEMPT = "preempt"  # deploy anyway and tell the manual holder


def parse_mode(raw: str | None) -> Mode:
    """Parse the runtime mode stored in the table. Anything missing or unrecognised is report-only, so it never enforces by accident."""
    try:
        return Mode(raw) if raw else Mode.REPORT_ONLY
    except ValueError:
        return Mode.REPORT_ONLY


def decide(mode: Mode, holder_type: str, *, is_main_push: bool) -> Decision:
    """Decide what to do when someone else holds a live lock.

    A merge to main must never be stalled by a manual hold: its dev job gates the production deploy.
    """
    if mode is not Mode.ENFORCE:
        return Decision.CONTINUE
    if not is_main_push:
        return Decision.BLOCK
    return Decision.PREEMPT if holder_type == "manual" else Decision.WAIT
