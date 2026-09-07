import type { GptConnection, StorageReport } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api } from "./api";

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
      {(report.missingFiles > 0 || report.partial || connection?.storage?.partial) && (
        <p>Учёт файлов требует проверки.</p>
      )}
    </details>
  );
}
