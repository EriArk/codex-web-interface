/** Existing authenticated file capabilities only. Never a URL fetcher or host-path reader. */
export function isFileSource(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  if (/^\/api\/team\/projects\/[a-f0-9-]{36}\/assets\/[a-f0-9-]{36}$/.test(value)) return true;
  if (/^\/api\/projects\/[a-zA-Z0-9_-]+\/files\/content\?[^#]+$/.test(value)) {
    const q = new URLSearchParams(value.split("?")[1]);
    return (
      (q.size === 1 || (q.size === 2 && q.get("version") === "index")) &&
      !!q.get("path") &&
      q.get("path")!.length <= 2048
    );
  }
  return /^\/api\/(?:gpt\/projects\/[a-zA-Z0-9_-]+\/files\/[a-zA-Z0-9_-]+|gpt\/text-artifacts\/[a-f0-9]{64}|gpt\/native-assets\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/file[-_][a-zA-Z0-9_-]+|gpt\/(?:assets|results|uploads)\/[a-zA-Z0-9_-]+|gpt\/downloads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/sandbox-[a-f0-9]{64}|(?:attachments|native-images|artifacts)\/[a-zA-Z0-9_-]+)$/.test(
    value,
  );
}
