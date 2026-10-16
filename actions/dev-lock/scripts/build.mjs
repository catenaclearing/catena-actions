// Bundle the action into dist/. GitHub runs dist/main.cjs and dist/post.cjs directly, with nothing to install or build,
// so the bundle is committed and CI checks it is up to date.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export function bundle(outdir = here("../dist")) {
  return build({
    entryPoints: [here("../src/main.js"), here("../src/post.js")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    minify: true,
    legalComments: "none",
    outExtension: { ".js": ".cjs" },
    outdir,
    logLevel: "warning",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle();
