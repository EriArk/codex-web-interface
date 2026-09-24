import type { GptFile } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { pageWorkspace } from "./accountStorage";
import { api, messageOf } from "./api";

/** A selected reference waits beside this exact chat's draft. It never submits a native turn. */
export function GptResultHandoffs({
  threadId,
  files,
  disabled,
  onAttach,
}: {
  threadId: string;
  files: GptFile[];
  disabled: boolean;
  onAttach: (file: GptFile) => void;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [items, setItems] = useState<{ id: string; title: string; sha256: string }[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pageWorkspace || !threadId) return;
    let live = true;
    const refresh = () => {
      if (!document.hidden)
        void api<{ items: typeof items }>(
          "/team/result-handoffs?" + new URLSearchParams({ threadId }),
        )
          .then((r) => {
            if (live) setItems(r.items);
          })
          .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [threadId]);
  if (!items.length) return null;
  return (
    <div className="gpt-result-handoffs">
      {error && <p role="alert">{error}</p>}
      {items.map((item) => (
        <div key={item.id}>
          <span>{item.title}</span>
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy || files.some((f) => f.id === item.id)}
            onClick={() => {
              setBusy(true);
              setError("");
              void api<{ file: GptFile }>(`/team/result-handoffs/${item.id}/attachment`, {
                method: "POST",
              })
                .then((r) => {
                  if (alive.current) onAttach(r.file);
                })
                .catch((e) => setError(messageOf(e)))
                .finally(() => setBusy(false));
            }}
          >
            {files.some((f) => f.id === item.id) ? "В черновике" : "Прикрепить Result"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void api(`/team/result-handoffs/${item.id}`, { method: "DELETE" })
                .then(() => setItems((old) => old.filter((v) => v.id !== item.id)))
                .catch((e) => setError(messageOf(e)))
            }
          >
            Скрыть
          </button>
        </div>
      ))}
    </div>
  );
}
