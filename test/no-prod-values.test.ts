// This package's repo is PUBLIC: no account id, ARN, production domain or zone
// may be committed. Every concrete value arrives as a parameter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// cdk.context.json is gitignored: it carries the deploying account (AZ lookup).
const SKIP = new Set(["node_modules", ".git", "cdk.out", "package-lock.json", "cdk.context.json"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("no account id, ARN with an account, hosted zone id or Dilaya domain in the sources", () => {
  for (const f of files(root)) {
    const body = readFileSync(f, "utf8");
    const rel = f.slice(root.length);
    for (const m of body.matchAll(/\b\d{12}\b/g)) assert.equal(m[0], "111111111111", `${rel}: ${m[0]}`);
    assert.doesNotMatch(body, /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/, rel);
    for (const m of body.matchAll(/\bZ[0-9A-Z]{12,}\b/g)) assert.equal(m[0], "ZEXAMPLE12345", `${rel}: ${m[0]}`);
    assert.doesNotMatch(body, /dilaya\.(eu|app)\b|dilaya-apps\.eu/i, rel);
  }
});
