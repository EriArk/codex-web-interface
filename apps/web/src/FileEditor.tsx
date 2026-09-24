import { indentWithTab, redo, undo } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { FileSnapshot } from "@codex-web/shared";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, messageOf } from "./api";
import { FileCopySave } from "./FileCopySave";
import { FileEditorPreview } from "./FileEditorPreview";
import { githubDraftStorage } from "./githubDraftStorage";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import { HelpButton } from "./WorkspaceHelp";
import "./file-editor.css";

export default function FileEditor({
  projectId,
  capability,
  projectName,
  path,
  onClose,
  onSaved,
  copy,
  reviewSave,
}: {
  projectId: string;
  capability: string;
  projectName: string;
  path: string;
  onClose: () => void;
  onSaved: () => void;
  copy?: { file: File; source: string };
  reviewSave?: (file: File) => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    host = useRef<HTMLDivElement>(null);
  useWorkspaceDialog(dialog);
  const editor = useRef<EditorView | null>(null),
    baseline = useRef<FileSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [closing, setClosing] = useState(false),
    [wrap, setWrap] = useState(false),
    [conflict, setConflict] = useState<FileSnapshot | null>(null),
    [preview, setPreview] = useState<File | null>(null),
    [copyToSave, setCopyToSave] = useState<File | null>(null);
  const wrapping = useRef(new Compartment()),
    syntax = useRef(new Compartment()),
    endings = useRef(new Compartment());
  const saveAction = useRef<() => void>(() => {}),
    saving = useRef(false);
  const pending = useRef<{
    signature: string;
    id: string;
    text: string;
    fingerprint: string;
    bom?: boolean;
  } | null>(null);
  const active = useRef(true);
  const lineSeparator = useRef("\n");
  const key = copy
      ? `workspace-file-copy:${copy.source}`
      : `workspace-file-draft:${projectId}:${path}`,
    url = `/projects/${encodeURIComponent(projectId)}/file-tools`;
  const exactLines = (text: string) => text.replace(/\r\n|\r|\n/g, lineSeparator.current);
  const current = () => exactLines(editor.current?.state.sliceDoc() ?? "");
  const separatorOf = (text: string) => {
    const separators = new Set(text.match(/\r\n|\r|\n/g) ?? []);
    if (separators.size > 1)
      throw Error(
        "В файле смешаны окончания строк. Доступен просмотр или скачивание; редактор не будет менять их автоматически.",
      );
    return text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  };
  const storage = githubDraftStorage;
  const persist = async () => {
    if (!baseline.current || !editor.current) return false;
    try {
      if (current() === baseline.current.text && !pending.current) await storage.removeItem(key);
      else
        await storage.setItem(
          key,
          JSON.stringify({ baseline: baseline.current, text: current(), pending: pending.current }),
        );
      return true;
    } catch {
      if (active.current)
        setError(
          "Не удалось сохранить черновик на устройстве. Не закрывай редактор до сохранения файла.",
        );
      return false;
    }
  };
  const save = async () => {
    const base = baseline.current;
    if (
      !base ||
      !editor.current ||
      saving.current ||
      (!copy && current() === base.text && !pending.current)
    )
      return;
    if (copy) {
      saving.current = true;
      setBusy(true);
      try {
        if (!(await persist())) return;
        await (reviewSave ?? setCopyToSave)(
          new File([(base.bom ? "\ufeff" : "") + current()], path.split("/").at(-1)!, {
            type: "text/plain",
          }),
        );
      } catch (e) {
        setError(messageOf(e));
      } finally {
        saving.current = false;
        if (active.current) setBusy(false);
      }
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    if (!pending.current)
      pending.current = {
        signature: JSON.stringify([base.fingerprint, current(), base.bom]),
        id: crypto.randomUUID(),
        text: current(),
        fingerprint: base.fingerprint,
        bom: base.bom,
      };
    const operation = pending.current,
      text = operation.text;
    try {
      if (!(await persist())) return;
      const result = await api<FileSnapshot>(url, {
        method: "POST",
        body: {
          op: "save",
          path,
          text,
          bom: operation.bom,
          fingerprint: operation.fingerprint,
          id: operation.id,
          capability,
        },
      });
      baseline.current = { ...result, text, bom: operation.bom };
      pending.current = null;
      if (!active.current) return;
      setDirty(current() !== text);
      setConflict(null);
      persist();
      onSaved();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        !["FILE_UNKNOWN", "FILE_LOCKED", "FILE_SCOPE_CHANGED"].includes(e.code)
      )
        pending.current = null;
      if (!active.current) return;
      setError(messageOf(e));
      if (e instanceof ApiError && e.code === "FILE_CHANGED") {
        const latest = await api<FileSnapshot>(
          `${url}?op=read&path=${encodeURIComponent(path)}`,
        ).catch(() => null);
        if (active.current) setConflict(latest);
      }
    } finally {
      saving.current = false;
      if (active.current) {
        persist();
        setBusy(false);
      }
    }
  };
  saveAction.current = () => {
    void save();
  };
  // The editor instance belongs to exactly one project/path; parent keys this component accordingly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Data and CodeMirror lifetime are scoped to this mounted file.
  useEffect(() => {
    active.current = true;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async (): Promise<FileSnapshot> => {
      if (!copy)
        return api<FileSnapshot>(`${url}?op=read&path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
        });
      const bytes = await copy.file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0"))
        throw Error("Это двоичный файл, текстовый редактор его не изменяет.");
      const fingerprint = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      return {
        path,
        kind: "file",
        size: copy.file.size,
        fingerprint,
        text,
        checkout: copy.source,
        bom: new Uint8Array(bytes).slice(0, 3).join(",") === "239,187,191",
      };
    };
    void read()
      .then(async (snapshot) => {
        if (!alive || !host.current) return;
        let text = snapshot.text ?? "";
        baseline.current = snapshot;
        try {
          const draft = JSON.parse((await storage.getItem(key)) ?? "null");
          if (
            draft?.baseline?.path === path &&
            draft.baseline.checkout === snapshot.checkout &&
            typeof draft.text === "string" &&
            /^[a-f0-9]{64}$/.test(draft.baseline.fingerprint)
          ) {
            baseline.current = draft.baseline;
            text = draft.text;
            pending.current = draft.pending?.text !== undefined ? draft.pending : null;
            if (draft.baseline.fingerprint !== snapshot.fingerprint) setConflict(snapshot);
          }
        } catch {}
        if (!alive || !host.current) return;
        // A changed disk version must not change the restored draft's line endings.
        lineSeparator.current = separatorOf(baseline.current?.text ?? "");
        separatorOf(text);
        const view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              keymap.of([
                indentWithTab,
                {
                  key: "Mod-s",
                  run: () => {
                    saveAction.current();
                    return true;
                  },
                },
              ]),
              basicSetup,
              endings.current.of(EditorState.lineSeparator.of(lineSeparator.current)),
              EditorView.contentAttributes.of({
                "aria-label": "Содержимое файла",
                spellcheck: "false",
                autocapitalize: "off",
                autocorrect: "off",
              }),
              wrapping.current.of([]),
              syntax.current.of([]),
              syntaxHighlighting(
                HighlightStyle.define([
                  { tag: [tags.keyword, tags.operator], color: "var(--accent)" },
                  {
                    tag: [tags.string, tags.number, tags.bool],
                    color: "var(--ink)",
                    fontWeight: "600",
                  },
                  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
                  {
                    tag: [tags.typeName, tags.function(tags.variableName)],
                    color: "var(--accent)",
                    fontWeight: "600",
                  },
                ]),
              ),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  setDirty(exactLines(update.state.sliceDoc()) !== baseline.current?.text);
                  clearTimeout(timer);
                  timer = setTimeout(persist, 350);
                }
              }),
            ],
          }),
        });
        editor.current = view;
        setLoaded(true);
        setDirty(text !== baseline.current?.text);
        const lang = LanguageDescription.matchFilename(languages, path);
        if (lang)
          void lang
            .load()
            .then((extension) => {
              if (alive) view.dispatch({ effects: syntax.current.reconfigure(extension) });
            })
            .catch(() => {});
      })
      .catch((e) => {
        if (alive && !controller.signal.aborted) setError(messageOf(e));
      });
    const leave = (event: BeforeUnloadEvent) => {
      if (baseline.current && (current() !== baseline.current.text || pending.current)) {
        persist();
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", persist);
    return () => {
      alive = false;
      active.current = false;
      controller.abort();
      clearTimeout(timer);
      persist();
      editor.current?.destroy();
      editor.current = null;
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", persist);
    };
  }, []);
  const close = () => {
    if (saving.current) return;
    if (dirty || pending.current) setClosing(true);
    else onClose();
  };
  return createPortal(
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="workspace-window file-editor"
      data-help-context="editor"
      aria-label={`Редактор ${path}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <header className="panel-heading">
        <Icon name="file" />
        <div>
          <strong title={path}>
            {path}
            {dirty ? " *" : ""}
          </strong>
          <small>{copy ? "Редактируемая копия" : `${projectName} · Рабочая копия`}</small>
        </div>
        <HelpButton topic="editor" />
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть редактор"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="file-editor-toolbar">
        <div className="file-editor-primary-actions">
          <button
            type="button"
            className="primary"
            disabled={!loaded || (!copy && !dirty && !pending.current) || busy}
            onClick={() => void save()}
          >
            {busy
              ? "Сохраняю…"
              : reviewSave
                ? "Проверить изменения"
                : copy
                  ? "Сохранить как…"
                  : "Сохранить"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!loaded}
            onClick={() => {
              setPreview(
                new File(
                  [baseline.current?.bom ? "\ufeff" : "", current()],
                  path.split("/").at(-1) || path,
                  { type: "text/plain" },
                ),
              );
            }}
          >
            Предпросмотр
          </button>
        </div>
        <div className="file-editor-text-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Отменить изменение"
            onClick={() => editor.current && undo(editor.current)}
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Повторить изменение"
            onClick={() => editor.current && redo(editor.current)}
          >
            <Icon name="chevron" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Найти в файле"
            onClick={() => editor.current && openSearchPanel(editor.current)}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={wrap}
            onClick={() => {
              setWrap(!wrap);
              editor.current?.dispatch({
                effects: wrapping.current.reconfigure(wrap ? [] : EditorView.lineWrapping),
              });
            }}
          >
            Перенос строк
          </button>
        </div>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <details className="file-editor-conflict" open>
          <summary>Текущая версия на компьютере</summary>
          <pre>{conflict.text}</pre>
          <div className="file-editor-conflict-actions">
            <button
              type="button"
              className="secondary"
              aria-label="Я сравнил — сохранить мой текст при следующем сохранении"
              disabled={!!pending.current}
              onClick={() => {
                baseline.current = conflict;
                pending.current = null;
                setConflict(null);
                setError("");
                setDirty(current() !== conflict.text);
                persist();
              }}
            >
              Оставить мой текст
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!pending.current}
              onClick={() => {
                if (!confirm("Заменить черновик текущей версией файла?")) return;
                let separator: string;
                try {
                  separator = separatorOf(conflict.text ?? "");
                } catch (e) {
                  setError(messageOf(e));
                  return;
                }
                lineSeparator.current = separator;
                baseline.current = conflict;
                editor.current?.dispatch({
                  effects: endings.current.reconfigure(EditorState.lineSeparator.of(separator)),
                  changes: {
                    from: 0,
                    to: editor.current.state.doc.length,
                    insert: conflict.text ?? "",
                  },
                });
                setDirty(false);
                setConflict(null);
                setError("");
                persist();
              }}
            >
              Загрузить текущую версию
            </button>
          </div>
        </details>
      )}
      {!loaded && !error && <p role="status">Открываю файл…</p>}
      <div className="file-editor-host" ref={host} />
      {closing && (
        <div className="file-editor-close" role="alert">
          <p>Сохранить изменения перед закрытием?</p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={async () => {
              await save();
              if (!pending.current && current() === baseline.current?.text) onClose();
            }}
          >
            Сохранить и закрыть
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!!pending.current}
            onClick={async () => {
              try {
                await storage.removeItem(key);
              } catch (e) {
                setError(messageOf(e));
                return;
              }
              baseline.current = null;
              onClose();
            }}
          >
            Не сохранять
          </button>
          <button type="button" className="secondary" onClick={() => setClosing(false)}>
            Продолжить редактирование
          </button>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              if (await persist()) onClose();
            }}
          >
            Закрыть с черновиком
          </button>
        </div>
      )}
      {copyToSave && (
        <FileCopySave
          file={copyToSave}
          onClose={() => setCopyToSave(null)}
          onSaved={async () => {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              await copyToSave.arrayBuffer(),
            );
            if (!active.current || !baseline.current) return;
            baseline.current = { ...baseline.current, text };
            setDirty(current() !== text);
            persist();
            setCopyToSave(null);
            if (closing && current() === text) onClose();
          }}
        />
      )}
      {preview && <FileEditorPreview file={preview} onClose={() => setPreview(null)} />}
    </dialog>,
    document.body,
  );
}
