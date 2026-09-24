import { useEffect, useState } from "react";
import { workspaceUrl } from "./accountStorage.ts";
import { messageOf } from "./api";
import { FilePreview } from "./FilePreview";
import { previewKind } from "./filePreviewRegistry";
import { Icon } from "./icons";

// Preview only small files automatically. Explicit Open retains the full download flow.
const limit = 2 * 1024 * 1024;
export function ProjectFilePreview({
  projectId,
  path,
  size,
  visible,
}: {
  projectId: string;
  path: string;
  size?: number;
  visible: boolean;
}) {
  const [wide, setWide] = useState(() => matchMedia("(min-width: 900px)").matches);
  const [file, setFile] = useState<File | null>(null),
    [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const explicit = ["technical", "pdf", "html", "audio", "video", "package"].includes(
    previewKind({ name: path, type: "", size: size ?? 0 }),
  );
  useEffect(() => {
    const media = matchMedia("(min-width: 900px)");
    const change = () => setWide(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    setFile(null);
    setUrl("");
    setError("");
    if (!wide || !visible || !path || size === undefined || size > limit || explicit) return;
    const controller = new AbortController();
    let objectUrl = "";
    void (async () => {
      const response = await fetch(
        workspaceUrl(
          `/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`,
        ),
        {
          credentials: "same-origin",
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        },
      );
      if (!response.ok || !response.body)
        throw Error("Не удалось прочитать файл. Открой его повторно.");
      const reader = response.body.getReader(),
        chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > limit) throw Error("Файл вырос. Используй «Открыть файл» для просмотра.");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (controller.signal.aborted) return;
      const next = new File(chunks, path.split("/").at(-1) || "Файл", {
        type: "application/octet-stream",
      });
      objectUrl = URL.createObjectURL(next);
      setFile(next);
      setUrl(objectUrl);
    })().catch((e) => {
      if (!controller.signal.aborted) setError(messageOf(e));
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, path, size, visible, wide, explicit]);
  return (
    <aside className="inspector-preview" aria-label="Содержимое файла">
      <header>
        <Icon name="file" />
        <strong>{path || "Просмотр файла"}</strong>
      </header>
      {!path ? (
        <p className="inspector-empty">Выбери файл в списке слева</p>
      ) : error ? (
        <p role="status">{error}</p>
      ) : size === undefined || size > limit || explicit ? (
        <p>Для этого файла используй «Открыть файл» рядом с его именем.</p>
      ) : file ? (
        <FilePreview key={url} file={file} objectUrl={url} />
      ) : (
        <p role="status">
          <span className="spinner" /> Читаю файл…
        </p>
      )}
    </aside>
  );
}
