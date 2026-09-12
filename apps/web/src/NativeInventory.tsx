import type { NativeInventory as Inventory } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "./api";

export function NativeInventory({ projectId, visible }: { projectId: string; visible: boolean }) {
  const [open, setOpen] = useState(false),
    [value, setValue] = useState<Inventory | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry repeats the same bounded inventory read.
  useEffect(() => {
    setValue(null);
    setError("");
    if (!open || !visible || !projectId) return;
    const controller = new AbortController();
    void api<Inventory>(`/projects/${encodeURIComponent(projectId)}/native-inventory`, {
      signal: controller.signal,
      timeoutMs: 60000,
    })
      .then((data) => {
        if (!controller.signal.aborted) setValue(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [projectId, open, visible, retry]);
  if (!projectId) return null;
  return (
    <details className="native-inventory" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Навыки, плагины и инструменты проекта</summary>
      {error ? (
        <p role="status">{error}</p>
      ) : !value ? (
        <p>Загружаем возможности Codex…</p>
      ) : (
        <>
          {value.groups.map((group) => (
            <section key={group.kind}>
              <h3>
                {
                  { skills: "Навыки", plugins: "Установленные плагины", mcp: "MCP-серверы" }[
                    group.kind
                  ]
                }
              </h3>
              {!group.available ? (
                <p>Этот список недоступен в текущем Codex.</p>
              ) : !group.items.length ? (
                <p>Список пуст.</p>
              ) : (
                <ul>
                  {group.items.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Native inventory can contain duplicate names; this static snapshot has no per-row state.
                    <li key={item.name + index}>
                      <strong>{item.name}</strong>
                      <span className="muted">{item.state}</span>
                      {item.description && <p>{item.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {group.more && <small>Показана первая часть списка.</small>}
            </section>
          ))}
          {!!value.unsupportedTools.length && (
            <section>
              <h3>Запрошены, но не подключены к веб-клиенту</h3>
              <ul>
                {value.unsupportedTools.map((tool) => (
                  <li key={tool.name}>
                    {tool.name} · {tool.count}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <button type="button" className="secondary" onClick={() => setRetry((v) => v + 1)}>
        Обновить список
      </button>
    </details>
  );
}
