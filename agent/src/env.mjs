// Load .env files without printing any value.
// Order of precedence: the real environment, then agent/.env, then the repo root .env.
// A key that is already set is never overwritten. `node --env-file=.env run.mjs` also works,
// because those values are in the environment before this runs.

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * @param {string[]} files  paths, highest precedence first
 * @param {object} [env]    target, default process.env
 * @returns {{ file: string, keys: number }[]}  which files were read and how many keys they set (names only)
 */
export function loadEnvFiles(files, env = process.env) {
  const loaded = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed;
    try { parsed = parseEnv(readFileSync(file, "utf8")); } catch { throw new Error(`Cannot parse ${file}`); }
    let n = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined || env[k] === "") { env[k] = v; n++; }
    }
    loaded.push({ file, keys: n });
  }
  return loaded;
}
