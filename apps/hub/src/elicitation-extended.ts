/** Installed desktop 26.908: openaiForm resource choices and legacy imagePicker.
 * Resource URIs are returned only after selection. Never fetch icons/URIs from a form.
 */
export function extendedField(raw: Record<string, unknown>, legacy: boolean) {
  const v = { ...raw };
  let decoration: Record<string, unknown> = {};
  if (legacy && v.type === "openai/imagePicker") {
    if (Object.keys(v).some((k) => !["type", "title", "description", "items", "file"].includes(k)))
      throw Error("UNSUPPORTED_FIELD");
    if (!Array.isArray(v.items) || v.items.length > 100) throw Error("INVALID_OPTIONS");
    const images = v.items.map((item: any) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        typeof item.title !== "string" ||
        typeof item.image !== "string" ||
        item.image.length > 256000 ||
        !/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+={0,2}$/.test(item.image)
      )
        throw Error("INVALID_IMAGE");
      return { value: item.id, title: item.title, image: item.image };
    });
    decoration = {
      input: "images",
      images,
      allowFileUri: v.file != null,
      accept: fileOptions(v.file).accept,
    };
    v.type = "string";
    v.oneOf = images.map((o) => ({ const: o.value, title: o.title }));
    delete v.items;
    delete v.file;
  }
  if (v["x-openai-input"] != null) {
    const input = v["x-openai-input"] as any;
    if (
      !input ||
      input.type !== "file" ||
      !Array.isArray(input.options) ||
      input.options.length > 100 ||
      Object.keys(input).some(
        (k) => !["type", "options", "userOptions", "selection"].includes(k),
      ) ||
      (input.selection != null && !["explicit", "implicit"].includes(input.selection))
    )
      throw Error("UNSUPPORTED_INPUT");
    const choices = input.options.map((o: any) => {
      if (
        !o ||
        typeof o.uri !== "string" ||
        !URL.canParse(o.uri) ||
        typeof (o.title ?? o.name) !== "string"
      )
        throw Error("INVALID_RESOURCE");
      return { const: o.uri, title: o.title ?? o.name };
    });
    if (v.type === "array") {
      const item = v.items as any;
      if (
        !item ||
        item.type !== "string" ||
        item.format !== "uri" ||
        Object.keys(item).some((k) => !["type", "format"].includes(k))
      )
        throw Error("UNSUPPORTED_RESOURCE");
      v.items = { anyOf: choices };
      // Even implicit selections remain an explicit owner submission in the web UI.
      if (input.selection === "implicit") v.default = choices.map((o: any) => o.const);
    } else if (v.type === "string" && v.format === "uri") v.oneOf = choices;
    else throw Error("UNSUPPORTED_RESOURCE");
    decoration = {
      input: "files",
      allowFileUri: input.userOptions != null,
      ...fileOptions(input.userOptions),
    };
    delete v["x-openai-input"];
  }
  for (const name of ["oneOf", "items"] as const) {
    const choices = name === "items" ? (v.items as any)?.anyOf : v.oneOf;
    if (Array.isArray(choices)) {
      const clean = choices.map((o: any) => {
        if (!o || typeof o !== "object") throw Error("INVALID_OPTIONS");
        const { "x-openai-preview": _preview, ...rest } = o;
        return rest;
      });
      if (name === "items") v.items = { ...(v.items as object), anyOf: clean };
      else v.oneOf = clean;
    }
  }
  return { field: v, decoration };
}
function fileOptions(raw: any): { fileKind?: "file" | "directory"; accept?: string[] } {
  if (raw == null) return {};
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !["kind", "accept", "title"].includes(k)) ||
    (raw.kind != null && !["file", "directory"].includes(raw.kind)) ||
    (raw.accept != null &&
      (!Array.isArray(raw.accept) ||
        raw.accept.length > 40 ||
        raw.accept.some((s: unknown) => typeof s !== "string" || s.length > 100)))
  )
    throw Error("INVALID_FILE_OPTIONS");
  return { fileKind: raw.kind, accept: raw.accept };
}
/** Linear subset: literals/classes with at most one repeat, no groups, alternatives or backrefs. */
export function safeFormPattern(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[()|{}]/.test(value) ||
    /\\[1-9]/.test(value)
  )
    throw Error("UNSUPPORTED_PATTERN");
  const withoutClasses = value.replace(/\[(?:\\.|[^\]\\])*\]/g, "x").replace(/\\./g, "x");
  if ((withoutClasses.match(/[+*?]/g) ?? []).length > 1) throw Error("UNSUPPORTED_PATTERN");
  if (/[+*?]/.test(withoutClasses) && (!value.startsWith("^") || !value.endsWith("$")))
    throw Error("UNSUPPORTED_PATTERN");
  new RegExp(value, "u");
  return value;
}
export function selectedFileUri(value: string, accept?: string[]) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "file:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname ||
      [...decodeURIComponent(url.pathname)].some((c) => c.charCodeAt(0) < 32)
    )
      return false;
    if (!accept?.length || accept.includes("*/*")) return true;
    const name = decodeURIComponent(url.pathname).toLowerCase();
    const extensions: Record<string, string[]> = {
      "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"],
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "application/pdf": [".pdf"],
      "text/plain": [".txt"],
      "text/markdown": [".md"],
    };
    return accept.some((s) =>
      (s.startsWith(".") ? [s.toLowerCase()] : (extensions[s.toLowerCase()] ?? [])).some((ext) =>
        name.endsWith(ext),
      ),
    );
  } catch {
    return false;
  }
}
