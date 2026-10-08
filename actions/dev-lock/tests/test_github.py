from dev_lock.github import Output


def test_annotations_are_workflow_commands(capsys):
    out = Output()

    out.warning("careful")

    assert capsys.readouterr().out == "::warning::careful\n"


def test_newlines_and_percent_signs_cannot_break_out_of_an_annotation(capsys):
    """A repo, ref or reason can contain anything; it must not be able to start a second workflow command."""
    out = Output()

    out.error("100%\n::set-output name=x::y")

    assert capsys.readouterr().out == "::error::100%25%0A::set-output name=x::y\n"


def test_messages_are_recorded_even_when_not_echoed(capsys):
    out = Output(echo=False)

    out.notice("quiet")

    assert out.messages == [("notice", "quiet")]
    assert capsys.readouterr().out == ""


def test_outputs_are_appended_to_the_github_output_file(tmp_path):
    output_file = tmp_path / "github_output"
    out = Output(echo=False, output_file=str(output_file))

    out.set_output("acquired", "true")
    out.set_output("other", "x")

    assert output_file.read_text() == "acquired=true\nother=x\n"
    assert out.outputs == {"acquired": "true", "other": "x"}


def test_outputs_work_without_an_output_file():
    out = Output(echo=False)

    out.set_output("acquired", "false")

    assert out.outputs == {"acquired": "false"}
