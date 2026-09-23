import type {
  ProjectScope,
  SharedAsset,
  SharedMaterial,
  TaskProjectsPage,
} from "@codex-web/shared";
import { useState } from "react";
import { api } from "./api";
import { DownloadLink } from "./DownloadLink";
import { MaterialContent, materialLabels } from "./SharedMaterialEditor";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";

export function PersonalProjectPicker({
  value,
  onChange,
  codexOnly = false,
  disabled = false,
}: {
  value: ProjectScope | null;
  onChange: (value: ProjectScope) => void;
  codexOnly?: boolean;
  disabled?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const page = useSharedResource<TaskProjectsPage>(`/team/personal-projects?offset=${offset}`);
  return (
    <div className="shared-form">
      <label>
        {codexOnly ? "Мой проект Codex" : "Мой личный проект"}
        <select
          disabled={disabled}
          value={value ? value.client + ":" + value.projectId : ""}
          onChange={(e) => {
            const item = page.value?.items.find(
              (p) => p.scope.client + ":" + p.scope.projectId === e.target.value,
            );
            if (item) onChange(item.scope);
          }}
        >
          <option value="" disabled>
            Выбери проект
          </option>
          {value &&
            !page.value?.items.some(
              (p) => p.scope.client === value.client && p.scope.projectId === value.projectId,
            ) && (
              <option value={value.client + ":" + value.projectId}>
                {value.name} · {value.client === "codex" ? "Codex" : "GPT"}
              </option>
            )}
          {page.value?.items
            .filter((p) => !codexOnly || p.scope.client === "codex")
            .map((p) => (
              <option
                disabled={p.availability === "missing"}
                key={p.scope.client + ":" + p.scope.projectId}
                value={p.scope.client + ":" + p.scope.projectId}
              >
                {p.scope.name} · {p.scope.client === "codex" ? "Codex" : "GPT"}
                {p.availability === "missing" ? " · недоступен" : ""}
              </option>
            ))}
        </select>
      </label>
      {page.error && <p role="alert">{page.error}</p>}
      <div className="shared-actions">
        {offset > 0 && (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() => setOffset(Math.max(0, offset - 100))}
          >
            Предыдущие проекты
          </button>
        )}
        {page.value?.nextOffset != null && (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() => setOffset(page.value!.nextOffset!)}
          >
            Следующие проекты
          </button>
        )}
      </div>
    </div>
  );
}
type Kind = "note" | "task" | "core" | "plan" | "report" | "review" | "file";
const sourceLabel = (kind: Kind) =>
  kind === "file" ? "Файлы и изображения" : materialLabels[kind];
type Source = { id: string; kind: Kind; title: string; revision?: number };
type Preview = {
  fingerprint: string;
  items: {
    content: SharedMaterial;
    revision: number;
    source: { id: string; kind: Kind };
    files?: SharedAsset[];
  }[];
  files?: { sourceId: string; assetId: string }[];
};

export function SharedPublication({
  projectId,
  initialScope,
  owner,
  onDone,
}: {
  projectId: string;
  initialScope?: ProjectScope | null;
  owner: boolean;
  onDone: () => void;
}) {
  const [scope, setScope] = useState<ProjectScope | null>(initialScope ?? null),
    [kind, setKind] = useState<Kind>("note"),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Source[]>([]),
    [preview, setPreview] = useState<Preview | null>(null);
  const { run, busy, error } = useSharedAction();
  const base = `/team/projects/${projectId}`;
  const sources = useSharedResource<{ items: Source[]; nextOffset: number | null }>(
    scope
      ? base +
          "/publication-sources?" +
          new URLSearchParams({
            client: scope.client,
            projectId: scope.projectId,
            name: scope.name,
            kind,
            offset: String(offset),
          })
      : null,
  );
  const payload = { scope, items: selected.map(({ id, kind }) => ({ id, kind })) };
  return (
    <section className="shared-form">
      <h2>Опубликовать личные материалы</h2>
      <p>
        Выбери записи и проверь содержимое. Участникам будут доступны эти копии; личные чаты, ссылки
        на источники и остальные записи сохранят прежний доступ.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {preview ? (
        <>
          <strong>Будет опубликовано: {preview.items.length}</strong>
          {preview.items.map((entry) => (
            <article className="shared-card" key={entry.source.kind + ":" + entry.source.id}>
              <h3>{entry.content.title}</h3>
              <MaterialContent content={entry.content} />
              <SharedFiles projectId={projectId} files={entry.files} />
            </article>
          ))}
          <div className="shared-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Изменить выбор
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  sharedMutation(base + "/publications", "POST", {
                    ...payload,
                    fingerprint: preview.fingerprint,
                    files: preview.files ?? [],
                  }),
                ).then((result) => {
                  if (result) onDone();
                })
              }
            >
              Опубликовать для участников
            </button>
          </div>
        </>
      ) : (
        <>
          <PersonalProjectPicker
            value={scope}
            disabled={busy}
            onChange={(value) => {
              setScope(value);
              setSelected([]);
              setOffset(0);
            }}
          />
          <label>
            Раздел
            <select
              aria-label="Раздел"
              value={kind}
              disabled={busy}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                setOffset(0);
              }}
            >
              {(
                [
                  "note",
                  "task",
                  "plan",
                  "report",
                  "review",
                  "file",
                  ...(owner ? ["core"] : []),
                ] as Kind[]
              ).map((k) => (
                <option value={k} key={k}>
                  {sourceLabel(k)}
                </option>
              ))}
            </select>
          </label>
          {sources.error && <p role="alert">{sources.error}</p>}
          {sources.value?.items.map((item) => (
            <label className="shared-check shared-card" key={item.kind + item.id}>
              <input
                type="checkbox"
                disabled={
                  busy ||
                  (!selected.some((s) => s.id === item.id && s.kind === item.kind) &&
                    selected.length >= 20)
                }
                checked={selected.some((s) => s.id === item.id && s.kind === item.kind)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, item]
                      : selected.filter((s) => s.id !== item.id || s.kind !== item.kind),
                  )
                }
              />
              {item.title}
            </label>
          ))}
          {sources.value?.items.length === 0 && (
            <p className="muted">В этом разделе нет сохранённых личных материалов.</p>
          )}
          <div className="shared-actions">
            {offset > 0 && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setOffset(Math.max(0, offset - 30))}
              >
                Назад
              </button>
            )}
            {sources.value?.nextOffset != null && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setOffset(sources.value!.nextOffset!)}
              >
                Дальше
              </button>
            )}
          </div>
          {selected.length > 0 && (
            <div>
              <strong>Выбрано {selected.length} из 20</strong>
              {selected.map((item) => (
                <div className="shared-row" key={item.kind + item.id}>
                  <span>
                    {sourceLabel(item.kind)} · {item.title}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setSelected(selected.filter((s) => s !== item))}
                  >
                    Убрать
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || !scope || !selected.length}
            onClick={() =>
              void run(() =>
                api<Preview>(base + "/publication-preview", { method: "POST", body: payload }),
              ).then((value) => {
                if (value) setPreview(value);
              })
            }
          >
            Просмотреть перед публикацией
          </button>
        </>
      )}
    </section>
  );
}
export function SharedFiles({ projectId, files }: { projectId: string; files?: SharedAsset[] }) {
  return files?.length ? (
    <div className="shared-form">
      {files.map((file) => (
        <div className="shared-file-actions" key={file.id}>
          <DownloadLink
            className="secondary shared-file"
            href={`/api/team/projects/${projectId}/assets/${file.id}`}
            name={file.name}
            mime={file.mime}
          >
            {/^image\/(png|jpeg|webp|gif|avif)$/.test(file.mime) && (
              <img
                src={`/api/team/projects/${projectId}/assets/${file.id}`}
                alt={file.name}
                loading="lazy"
              />
            )}
            <span>
              {file.name} · {Math.ceil(file.bytes / 1024)} КБ
            </span>
          </DownloadLink>
          <DownloadLink
            directDownload
            href={`/api/team/projects/${projectId}/assets/${file.id}`}
            name={file.name}
          >
            Скачать
          </DownloadLink>
        </div>
      ))}
    </div>
  ) : null;
}
