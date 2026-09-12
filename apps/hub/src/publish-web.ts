import { publishWeb } from "./web-releases.js";

const [source, root, socketPath, revision, checkUrl] = process.argv.slice(2);
if (!source || !root || !socketPath || !revision)
  throw new Error("Usage: publish-web source release-root engine-socket revision [public-url]");
const release = await publishWeb({
  source,
  root,
  socketPath,
  revision,
  postcheck: checkUrl
    ? async (release) => {
        const response = await fetch(new URL("/version.json", checkUrl), {
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok || ((await response.json()) as { id?: string }).id !== release.id)
          throw new Error("PUBLIC_POSTCHECK_FAILED");
      }
    : undefined,
});
process.stdout.write(JSON.stringify({ installed: true, id: release.id, revision }) + "\n");
