/** Consumer ChatGPT limits, not OpenAI API upload limits. Native token/rate limits remain authoritative. */
export const GPT_FILE_BYTES = 512 * 1024 ** 2;
export const GPT_IMAGE_BYTES = 20 * 1024 ** 2;
export const GPT_SPREADSHEET_BYTES = 50 * 1024 ** 2;
export const UPLOAD_CHUNK_BYTES = 4 * 1024 ** 2;
export const imageFilename = (name: string) =>
  /\.(png|jpe?g|webp|gif|avif|heic|heif|tiff?)$/i.test(name);
export function gptFileLimit(name: string) {
  // Spreadsheet ~50 MB is a processing guideline, not a byte-exact rejection rule.
  return imageFilename(name) ? GPT_IMAGE_BYTES : GPT_FILE_BYTES;
}
export function uploadMime(name: string): string {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    pdf: "application/pdf",
    zip: "application/zip",
    json: "application/json",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    md: "text/markdown",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc: "application/msword",
    xls: "application/vnd.ms-excel",
    ppt: "application/vnd.ms-powerpoint",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };
  return (
    known[ext] ??
    (/^(txt|log|py|js|ts|tsx|jsx|mjs|c|cpp|h|cs|java|rs|go|rb|php|html|css|yaml|yml|toml|xml|sql|sh|ps1|step|stp|obj|stl)$/.test(
      ext,
    )
      ? "text/plain"
      : "application/octet-stream")
  );
}
