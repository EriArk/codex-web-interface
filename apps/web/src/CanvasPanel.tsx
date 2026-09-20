import type { GptCanvas } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { NativeWorkspaceDialog, useWorkspaceMutation, WorkspaceReceipts } from "./NativeWorkspace";
export default function CanvasPanel({
  conversationId,
  documentId = "",
  onClose,
}: {
  conversationId: string;
  documentId?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<GptCanvas[]>([]),
    [selected, setSelected] = useState(documentId),
    [view, setView] = useState<GptCanvas | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [requestedVersion, setRequestedVersion] = useState(1),
    [confirm, setConfirm] = useState(false);
  const versionRead = useRef(0);
  const changed = useCallback(() => setRevision((v) => v + 1), []),
    mutation = useWorkspaceMutation(changed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and completed receipts revalidate this view.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api<{ items: GptCanvas[] }>(
      "/gpt/canvas?conversationId=" + encodeURIComponent(conversationId),
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          setItems(r.items);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      versionRead.current++;
    };
  }, [conversationId, revision]);
  const current = items.find((c) => c.id === selected);
  useEffect(() => {
    versionRead.current++;
    setView(current ?? null);
    setRequestedVersion(current?.version ?? 1);
    setConfirm(false);
  }, [current]);
  const read = async () => {
    if (!current) return;
    const serial = ++versionRead.current;
    setError("");
    try {
      const next = await api<GptCanvas>(
        `/gpt/canvas/version?conversationId=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(current.id)}&version=${requestedVersion}`,
      );
      if (serial === versionRead.current) setView(next);
    } catch (e) {
      if (serial === versionRead.current) setError(messageOf(e));
    }
  };
  const restore = async () => {
    if (!current || !view || view.version >= current.version) return;
    await mutation.mutate(
      {
        kind: "canvas",
        action: "restore",
        conversationId,
        id: current.id,
        revision: current.revision,
        version: view.version,
        confirm: true,
      },
      "native-canvas:" + current.id,
    );
    setConfirm(false);
  };
  return (
    <NativeWorkspaceDialog title="Canvas этого чата" onClose={onClose}>
      <div className="native-toolbar">
        <span>Документы ChatGPT</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить Canvas"
          onClick={changed}
          disabled={loading}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <WorkspaceReceipts revision={revision} onSettled={changed} />
      {(error || mutation.error) && <p role="alert">{error || mutation.error}</p>}
      <div className="native-workspace-layout" data-selected={!!current}>
        <aside className="native-workspace-list" aria-label="Документы Canvas">
          {loading && <p role="status">Загружаем документы…</p>}
          {!loading && !error && !items.length && <p>В этом чате нет сохранённых Canvas.</p>}
          {items.map((c) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={selected === c.id}
              onClick={() => setSelected(c.id)}
            >
              <strong>{c.title}</strong>
              <small>
                Версия {c.version} · {c.type}
              </small>
            </button>
          ))}
        </aside>
        <section className="native-workspace-editor">
          {current && view ? (
            <>
              <button
                type="button"
                className="secondary native-mobile-back"
                onClick={() => setSelected("")}
              >
                <Icon name="back" />
                Все документы
              </button>
              <h3>{current.title}</h3>
              <p className="native-caption">
                Версия {view.version} из {current.version}. Текущая версия сохранена в ChatGPT.
              </p>
              <div className="native-form-row">
                <label>
                  Версия
                  <input
                    type="number"
                    min={1}
                    max={current.version}
                    value={requestedVersion}
                    onChange={(e) => setRequestedVersion(Number(e.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    requestedVersion < 1 ||
                    requestedVersion > current.version ||
                    !Number.isInteger(requestedVersion)
                  }
                  onClick={() => void read()}
                >
                  Показать версию
                </button>
              </div>
              <footer>
                <CopyButton text={view.content} label="Скопировать документ" />
                {view.version < current.version && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={mutation.busy}
                    onClick={() => setConfirm(true)}
                  >
                    Восстановить эту версию
                  </button>
                )}
              </footer>
              {confirm && (
                <fieldset aria-label="Подтвердить восстановление">
                  <p>
                    Сделать версию {view.version} текущей для «{current.title}»? Прежние версии
                    сохранятся.
                  </p>
                  <button
                    type="button"
                    className="primary"
                    disabled={mutation.busy}
                    onClick={() => void restore()}
                  >
                    Да, восстановить
                  </button>
                  <button type="button" className="secondary" onClick={() => setConfirm(false)}>
                    Отмена
                  </button>
                </fieldset>
              )}
              <pre>{view.content}</pre>
            </>
          ) : (
            <div className="native-empty">
              <h3>Сохранённые документы и версии</h3>
              <p>Выбери документ для чтения, копирования или возврата к прежней версии.</p>
              <p className="native-caption">
                Создание и прямое редактирование Canvas пока не подтверждены в текущем ChatGPT.
                Сохранённые документы остаются доступными.
              </p>
            </div>
          )}
        </section>
      </div>
    </NativeWorkspaceDialog>
  );
}
