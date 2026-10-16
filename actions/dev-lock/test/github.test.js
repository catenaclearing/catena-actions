import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Output } from "../src/github.js";

const capture = () => {
  const chunks = [];
  return { stream: { write: (chunk) => chunks.push(chunk) }, text: () => chunks.join("") };
};

describe("Output", () => {
  it("annotations are workflow commands", () => {
    const sink = capture();
    new Output({ stream: sink.stream }).warning("careful");
    assert.equal(sink.text(), "::warning::careful\n");
  });

  it("newlines and percent signs cannot break out of an annotation", () => {
    // A repo, ref or reason can contain anything; it must not be able to start a second workflow command.
    const sink = capture();
    new Output({ stream: sink.stream }).error("100%\n::set-output name=x::y\r");
    assert.equal(sink.text(), "::error::100%25%0A::set-output name=x::y%0D\n");
  });

  it("messages are recorded even when not echoed", () => {
    const sink = capture();
    const out = new Output({ echo: false, stream: sink.stream });
    out.notice("quiet");
    assert.deepEqual(out.messages, [["notice", "quiet"]]);
    assert.equal(sink.text(), "");
  });

  it("outputs are appended to the GITHUB_OUTPUT file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "dev-lock-")), "github_output");
    const out = new Output({ echo: false, outputFile: file });
    out.setOutput("acquired", "true");
    out.setOutput("other", "x");
    assert.equal(readFileSync(file, "utf8"), "acquired=true\nother=x\n");
    assert.deepEqual(out.outputs, { acquired: "true", other: "x" });
  });

  it("outputs work without an output file", () => {
    const out = new Output({ echo: false });
    out.setOutput("acquired", "false");
    assert.deepEqual(out.outputs, { acquired: "false" });
  });
});
