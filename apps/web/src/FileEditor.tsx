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
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./file-editor.css";

export default function FileEditor({
  projectId,
  capability,
  projectName,
  path,
  onClose,
  onSaved,
}: {
  projectId: string;
  capability: string;
  projectName: string;
  path: string;
  onClose: () => void;
  onSaved: () => void;
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
    [conflict, setConflict] = useState<FileSnapshot | null>(null);
  const wrapping = useRef(new Compartment()),
    syntax = useRef(new Compartment());
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
  const key = `workspace-file-draft:${projectId}:${path}`,
    url = `/projects/${encodeURIComponent(projectId)}/file-tools`;
  const exactLines = (text: string) => text.replace(/\r\n|\r|\n/g, lineSeparator.current);
  const current = () => exactLines(editor.current?.state.sliceDoc() ?? "");
  const persist = () => {
    if (!baseline.current || !editor.current) return;
    try {
      if (current() === baseline.current.text && !pending.current) storage.removeItem(key);
      else
        storage.setItem(
          key,
          JSON.stringify({ baseline: baseline.current, text: current(), pending: pending.current }),
        );
    } catch {
      if (active.current)
        setError(
          "Не удалось сохранить черновик на устройстве. Не закрывай редактор до сохранения файла.",
        );
    }
  };
  const save = async () => {
    const base = baseline.current;
    if (!base || !editor.current || saving.current || (current() === base.text && !pending.current))
      return;
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
    persist();
    try {
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
      baseline.current = { ...result, text, bom: base.bom };
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
      if (active.current) setBusy(false);
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
    void api<FileSnapshot>(`${url}?op=read&path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then((snapshot) => {
        if (!alive || !host.current) return;
        let text = snapshot.text ?? "";
        const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
        if (endings.size > 1)
          throw Error(
            "В файле смешаны окончания строк. Доступен просмотр или скачивание; редактор не будет менять их автоматически.",
          );
        lineSeparator.current = snapshot.text?.match(/\r\n|\r|\n/)?.[0] ?? "\n";
        baseline.current = snapshot;
        try {
          const draft = JSON.parse(storage.getItem(key) ?? "null");
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
              EditorState.lineSeparator.of(snapshot.text?.match(/\r\n|\r|\n/)?.[0] ?? "\n"),
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
      if (baseline.current && current() !== baseline.current.text) {
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
    if (dirty) setClosing(true);
    else onClose();
  };
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="workspace-window file-editor"
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
          <strong>
            {path}
            {dirty ? " *" : ""}
          </strong>
          <small>{projectName} · Рабочая копия</small>
        </div>
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
        <button
          type="button"
          className="primary"
          disabled={!loaded || (!dirty && !pending.current) || busy}
          onClick={() => void save()}
        >
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
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
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <details className="file-editor-conflict" open>
          <summary>Текущая версия на компьютере</summary>
          <pre>{conflict.text}</pre>
          <button
            type="button"
            className="secondary"
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
            Я сравнил — сохранить мой текст при следующем сохранении
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!!pending.current}
            onClick={() => {
              if (!confirm("Заменить черновик текущей версией файла?")) return;
              baseline.current = conflict;
              editor.current?.dispatch({
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
              if (current() === baseline.current?.text) onClose();
            }}
          >
            Сохранить и закрыть
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!!pending.current}
            onClick={() => {
              storage.removeItem(key);
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
            onClick={() => {
              persist();
              onClose();
            }}
          >
            Закрыть с черновиком
          </button>
        </div>
      )}
    </dialog>
  );
}
