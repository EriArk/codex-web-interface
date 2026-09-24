import { editableFile } from "@codex-web/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { workspaceUrl } from "./accountStorage";
import { api, messageOf } from "./api";
import { isDownloadUrl } from "./DownloadLink";

const FileEditor = lazy(() => import("./FileEditor"));

export function ViewerEditButton({
  name,
  source,
  file,
}: {
  name: string;
  source?: string;
  file?: File | null;
}) {
  const [target, setTarget] = useState<{
      projectId: string;
      path: string;
      capability: string;
      copy?: { file: File; source: string };
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const active = useRef(true),
    lock = useRef(false),
    grant = useRef<{ projectId: string; capability: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Grants and pending launches belong to the exact source.
  useEffect(() => {
    generation.current++;
    active.current = true;
    setTarget(null);
    return () => {
      active.current = false;
      generation.current++;
      const g = grant.current;
      grant.current = null;
      if (g)
        void api(`/projects/${encodeURIComponent(g.projectId)}/file-tools/access`, {
          method: "POST",
          body: { unlock: false, capability: g.capability },
        }).catch(() => {});
    };
  }, [source]);
  if (!editableFile(file?.name ?? name) || (!source && !file)) return null;
  const edit = async () => {
    if (lock.current) return;
    const version = generation.current;
    const current = () => active.current && generation.current === version;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const match = source?.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/files\/content\?([^#]+)$/),
        query = match ? new URLSearchParams(match[2]) : null;
      if (match && query?.size === 1 && query.has("path")) {
        const projectId = match[1]!,
          path = query.get("path")!;
        const g = await api<{ capability: string }>(`/projects/${projectId}/file-tools/access`, {
          method: "POST",
          body: { unlock: true },
        });
        if (!current()) {
          void api(`/projects/${projectId}/file-tools/access`, {
            method: "POST",
            body: { unlock: false, capability: g.capability },
          }).catch(() => {});
          return;
        }
        const oldGrant = grant.current;
        if (oldGrant)
          void api(`/projects/${oldGrant.projectId}/file-tools/access`, {
            method: "POST",
            body: { unlock: false, capability: oldGrant.capability },
          }).catch(() => {});
        grant.current = { projectId, capability: g.capability };
        setTarget({ projectId, path, capability: g.capability });
      } else {
        let copy = file;
        // Result previews can be truncated; always load the complete authorized source.
        if (source) {
          if (!isDownloadUrl(source)) throw Error("Исходный файл недоступен.");
          const response = await fetch(workspaceUrl(source), {
            credentials: "same-origin",
            redirect: "error",
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok || !response.body) throw Error("Не удалось прочитать исходный файл.");
          const reader = response.body.getReader(),
            chunks: Uint8Array<ArrayBuffer>[] = [];
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.length;
              if (size > 2 * 1024 * 1024) throw Error("Редактор поддерживает текст до 2 МБ.");
              chunks.push(new Uint8Array(part.value));
            }
          } finally {
            await reader.cancel();
          }
          copy = new File(chunks, file?.name ?? name, { type: "text/plain" });
        }
        if (!copy) throw Error("Файл ещё не загружен.");
        if (current())
          setTarget({
            projectId: "",
            capability: "",
            path: copy.name,
            copy: {
              file: copy,
              source: source ?? `${copy.name}:${copy.size}:${copy.lastModified}`,
            },
          });
      }
    } catch (e) {
      if (current()) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <button className="secondary" type="button" disabled={busy} onClick={() => void edit()}>
        {busy ? "Открываю редактор…" : "Редактировать"}
      </button>
      {error && <span role="alert">{error}</span>}
      {target && (
        <Suspense fallback={<span role="status">Открываю редактор…</span>}>
          <FileEditor
            {...target}
            projectName="Файл проекта"
            onClose={() => setTarget(null)}
            onSaved={() =>
              window.dispatchEvent(new CustomEvent("workspace-file-saved", { detail: { source } }))
            }
          />
        </Suspense>
      )}
    </>
  );
}
