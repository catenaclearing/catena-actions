import { appendFileSync } from "node:fs";

function escapeMessage(message) {
  return String(message).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** GitHub workflow commands (annotations) and step outputs, recorded so tests can read them back. */
export class Output {
  constructor({ echo = true, outputFile = null, stream = process.stdout } = {}) {
    this.echo = echo;
    this.outputFile = outputFile;
    this.stream = stream;
    this.messages = [];
    this.outputs = {};
  }

  #emit(level, message) {
    this.messages.push([level, message]);
    if (this.echo) this.stream.write(`::${level}::${escapeMessage(message)}\n`);
  }

  /** Emit a notice annotation. */
  notice(message) {
    this.#emit("notice", message);
  }

  /** Emit a warning annotation. */
  warning(message) {
    this.#emit("warning", message);
  }

  /** Emit an error annotation. */
  error(message) {
    this.#emit("error", message);
  }

  /** The full stack, only shown when the workflow runs with step debug logging. */
  debug(message) {
    this.#emit("debug", message);
  }

  /** Set a step output (written to the GITHUB_OUTPUT file when there is one). */
  setOutput(name, value) {
    this.outputs[name] = value;
    if (this.outputFile) appendFileSync(this.outputFile, `${name}=${value}\n`, "utf8");
  }
}
