import { build } from "esbuild";
import { readFile, writeFile, chmod } from "node:fs/promises";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external: [],
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
  }),
]);

// Prepend shebang to CLI (must be byte-level first line for the OS to parse it)
const cli = await readFile("dist/cli.js", "utf-8");
if (!cli.startsWith("#!")) {
  await writeFile("dist/cli.js", "#!/usr/bin/env node\n" + cli);
}
await chmod("dist/cli.js", 0o755);

console.log("Built dist/index.js and dist/cli.js");
