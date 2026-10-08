import sys
import traceback


def _escape(message: str) -> str:
    return message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


class Output:
    """GitHub workflow commands (annotations) and step outputs, recorded so tests can read them back."""

    def __init__(self, *, echo: bool = True, output_file: str | None = None) -> None:
        self.echo = echo
        self.output_file = output_file
        self.messages: list[tuple[str, str]] = []
        self.outputs: dict[str, str] = {}

    def _emit(self, level: str, message: str) -> None:
        self.messages.append((level, message))
        if self.echo:
            sys.stdout.write(f"::{level}::{_escape(message)}\n")
            sys.stdout.flush()

    def notice(self, message: str) -> None:
        """Emit a notice annotation."""
        self._emit("notice", message)

    def warning(self, message: str) -> None:
        """Emit a warning annotation."""
        self._emit("warning", message)

    def error(self, message: str) -> None:
        """Emit an error annotation."""
        self._emit("error", message)

    def debug_traceback(self) -> None:
        """Full traceback, only shown when the workflow runs with step debug logging."""
        self._emit("debug", traceback.format_exc())

    def set_output(self, name: str, value: str) -> None:
        """Set a step output (written to the GITHUB_OUTPUT file when there is one)."""
        self.outputs[name] = value
        if self.output_file:
            with open(self.output_file, "a", encoding="utf-8") as handle:  # noqa: PTH123
                handle.write(f"{name}={value}\n")
