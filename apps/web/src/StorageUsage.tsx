import type { GptConnection, StagingInventory, StorageReport } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "./api";

const labels: Record<string, string> = {
  database: "База и переписка",
  artifacts: "Изображения",
  uploads: "Вложения Codex",
  gpt: "Вложения GPT",
  previews: "Демо",
  "local-staging": "Рабочие копии на сервере",
  "windows-staging": "Рабочие копии на компьютере",
};
function size(bytes: number) {
  return bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toFixed(1) + " ГБ"
    : bytes >= 1024 ** 2
      ? Math.ceil(bytes / 1024 ** 2) + " МБ"
      : Math.ceil(bytes / 1024) + " КБ";
}
export function StorageUsage({ visible }: { visible: boolean }) {
  const [report, setReport] = useState<StorageReport | null>(null),
    [connection, setConnection] = useState<GptConnection | null>(null);
  const [staging, setStaging] =
      useState<{ id: string; name: string; available: boolean; inventory?: StagingInventory }[]>(),
    [checking, setChecking] = useState(false),
    [stagingError, setStagingError] = useState("");
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    void api<StorageReport>("/storage")
      .then((value) => {
        if (!disposed) setReport(value);
      })
      .catch(() => {});
    void api<GptConnection>("/gpt/status")
      .then((value) => {
        if (!disposed) setConnection(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [visible]);
  if (!report) return null;
  return (
    <details className="storage-usage">
      <summary>Хранилище</summary>
      <dl>
        {report.buckets
          .filter((bucket) => bucket.bytes > 0 || bucket.id === "database")
          .map((bucket) => (
            <div key={bucket.id}>
              <dt>{labels[bucket.id] ?? bucket.id}</dt>
              <dd className={bucket.warning ? "danger" : undefined}>
                {bucket.estimated ? "≈ " : ""}
                {size(bucket.bytes)}
                {bucket.id !== "database" && bucket.limit && bucket.warning
                  ? " / " + size(bucket.limit)
                  : ""}
              </dd>
            </div>
          ))}
        {connection?.storage && (
          <>
            <div>
              <dt>Передача файлов GPT</dt>
              <dd>{size(connection.storage.uploadBytes)}</dd>
            </div>
            <div>
              <dt>Сохранённые файлы GPT</dt>
              <dd>{size(connection.storage.artifactBytes)}</dd>
            </div>
          </>
        )}
      </dl>
      <button
        type="button"
        className="secondary"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          setStagingError("");
          void api<{ machines: NonNullable<typeof staging> }>("/storage/staging", {
            timeoutMs: 180000,
          })
            .then((value) => {
              setStaging(value.machines);
              if (
                value.machines.length &&
                value.machines.every((m) => m.available && m.inventory && !m.inventory.partial)
              )
                setReport((old) =>
                  old
                    ? {
                        ...old,
                        buckets: old.buckets.map((b) =>
                          b.id === "windows-staging"
                            ? {
                                ...b,
                                bytes: value.machines.reduce((n, m) => n + m.inventory!.bytes, 0),
                                estimated: false,
                              }
                            : b,
                        ),
                      }
                    : old,
                );
            })
            .catch((e) => setStagingError(messageOf(e)))
            .finally(() => setChecking(false));
        }}
      >
        {checking ? "Проверяем копии…" : "Проверить копии на компьютере"}
      </button>
      {stagingError && <p role="alert">{stagingError}</p>}
      {staging?.map((machine) => (
        <div key={machine.id}>
          <strong>{machine.name}</strong>
          {!machine.available ? (
            <p>Компьютер пока недоступен.</p>
          ) : (
            <dl>
              <div>
                <dt>Рабочие копии · {machine.inventory!.files}</dt>
                <dd>{size(machine.inventory!.bytes)}</dd>
              </div>
              {machine.inventory!.temporaryFiles > 0 && (
                <div>
                  <dt>Незавершённые передачи · {machine.inventory!.temporaryFiles}</dt>
                  <dd>{size(machine.inventory!.temporaryBytes)}</dd>
                </div>
              )}
              {machine.inventory!.previewBytes > 0 && (
                <div>
                  <dt>Передача снимков приложений</dt>
                  <dd>{size(machine.inventory!.previewBytes)}</dd>
                </div>
              )}
            </dl>
          )}
          {machine.inventory?.partial && <p>Показана доступная часть хранилища.</p>}
        </div>
      ))}
      {(report.missingFiles > 0 ||
        !!report.metadataGaps ||
        report.partial ||
        connection?.storage?.partial) && <p>Учёт файлов требует проверки.</p>}
    </details>
  );
}
