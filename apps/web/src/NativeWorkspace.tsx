import type { NativeWorkspaceReceipt } from "@codex-web/shared";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import "./native-workspace.css";
export function NativeWorkspaceDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      dialog.current?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="notebook-dialog native-workspace-dialog"
      aria-label={title}
      onCancel={onClose}
    >
      <header className="notebook-heading">
        <Icon name="history" />
        <strong>{title}</strong>
        <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
export function WorkspaceReceipts({
  revision,
  onSettled,
}: {
  revision: number;
  onSettled: () => void;
}) {
  const [items, setItems] = useState<NativeWorkspaceReceipt[]>([]),
    [error, setError] = useState("");
  const callback = useRef(onSettled);
  callback.current = onSettled;
  const seen = useRef(new Map<string, string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and completed receipts revalidate this view.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await api<{ items: NativeWorkspaceReceipt[] }>("/gpt/workspace-operations", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setItems(next.items);
        for (const op of next.items) {
          const old = seen.current.get(op.id);
          if (old && old !== op.state && ["completed", "failed"].includes(op.state))
            callback.current();
          seen.current.set(op.id, op.state);
        }
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError(messageOf(e));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 2500);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision]);
  const act = async (id: string, checked = false) => {
    try {
      await api(`/gpt/workspace-operations/${id}/${checked ? "checked" : "check"}`, {
        method: "POST",
        body: checked ? { confirm: true } : undefined,
      });
      callback.current();
      setItems((v) => v.filter((i) => i.id !== id));
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <div className="native-receipts" aria-live="polite">
      {error && <p role="alert">{error}</p>}
      {items
        .filter((i) => ["pending", "unknown"].includes(i.state))
        .map((op) => (
          <div key={op.id} className="native-receipt">
            <p>
              {op.kind === "schedule" ? "Расписание" : "Canvas"}:{" "}
              {op.error || "Проверяем изменение…"}
            </p>
            {op.state === "unknown" && (
              <>
                <button type="button" className="secondary" onClick={() => void act(op.id)}>
                  Проверить результат
                </button>
                <details>
                  <summary>Результат проверен вручную</summary>
                  <p>Убедись, что текущее состояние верное. Повторной отправки не будет.</p>
                  <button type="button" className="secondary" onClick={() => void act(op.id, true)}>
                    Подтверждаю проверку
                  </button>
                </details>
              </>
            )}
          </div>
        ))}
    </div>
  );
}
export function useWorkspaceMutation(onSettled: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const mutate = async (input: unknown, storageKey: string) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const raw = localStorage.getItem(storageKey + ":operation");
      let saved: { id: string; input: unknown } | null = raw ? JSON.parse(raw) : null;
      if (saved) {
        try {
          const receipt = await api<NativeWorkspaceReceipt>(
            `/gpt/workspace-operations/${saved.id}`,
          );
          if (["completed", "failed"].includes(receipt.state)) {
            localStorage.removeItem(storageKey + ":operation");
            saved = null;
            if (receipt.state === "completed") {
              localStorage.removeItem(storageKey);
              onSettled();
              return true;
            }
          }
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      if (saved && JSON.stringify(saved.input) !== JSON.stringify(input))
        throw Error("Предыдущее изменение ещё не проверено. Сначала проверь его результат.");
      saved ??= { id: crypto.randomUUID(), input };
      localStorage.setItem(storageKey + ":operation", JSON.stringify(saved));
      try {
        await api("/gpt/workspace-operations", {
          method: "POST",
          key: saved.id,
          body: saved.input,
        });
      } catch (e) {
        if (
          e instanceof ApiError &&
          [400, 409].includes(e.status) &&
          e.code !== "IDEMPOTENCY_CONFLICT"
        )
          localStorage.removeItem(storageKey + ":operation");
        throw e;
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!alive.current) return false;
        const receipt = await api<NativeWorkspaceReceipt>(`/gpt/workspace-operations/${saved.id}`);
        if (receipt.state === "completed" || receipt.state === "failed") {
          localStorage.removeItem(storageKey + ":operation");
          if (receipt.state === "failed") throw Error(receipt.error);
          localStorage.removeItem(storageKey);
          onSettled();
          return true;
        }
        if (receipt.state === "unknown") throw Error(receipt.error);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      onSettled();
      throw Error("Изменение проверяется. Состояние доступно в панели выше.");
    } catch (e) {
      if (alive.current) setError(messageOf(e));
      onSettled();
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { busy, error, mutate };
}
