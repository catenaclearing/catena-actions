import { run } from "./runner.js";

// With no AWS credentials in the environment the SDK would otherwise spend seconds probing an EC2 metadata
// service that does not exist on a GitHub runner; the credentials come from configure-aws-credentials.
process.env.AWS_EC2_METADATA_DISABLED ??= "true";

run("acquire").then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 0; // run() already fails open; this is only a last resort
  },
);
