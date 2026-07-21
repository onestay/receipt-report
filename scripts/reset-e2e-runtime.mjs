import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const runtime = resolve(".runtime");
mkdirSync(runtime, { recursive: true });
for (const name of ["e2e.db", "e2e-storage", "e2e-worker.ready"]) {
  const target = resolve(runtime, name);
  if (dirname(target) !== runtime)
    throw new Error(`Refusing to reset path outside ${runtime}`);
  rmSync(target, { force: true, recursive: true });
}
