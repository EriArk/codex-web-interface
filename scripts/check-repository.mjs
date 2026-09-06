import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function forbiddenFile(path, bytes = Buffer.alloc(0)) {
  if (/(^|\/)(node_modules|dist|build|coverage|data|\.local|\.codex|playwright-report|test-results)(\/|$)/.test(path))
    return "generated or private runtime directory";
  if (/(^|\/)(auth\.json|config\.json|config\.local\.ya?ml|config\.ya?ml|remote\.env|deploy\.env|setup-link\.txt|known_hosts|authorized_keys)$/.test(path) ||
      /\.(db(?:-wal|-shm)?|sqlite3?|key|pem|pfx|p12|tsbuildinfo|log)$/.test(path) ||
      /(^|\/)\.env(?:\..+)?$/.test(path) && !path.endsWith(".env.example"))
    return "private configuration, credentials or generated file";
  const content = bytes.toString("utf8");
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(content) ||
      /gh[pousr]_[A-Za-z0-9]{30,}/.test(content) ||
      /github_pat_[A-Za-z0-9_]{40,}/.test(content))
    return "possible private key or access token";
  return undefined;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
  const problems = files.flatMap(path => {
    const reason = forbiddenFile(path, readFileSync(path));
    return reason ? [path + ": " + reason] : [];
  });
  if (problems.length) {
    console.error(problems.join("\n")); // File names only, never matching secret contents.
    process.exitCode = 1;
  } else console.log("Tracked repository files passed runtime/build/credential checks.");
}
