import type { GptMessage, GptOperation } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { GptVersions } from "./GptVersions";
import { Icon } from "./icons";
import "./quick-capture.css";

type Draft = {
  id: string;
  nativeId: string;
  messageId: string;
  currentNode: string;
  targetMessageId?: string;
  action: "edit" | "regenerate" | "fork";
  text: string;
  model: string;
  effort: string;
  submitted: boolean;
};
const key = (nativeId: string, messageId: string, targetMessageId?: string) =>
  `gpt-edit:${nativeId}:${messageId}${targetMessageId ? ":fork:" + targetMessageId : ""}`;
const pending = (op: GptOperation) => ["preparing", "running", "unknown"].includes(op.state);
function Editor({
  draft: initial,
  onClose,
  onSent,
  onVersions,
}: {
  draft: Draft;
  onClose: () => void;
  onSent: () => void;
  onVersions: () => void;
}) {
  const [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    sending = useRef(false);
  const save = (value: Draft) => {
    setDraft(value);
    try {
      localStorage.setItem(
        key(value.nativeId, value.messageId, value.targetMessageId),
        JSON.stringify(value),
      );
    } catch {}
  };
  useEffect(() => {
    alive.current = true;
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      dialog.current?.close();
      focus?.focus({ preventScroll: true });
    };
  }, []);
  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const next = { ...draft, submitted: true };
    save(next);
    try {
      const { id, submitted: _submitted, ...body } = next;
      await api("/gpt/native-operations", { method: "POST", key: id, body });
      if (alive.current) {
        onSent();
        onClose();
      }
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="quick-capture-dialog gpt-native-editor"
      tabIndex={-1}
      aria-label={
        draft.action === "fork"
          ? "Продолжить версию GPT"
          : draft.action === "edit"
            ? "Изменить сообщение GPT"
            : "Повторить ответ GPT"
      }
      onCancel={onClose}
    >
      <header>
        <Icon
          name={draft.action === "fork" ? "branch" : draft.action === "edit" ? "edit" : "refresh"}
        />
        <h2>
          {draft.action === "fork"
            ? "Продолжить версию"
            : draft.action === "edit"
              ? "Изменить сообщение"
              : "Повторить ответ"}
        </h2>
        <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="quick-capture-content">
        <p>
          {draft.action === "fork"
            ? "Напиши первое сообщение отдельного чата. ChatGPT сохранит контекст выбранной версии; исходный диалог останется на месте."
            : draft.action === "edit"
              ? "Отправка создаст новую ветку ChatGPT. Прежние сообщения сохранятся; вложения останутся у запроса."
              : "ChatGPT создаст новый вариант этого ответа той же моделью. Исходный вариант сохранится."}
        </p>
        {draft.action !== "regenerate" && (
          <textarea
            aria-label={
              draft.action === "fork" ? "Первое сообщение новой ветки" : "Изменённое сообщение"
            }
            value={draft.text}
            disabled={draft.submitted}
            maxLength={100000}
            onChange={(e) => save({ ...draft, text: e.target.value })}
          />
        )}
        {!draft.submitted && draft.action !== "fork" && (
          <button type="button" className="secondary" onClick={onVersions}>
            <Icon name="history" /> Версии сообщения
          </button>
        )}
        {draft.submitted && (
          <p>
            Действие сохранено. Повторная проверка использует тот же номер и не создаёт вторую
            отправку.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="secondary" onClick={onClose}>
            Закрыть
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || (draft.action !== "regenerate" && !draft.text.trim())}
            onClick={() => void send()}
          >
            {busy
              ? "Проверяем…"
              : draft.submitted
                ? "Проверить отправку"
                : draft.action === "fork"
                  ? "Создать чат и отправить"
                  : draft.action === "edit"
                    ? "Сохранить и отправить"
                    : "Повторить ответ"}
          </button>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}

export function useGptNativeOperations(
  nativeId: string,
  settings: { model: string; effort: string },
  onChanged: (id: string) => void,
  onOpen: (id: string) => void,
) {
  const [ops, setOps] = useState<GptOperation[]>([]),
    [blocked, setBlocked] = useState(false),
    [draft, setDraft] = useState<Draft | null>(null),
    [error, setError] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Draft | null>(null);
  const alive = useRef(true),
    version = useRef(0),
    change = useRef(onChanged),
    previous = useRef(new Map<string, string>());
  change.current = onChanged;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation invalidates dialogs and late reads even when their bodies use refs.
  useEffect(() => {
    version.current++;
    setDraft(null);
    setVersions(null);
    setError("");
  }, [nativeId]);
  const refresh = useCallback(async () => {
    const data = await api<{ items: GptOperation[]; blocked: boolean }>("/gpt/native-operations");
    if (!alive.current) return;
    setOps(data.items);
    setBlocked(data.blocked);
    for (const op of data.items) {
      const before = previous.current.get(op.id);
      if ((before !== undefined && before !== op.state) || op.state === "running")
        change.current(op.nativeId);
      previous.current.set(op.id, op.state);
      if (op.state === "completed") {
        try {
          localStorage.removeItem(key(op.nativeId, op.messageId, op.targetMessageId));
        } catch {}
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    let loading = false;
    const poll = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        await refresh();
      } catch {
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const open = async (message: GptMessage) => {
    const scope = nativeId,
      generation = version.current;
    setError("");
    try {
      let stored: Draft | null = null;
      try {
        stored = JSON.parse(localStorage.getItem(key(scope, message.id)) ?? "null");
      } catch {}
      const latest = ops.find((op) => op.nativeId === scope && op.messageId === message.id);
      if (
        stored?.submitted &&
        stored.nativeId === scope &&
        stored.messageId === message.id &&
        (!latest || pending(latest))
      ) {
        setDraft(stored);
        return;
      }
      const preview = await api<{ currentNode: string; message: GptMessage }>(
        `/gpt/conversations/${encodeURIComponent(scope)}/messages/${encodeURIComponent(message.id)}/action`,
      );
      if (!alive.current || version.current !== generation) return;
      setDraft({
        id: crypto.randomUUID(),
        nativeId: scope,
        messageId: message.id,
        currentNode: preview.currentNode,
        action: message.role === "user" ? "edit" : "regenerate",
        text: message.role === "user" ? (stored?.text ?? preview.message.text) : "",
        model: settings.model,
        effort: settings.effort,
        submitted: false,
      });
    } catch (e) {
      if (alive.current && version.current === generation) setError(messageOf(e));
    }
  };
  const check = async (op: GptOperation, checked = false) => {
    setError("");
    try {
      await api(`/gpt/native-operations/${op.id}/${checked ? "checked" : "check"}`, {
        method: "POST",
        body: checked ? { confirm: true } : {},
      });
      await refresh();
      change.current(op.nativeId);
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    }
  };
  const retry = async (op: GptOperation) => {
    if (op.action !== "fork")
      return open({
        id: op.messageId,
        role: op.action === "edit" ? "user" : "assistant",
        text: op.text,
        files: [],
        createdAt: 0,
      });
    const generation = version.current;
    try {
      const preview = await api<{ currentNode: string }>(
        `/gpt/conversations/${encodeURIComponent(op.nativeId)}/messages/${encodeURIComponent(op.messageId)}/versions?targetMessageId=${encodeURIComponent(op.targetMessageId ?? "")}`,
      );
      if (alive.current && generation === version.current)
        setDraft({
          id: crypto.randomUUID(),
          nativeId: op.nativeId,
          messageId: op.messageId,
          targetMessageId: op.targetMessageId,
          currentNode: preview.currentNode,
          action: "fork",
          text: op.text,
          model: settings.model,
          effort: settings.effort,
          submitted: false,
        });
    } catch (e) {
      if (alive.current && generation === version.current) setError(messageOf(e));
    }
  };
  const visible = ops.filter(
    (op) =>
      pending(op) ||
      (op.state === "failed" &&
        op.nativeId === nativeId &&
        !hidden.has(op.id) &&
        !ops.some(
          (next) =>
            next.nativeId === op.nativeId &&
            next.messageId === op.messageId &&
            next.createdAt > op.createdAt,
        )),
  );
  return {
    blocked,
    button: (message: GptMessage, busy: boolean) => (
      <button
        type="button"
        className="icon-button"
        disabled={blocked || busy || !settings.model || !!message.unsupported?.length}
        aria-label={message.role === "user" ? "Изменить сообщение GPT" : "Повторить ответ GPT"}
        onClick={() => void open(message)}
      >
        <Icon name={message.role === "user" ? "edit" : "refresh"} size={17} />
      </button>
    ),
    panel: (
      <>
        {error && (
          <p className="native-content-notice" role="alert">
            {error}
          </p>
        )}
        {visible.map((op) => (
          <div key={op.id} className="native-content-notice" role="status">
            <b>
              {op.action === "fork"
                ? "Новая ветка"
                : op.action === "edit"
                  ? "Изменение сообщения"
                  : "Новый вариант ответа"}
              {op.nativeId !== nativeId ? " · другой чат" : ""}
            </b>
            <p>
              {op.error ||
                (op.state === "preparing" ? "Открываем исходную ветку…" : "GPT готовит ответ…")}
            </p>
            {op.state === "unknown" && (
              <div className="command-log-actions">
                <button type="button" onClick={() => void check(op)}>
                  Проверить историю
                </button>
                <a
                  href={`https://chatgpt.com/c/${encodeURIComponent(op.nativeId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть ChatGPT
                </a>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Я проверил ветку ChatGPT. Разрешить новые действия без повторной отправки?",
                      )
                    )
                      void check(op, true);
                  }}
                >
                  Проверено вручную
                </button>
              </div>
            )}
            {op.state === "failed" && (
              <div className="command-log-actions">
                <button type="button" onClick={() => void retry(op)}>
                  Открыть действие
                </button>
                <button type="button" onClick={() => setHidden((old) => new Set([...old, op.id]))}>
                  Скрыть
                </button>
              </div>
            )}
          </div>
        ))}
        {ops
          .filter(
            (op) =>
              op.action === "fork" &&
              op.state === "completed" &&
              op.resultNativeId &&
              op.nativeId === nativeId &&
              !hidden.has(op.id),
          )
          .map((op) => (
            <div className="native-content-notice" key={op.id}>
              <p>Новая ветка готова.</p>
              <button
                type="button"
                className="secondary"
                onClick={() => onOpen(op.resultNativeId!)}
              >
                Открыть новую ветку
              </button>
              <button type="button" onClick={() => setHidden((old) => new Set([...old, op.id]))}>
                Скрыть
              </button>
            </div>
          ))}
        {draft && (
          <Editor
            key={draft.id}
            draft={draft}
            onVersions={() => {
              setVersions(draft);
              setDraft(null);
            }}
            onClose={() => setDraft(null)}
            onSent={() => {
              setBlocked(true);
              void refresh().catch(() => {});
            }}
          />
        )}
        {versions && (
          <GptVersions
            nativeId={versions.nativeId}
            messageId={versions.messageId}
            onClose={() => setVersions(null)}
            onContinue={(currentNode, targetMessageId) => {
              let stored: Draft | null = null;
              try {
                stored = JSON.parse(
                  localStorage.getItem(
                    key(versions.nativeId, versions.messageId, targetMessageId),
                  ) ?? "null",
                );
              } catch {}
              setDraft(
                stored?.submitted
                  ? stored
                  : {
                      ...versions,
                      id: crypto.randomUUID(),
                      action: "fork",
                      targetMessageId,
                      currentNode,
                      text: stored?.text ?? "",
                      submitted: false,
                    },
              );
              setVersions(null);
            }}
          />
        )}
      </>
    ),
  };
}
