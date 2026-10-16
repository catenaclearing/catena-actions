import { run } from "./runner.js";

process.env.AWS_EC2_METADATA_DISABLED ??= "true";

// The post step never fails the job: at worst the lock is left to expire on its own.
run("release").then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 0;
  },
);
