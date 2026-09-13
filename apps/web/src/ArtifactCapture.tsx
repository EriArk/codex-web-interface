import { useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
export function ArtifactCapture({
  id,
  status,
  onComplete,
  message,
}: {
  id: string;
  status: string;
  onComplete?: () => void;
  message?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="artifact-capture">
      <p className="small muted">
        {busy || status === "capturing" ? "Сохраняем файл…" : message || "Файл не сохранён."}
      </p>
      {error && <p role="alert">{error}</p>}
      {status !== "capturing" && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void api<{ status: string }>(`/artifact-captures/${id}/retry`, {
              method: "POST",
              timeoutMs: 60000,
            })
              .then((result) => {
                if (result.status === "failed")
                  setError("Файл недоступен или не помещается в хранилище.");
                onComplete?.();
              })
              .catch((e) => setError(messageOf(e)))
              .finally(() => setBusy(false));
          }}
        >
          <Icon name="refresh" />
          Сохранить текущую версию
        </button>
      )}
    </div>
  );
}
