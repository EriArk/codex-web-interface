import type {
  SharedExecution as Execution,
  SharedExecutionDetail,
  SharedItem,
  SharedProjectDetail,
} from "@codex-web/shared";
import { useEffect, useState } from "react";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { api } from "./api";
import { CopyButton } from "./CopyButton";
import { actionLabels } from "./ProjectAction";
import { useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";

export function SharedExecutionPanel({
  item,
  detail,
  dirty,
}: {
  item: SharedItem;
  detail: SharedProjectDetail;
  dirty: boolean;
}) {
  const base = "/team/projects/" + item.projectId + "/executions",
    key = "workspace-shared-execution:" + item.projectId + ":" + item.id;
  const [selected, setSelected] = useState(() => {
      try {
        return storage.getItem(key) ?? "";
      } catch {
        return "";
      }
    }),
    [tick, setTick] = useState(0);
  const { run, error, busy } = useSharedAction(),
    list = useSharedResource<{ items: Execution[] }>(base + "?itemId=" + item.id, tick),
    value = useSharedResource<SharedExecutionDetail>(selected ? base + "/" + selected : null, tick),
    execution = value.value?.execution,
    preview = value.value?.preview,
    live = list.value?.items.find((e) =>
      ["prepared", "queued", "dispatching", "running", "unknown"].includes(e.state),
    ),
    canPrepare =
      detail.project.role !== "viewer" &&
      !detail.project.archived &&
      item.assigneeId === pageWorkspace &&
      !dirty &&
      !live;
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  const select = (id: string) => {
    storage.setItem(key, id);
    setSelected(id);
    refresh();
  };
  const prepare = () =>
    void run(async () => {
      const id = live?.own ? live.id : crypto.randomUUID();
      select(id); // Identity survives acknowledgement loss, closing the sheet, and a reload.
      await api(base + "/" + id, {
        method: "PUT",
        body: { itemId: item.id, revision: item.revision },
      });
      return true;
    }).then((done) => {
      if (done) refresh();
    });
  const mutate = (action: "submit" | "cancel") =>
    void run(() =>
      api(base + "/" + selected + "/" + action, { method: "POST", body: { confirm: true } }),
    ).then(() => refresh());
  return (
    <section className="shared-execution shared-form" aria-label="Выполнение общего плана">
      <h3>Выполнение</h3>
      {error && <p role="alert">{error}</p>}
      {list.error && <p role="alert">{list.error}</p>}
      {dirty && <small>Сохрани правки и назначение перед запуском.</small>}
      {item.assigneeId !== pageWorkspace && (
        <small>Запускает назначенный исполнитель — в своём чате и рабочей папке.</small>
      )}
      <button type="button" className="primary" disabled={busy || !canPrepare} onClick={prepare}>
        Подготовить выполнение
      </button>
      {list.value?.items.map((e) => (
        <button
          type="button"
          key={e.id}
          className="secondary shared-run-row"
          aria-pressed={selected === e.id}
          onClick={() =>
            void run(async () => {
              select(e.id);
            })
          }
        >
          <span>
            {e.userName} · Версия {e.itemRevision}
          </span>
          <strong>{actionLabels[e.state]}</strong>
        </button>
      ))}
      {selected && value.error && (
        <div className="shared-warning">
          <p role="alert">{value.error}</p>
          <button type="button" className="secondary" disabled={busy} onClick={refresh}>
            Проверить запуск
          </button>
        </div>
      )}
      {execution && (
        <div className="shared-warning" data-state={execution.state}>
          <strong>{actionLabels[execution.state]}</strong>
          {execution.state === "queued" && (
            <p>Ждём свободного чата. Перед отправкой снова проверим назначение и доступ.</p>
          )}
          {execution.state === "unknown" && (
            <p>Исход нужно проверить в чате исполнителя. Повторной отправки не будет.</p>
          )}
          {value.value?.problem && <p role="alert">{value.value.problem}</p>}
          {preview && (
            <>
              <p>
                Мой проект: {preview.scope.name}
                <br />
                Режим: Работа · {preview.settings?.model} · {preview.settings?.effort}
              </p>
              <details>
                <summary>Текст задания и согласованная основа</summary>
                <pre className="shared-run-prompt">{preview.text}</pre>
                <CopyButton text={preview.text} />
              </details>
              {preview.threadId && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("open-delivery-target", {
                        detail: {
                          client: "codex",
                          kind: "thread",
                          id: preview.threadId,
                          threadId: preview.threadId,
                          projectId: preview.scope.projectId,
                          title: preview.title,
                          turnId: preview.turnId,
                        },
                      }),
                    )
                  }
                >
                  Открыть мой чат
                </button>
              )}
            </>
          )}
          {execution.own && (
            <div className="shared-actions">
              {execution.state === "prepared" && !execution.ready && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api(base + "/" + selected, {
                        method: "PUT",
                        body: { itemId: item.id, revision: execution.itemRevision },
                      }),
                    ).then(() => refresh())
                  }
                >
                  Продолжить подготовку
                </button>
              )}
              {execution.state === "prepared" && execution.ready && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || dirty}
                  onClick={() => mutate("submit")}
                >
                  Подтвердить и выполнить
                </button>
              )}
              {["prepared", "queued", "blocked"].includes(execution.state) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => mutate("cancel")}
                >
                  Отменить запуск
                </button>
              )}
              <button type="button" className="secondary" disabled={busy} onClick={refresh}>
                Обновить состояние
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
