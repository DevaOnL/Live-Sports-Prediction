import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const next = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
try {
  const child = spawn(process.execPath, [next, "build"], { stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  // Next copies local dotenv files into standalone output. Runtime secrets must
  // be supplied by the deployment environment, never distributed with the build.
  const directory = new URL("../.next/standalone/", import.meta.url);
  for (const name of await readdir(directory).catch(() => [])) {
    if (name === ".env" || name.startsWith(".env.")) await rm(new URL(name, directory), { force: true });
  }
}
