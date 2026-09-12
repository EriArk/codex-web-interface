import {
  type Elicitation,
  type ElicitationField,
  type ElicitationValue,
  HubError,
} from "@codex-web/shared";
import { extendedField, safeFormPattern, selectedFileUri } from "./elicitation-extended.js";

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("INVALID_SCHEMA");
  return v as Record<string, unknown>;
};
const string = (v: unknown, max: number) => {
  if (typeof v !== "string" || v.length > max) throw Error("INVALID_SCHEMA");
  return v;
};
function options(value: Record<string, unknown>, titled = "oneOf") {
  if (value.enum !== undefined && value[titled] !== undefined) throw Error("INVALID_OPTIONS");
  if (Array.isArray(value.enum)) {
    const labels = Array.isArray(value.enumNames) ? value.enumNames : [];
    return value.enum.map((v, i) => ({
      value: string(v, 2000),
      title: string(labels[i] ?? v, 2000),
    }));
  }
  if (Array.isArray(value[titled]))
    return value[titled].map((v) => {
      const entry = object(v);
      if (Object.keys(entry).some((key) => !["const", "title"].includes(key)))
        throw Error("UNSUPPORTED_CONSTRAINT");
      return { value: string(entry.const, 2000), title: string(entry.title, 2000) };
    });
  return undefined;
}
export function parseElicitation(p: Record<string, unknown>): { form: Elicitation; url?: string } {
  const base = {
    serverName: typeof p.serverName === "string" ? p.serverName.slice(0, 200) : "MCP",
    message: typeof p.message === "string" ? p.message.slice(0, 8000) : "Запрос инструмента",
  };
  try {
    if (p.mode === "url") {
      const url = new URL(string(p.url, 16000));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw Error("INVALID_URL");
      return { form: { ...base, mode: "url", host: url.host }, url: url.href };
    }
    const extended = p.mode === "openai/form" || p.mode === "openaiForm";
    if (p.mode !== "form" && !extended) throw Error("UNSUPPORTED_FORM");
    const schema = object(p.requestedSchema),
      properties = object(schema.properties);
    if (
      Object.keys(schema).some(
        (key) => !["$schema", "type", "properties", "required"].includes(key),
      )
    )
      throw Error("UNSUPPORTED_CONSTRAINT");
    if (schema.type !== "object" || Object.keys(properties).length > 40)
      throw Error("INVALID_SCHEMA");
    const required = schema.required == null ? [] : schema.required;
    if (
      !Array.isArray(required) ||
      required.some((k) => typeof k !== "string" || !Object.hasOwn(properties, k))
    )
      throw Error("INVALID_SCHEMA");
    const fields = Object.entries(properties).map(([key, raw]): ElicitationField => {
      if (!key || key.length > 200 || ["__proto__", "constructor", "prototype"].includes(key))
        throw Error("INVALID_SCHEMA");
      const prepared = extended
        ? extendedField(object(raw), p.mode === "openai/form")
        : { field: object(raw), decoration: {} };
      const v = prepared.field;
      if (!["string", "number", "integer", "boolean", "array"].includes(String(v.type)))
        throw Error("UNSUPPORTED_FIELD");
      const f: ElicitationField = {
        key,
        title: string(v.title ?? key, 2000),
        description: string(v.description ?? "", 4000),
        type: v.type as ElicitationField["type"],
        required: required.includes(key),
        ...prepared.decoration,
      };
      const images = (
        prepared.decoration as { images?: { value: string; title: string; image: string }[] }
      ).images;
      delete (f as unknown as Record<string, unknown>).images;
      if (extended && v.pattern != null) {
        f.pattern = safeFormPattern(v.pattern);
        delete v.pattern;
      }
      const allowed = new Set([
        "type",
        "title",
        "description",
        "default",
        ...(f.type === "string"
          ? ["enum", "enumNames", "oneOf", "format", "minLength", "maxLength"]
          : f.type === "array"
            ? ["items", "minItems", "maxItems"]
            : f.type === "boolean"
              ? []
              : ["minimum", "maximum"]),
      ]);
      if (Object.keys(v).some((k) => !allowed.has(k))) throw Error("UNSUPPORTED_CONSTRAINT");
      if (f.type === "array") {
        const items = object(v.items);
        if (
          Object.keys(items).some((key) => !["type", "enum", "anyOf"].includes(key)) ||
          (items.type !== undefined && items.type !== "string")
        )
          throw Error("UNSUPPORTED_CONSTRAINT");
      }
      f.options =
        f.type === "array"
          ? options(object(v.items), "anyOf")
          : f.type === "string"
            ? options(v)
            : undefined;
      if (f.type === "array" && !f.options) throw Error("UNSUPPORTED_ARRAY");
      if (
        f.options &&
        ((!f.options.length && !f.allowFileUri) ||
          f.options.length > 100 ||
          new Set(f.options.map((o) => o.value)).size !== f.options.length)
      )
        throw Error("INVALID_OPTIONS");
      if (images) f.options = images;
      for (const k of [
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
      ] as const) {
        if (v[k] == null) continue;
        const n = v[k];
        if (
          typeof n !== "number" ||
          !Number.isFinite(n) ||
          (!["minimum", "maximum"].includes(k) && (!Number.isSafeInteger(n) || n < 0))
        )
          throw Error("INVALID_BOUND");
        f[k] = n;
      }
      for (const [min, max] of [
        [f.minimum, f.maximum],
        [f.minLength, f.maxLength],
        [f.minItems, f.maxItems],
      ])
        if (min !== undefined && max !== undefined && min > max) throw Error("INVALID_BOUND");
      if (v.format != null) {
        if (!["email", "uri", "date", "date-time"].includes(String(v.format)))
          throw Error("UNSUPPORTED_FORMAT");
        f.format = v.format as ElicitationField["format"];
      }
      if (v.default != null) {
        validateField(f, v.default);
        f.default = v.default as ElicitationValue;
      }
      return f;
    });
    if (JSON.stringify(fields).length > (extended ? 2_000_000 : 100000))
      throw Error("SCHEMA_TOO_LARGE");
    return { form: { ...base, mode: "form", fields } };
  } catch {
    return { form: { ...base, mode: "unsupported" } };
  }
}
function invalid(f: ElicitationField): never {
  throw new HubError(400, "ELICITATION_INVALID", `Проверь поле «${f.title}».`);
}
function validateField(f: ElicitationField, value: unknown): void {
  if (f.type === "boolean") {
    if (typeof value !== "boolean") invalid(f);
  } else if (f.type === "number" || f.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (f.type === "integer" && !Number.isSafeInteger(value)) ||
      (f.minimum !== undefined && value < f.minimum) ||
      (f.maximum !== undefined && value > f.maximum)
    )
      invalid(f);
  } else if (f.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      new Set(value).size !== value.length ||
      value.length < (f.minItems ?? 0) ||
      value.length > (f.maxItems ?? 100) ||
      value.some(
        (v) =>
          typeof v !== "string" ||
          v.length > 8000 ||
          (!f.options?.some((o) => o.value === v) &&
            !(f.allowFileUri && selectedFileUri(v, f.accept))),
      )
    )
      invalid(f);
  } else {
    if (
      typeof value !== "string" ||
      [...value].length < (f.minLength ?? 0) ||
      [...value].length > Math.min(f.maxLength ?? 8000, 8000)
    )
      invalid(f);
    if (
      f.options &&
      !f.options.some((o) => o.value === value) &&
      !(f.allowFileUri && selectedFileUri(value, f.accept))
    )
      invalid(f);
    if (f.pattern && !new RegExp(f.pattern, "u").test(value)) invalid(f);
    if (f.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid(f);
    if (f.format === "uri") {
      try {
        new URL(value);
      } catch {
        invalid(f);
      }
    }
    if (
      f.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      invalid(f);
    if (
      f.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      invalid(f);
  }
}
export function elicitationResponse(
  form: Elicitation,
  action: "accept" | "decline" | "cancel",
  input?: unknown,
) {
  if (action !== "accept") return { action, content: null };
  if (form.mode === "unsupported")
    throw new HubError(400, "ELICITATION_UNSUPPORTED", "Эту форму пока нельзя заполнить здесь.");
  if (form.mode === "url") return { action, content: null };
  let content: Record<string, unknown>;
  try {
    content = object(input);
  } catch {
    throw new HubError(400, "ELICITATION_INVALID", "Заполни форму.");
  }
  const fields = form.fields ?? [];
  if (Object.keys(content).some((key) => !fields.some((f) => f.key === key)))
    throw new HubError(400, "ELICITATION_INVALID", "Форма содержит неизвестное поле.");
  for (const f of fields) {
    if (!Object.hasOwn(content, f.key)) {
      if (f.required) invalid(f);
      continue;
    }
    validateField(f, content[f.key]);
  }
  return { action, content };
}
