import type { Elicitation, ElicitationValue } from "@codex-web/shared";
import { useRef, useState } from "react";
import { workspaceMediaUrl } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import "./elicitation.css";

export function ElicitationCard({
  id,
  form,
  disabled,
}: {
  id: string;
  form: Elicitation;
  disabled: boolean;
}) {
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() =>
    Object.fromEntries(
      (form.fields ?? [])
        .filter((f) => f.default !== undefined || (f.required && f.type === "array"))
        .map((f) => [f.key, (f.default ?? []) as ElicitationValue]),
    ),
  );
  const [fileUris, setFileUris] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [resolved, setResolved] = useState(false),
    [opened, setOpened] = useState(false);
  const sending = useRef(false),
    receipt = useRef<{ signature: string; key: string } | null>(null);
  const update = (key: string, value: ElicitationValue | undefined) =>
    setValues((old) => {
      const next = { ...old };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  const submit = async (action: "accept" | "decline" | "cancel") => {
    if (sending.current || disabled || resolved) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const body = {
        action,
        ...(action === "accept" && form.mode === "form" ? { content: values } : {}),
      },
      signature = JSON.stringify(body);
    if (receipt.current?.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    try {
      await api(`/approvals/${id}/elicitation`, { method: "POST", key: receipt.current.key, body });
      setResolved(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const locked = busy || disabled || resolved;
  return (
    <section className="approval elicitation-card" aria-label={`Запрос ${form.serverName}`}>
      <header>
        <Icon name="help" />
        <strong>{form.serverName}</strong>
      </header>
      <p>{form.message}</p>
      {resolved ? (
        <p role="status">Ответ передан</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("accept");
          }}
        >
          {form.mode === "form" && (
            <fieldset disabled={locked} className="elicitation-fields">
              {(form.fields ?? []).map((f) => (
                <div className="elicitation-field" key={f.key}>
                  <label htmlFor={`${id}-${f.key}`}>
                    {f.title}
                    {f.required ? " *" : ""}
                  </label>
                  {f.description && <small id={`${id}-${f.key}-help`}>{f.description}</small>}
                  {f.input === "images" ? (
                    <fieldset className="elicitation-images" aria-label={f.title}>
                      {f.options?.map((o) => (
                        <label className="choice" key={o.value}>
                          <input
                            type="radio"
                            name={`${id}-${f.key}`}
                            checked={values[f.key] === o.value}
                            onChange={() => update(f.key, o.value)}
                          />
                          {o.image && <img src={workspaceMediaUrl(o.image)} alt="" />}
                          <span>{o.title}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : f.type === "array" ? (
                    <fieldset id={`${id}-${f.key}`} aria-label={f.title}>
                      {f.options?.map((o) => (
                        <label className="choice" key={o.value}>
                          <input
                            type="checkbox"
                            checked={
                              Array.isArray(values[f.key]) &&
                              (values[f.key] as string[]).includes(o.value)
                            }
                            onChange={(e) => {
                              const selected = Array.isArray(values[f.key])
                                ? (values[f.key] as string[])
                                : [];
                              update(
                                f.key,
                                e.target.checked
                                  ? [...selected, o.value]
                                  : selected.filter((v) => v !== o.value),
                              );
                            }}
                          />
                          <span>{o.title}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : f.options || f.type === "boolean" ? (
                    <select
                      id={`${id}-${f.key}`}
                      aria-describedby={`${id}-${f.key}-help`}
                      value={
                        values[f.key] === undefined
                          ? ""
                          : f.type === "boolean"
                            ? String(values[f.key])
                            : String(
                                (f.options?.findIndex((o) => o.value === values[f.key]) ?? -1) + 1,
                              )
                      }
                      required={f.required && !f.allowFileUri}
                      onChange={(e) =>
                        update(
                          f.key,
                          e.target.value === ""
                            ? undefined
                            : f.type === "boolean"
                              ? e.target.value === "true"
                              : f.options?.[Number(e.target.value) - 1]?.value,
                        )
                      }
                    >
                      <option value="">Выбрать…</option>
                      {f.type === "boolean" ? (
                        <>
                          <option value="true">Да</option>
                          <option value="false">Нет</option>
                        </>
                      ) : (
                        f.options?.map((o, index) => (
                          <option key={o.value} value={index + 1}>
                            {o.title}
                          </option>
                        ))
                      )}
                    </select>
                  ) : (
                    <input
                      id={`${id}-${f.key}`}
                      aria-describedby={`${id}-${f.key}-help`}
                      autoComplete="off"
                      required={f.required}
                      type={
                        f.type === "number" || f.type === "integer"
                          ? "number"
                          : f.format === "email"
                            ? "email"
                            : f.format === "date"
                              ? "date"
                              : "text"
                      }
                      step={f.type === "integer" ? 1 : "any"}
                      min={f.minimum}
                      max={f.maximum}
                      minLength={f.minLength}
                      maxLength={Math.min(f.maxLength ?? 8000, 8000)}
                      value={String(values[f.key] ?? "")}
                      onChange={(e) =>
                        update(
                          f.key,
                          e.target.value === ""
                            ? undefined
                            : f.type === "number" || f.type === "integer"
                              ? Number(e.target.value)
                              : e.target.value,
                        )
                      }
                    />
                  )}
                  {f.allowFileUri && (
                    <div className="elicitation-file-uri">
                      <label htmlFor={`${id}-${f.key}-uri`}>
                        {f.fileKind === "directory"
                          ? "Другая папка на машине"
                          : "Другой файл на машине"}
                      </label>
                      <input
                        id={`${id}-${f.key}-uri`}
                        type="text"
                        autoComplete="off"
                        placeholder="file:///…"
                        value={fileUris[f.key] ?? ""}
                        onChange={(e) =>
                          setFileUris((old) => ({ ...old, [f.key]: e.target.value }))
                        }
                      />
                      {f.accept?.length ? <small>{f.accept.join(", ")}</small> : null}
                      <button
                        type="button"
                        className="secondary"
                        disabled={!fileUris[f.key]?.trim()}
                        onClick={() => {
                          const value = fileUris[f.key]?.trim();
                          if (!value) return;
                          update(
                            f.key,
                            f.type === "array"
                              ? [
                                  ...new Set([
                                    ...(Array.isArray(values[f.key])
                                      ? (values[f.key] as string[])
                                      : []),
                                    value,
                                  ]),
                                ]
                              : value,
                          );
                          setFileUris((old) => ({ ...old, [f.key]: "" }));
                        }}
                      >
                        Выбрать
                      </button>
                      {(Array.isArray(values[f.key])
                        ? (values[f.key] as string[])
                        : typeof values[f.key] === "string"
                          ? [values[f.key] as string]
                          : []
                      )
                        .filter((v) => !f.options?.some((o) => o.value === v))
                        .map((value) => (
                          <div className="choice" key={value}>
                            <span>{value}</span>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Убрать выбранный файл"
                              onClick={() =>
                                update(
                                  f.key,
                                  f.type === "array"
                                    ? (values[f.key] as string[]).filter((v) => v !== value)
                                    : undefined,
                                )
                              }
                            >
                              <Icon name="close" />
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {form.mode === "url" && (
            <a
              className="secondary elicitation-open"
              href={workspaceMediaUrl(`/api/approvals/${id}/open`)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpened(true)}
            >
              <Icon name="external" />
              Открыть {form.host}
            </a>
          )}
          {form.mode === "unsupported" && (
            <p>
              Этот формат формы пока не поддерживается. Можно отклонить запрос или отменить его.
            </p>
          )}
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={locked}
              onClick={() => void submit("cancel")}
            >
              Отмена
            </button>
            <button
              type="button"
              className="secondary"
              disabled={locked}
              onClick={() => void submit("decline")}
            >
              Отклонить
            </button>
            {form.mode !== "unsupported" && (
              <button
                type="submit"
                className="primary"
                disabled={locked || (form.mode === "url" && !opened)}
              >
                {busy ? <span className="spinner" /> : <Icon name="check" />}
                {form.mode === "url" ? "Готово" : "Ответить"}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
