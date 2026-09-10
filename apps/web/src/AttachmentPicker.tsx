import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import type { Attachment } from "./types";
export const fileSize = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
export function useAttachments(threadId: string) {
  const [files, setFiles] = useState<Attachment[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = useRef(threadId);
  current.current = threadId;
  const inFlight = useRef(false);
  const inventory = useRef<{ threadId: string; cleared: boolean; removed: Set<string> } | null>(
    null,
  );
  useEffect(() => {
    const load = { threadId, cleared: false, removed: new Set<string>() };
    inventory.current = load;
    if (!threadId) {
      setFiles([]);
      return;
    }
    let disposed = false;
    setFiles([]);
    setError("");
    void api<{ attachments: Attachment[] }>(`/threads/${threadId}/attachments`)
      .then((value) => {
        if (!disposed && !load.cleared)
          setFiles((old) =>
            [
              ...new Map([...value.attachments, ...old].map((file) => [file.id, file])).values(),
            ].filter((file) => !load.removed.has(file.id)),
          );
      })
      .catch((e) => {
        if (!disposed) setError(messageOf(e));
      });
    return () => {
      disposed = true;
    };
  }, [threadId]);
  const add = async (selected: FileList | File[]) => {
    if (!threadId || inFlight.current) return;
    const id = threadId;
    if (files.length + selected.length > 8) {
      setError("До 8 вложений на сообщение");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      for (const original of Array.from(selected)) {
        if (original.size > 25 * 1024 ** 2) throw new Error(`Файл «${original.name}» больше 25 МБ`);
        let file = original;
        // Safari can decode a photo selected from the iOS library before upload.
        if (/\.(heic|heif)$/i.test(file.name)) {
          const url = URL.createObjectURL(file);
          try {
            const img = new Image();
            img.src = url;
            await img.decode();
            const scale = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.naturalWidth * scale);
            canvas.height = Math.round(img.naturalHeight * scale);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Не удалось открыть фото");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob>((resolve, reject) =>
              canvas.toBlob(
                (value) =>
                  value ? resolve(value) : reject(new Error("Не удалось подготовить фото")),
                "image/jpeg",
                0.95,
              ),
            );
            file = new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), {
              type: "image/jpeg",
            });
          } catch {
            throw new Error("Это фото не удалось открыть. Выбери JPEG или PNG.");
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        const added = await api<Attachment>(
          `/threads/${id}/attachments?name=${encodeURIComponent(file.name)}`,
          { method: "POST", raw: file },
        );
        if (current.current === id) setFiles((old) => [...old, added]);
      }
    } catch (e) {
      if (current.current === id) setError(messageOf(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const thread = threadId;
    try {
      await api(`/attachments/${id}`, { method: "DELETE" });
      if (current.current === thread) {
        inventory.current?.removed.add(id);
        setFiles((old) => old.filter((f) => f.id !== id));
      }
    } catch (e) {
      if (current.current === thread) setError(messageOf(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return {
    files,
    busy,
    error,
    add,
    remove,
    clear: () => {
      if (inventory.current) inventory.current.cleared = true;
      setFiles([]);
    },
  };
}
export function AttachmentList({
  files,
  disabled,
  onRemove,
}: {
  files: Attachment[];
  disabled?: boolean;
  onRemove?: (id: string) => void;
}) {
  const [unavailable, setUnavailable] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Attachment | null>(null),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (preview) dialog.current?.showModal();
    else dialog.current?.close();
  }, [preview]);
  if (!files.length) return null;
  return (
    <>
      <fieldset
        className={`attachment-list ${onRemove ? "" : "message-attachments"}`}
        aria-label={onRemove ? "Вложения к сообщению" : "Прикреплённые файлы"}
      >
        {files.map((file) => (
          <div className={`attachment ${file.image ? "has-image" : ""}`} key={file.id}>
            {file.image ? (
              <button
                type="button"
                className="attachment-open"
                onClick={() => {
                  if (unavailable[file.id]) {
                    setUnavailable((v) => ({ ...v, [file.id]: false }));
                    setAttempt((v) => ({ ...v, [file.id]: (v[file.id] ?? 0) + 1 }));
                  } else setPreview(file);
                }}
                aria-label={`${unavailable[file.id] ? "Повторить загрузку" : "Посмотреть"} ${file.name}`}
              >
                {unavailable[file.id] ? (
                  <span className="image-unavailable">
                    Изображение пока недоступно. Нажми, чтобы повторить.
                  </span>
                ) : (
                  <img
                    src={file.previewUrl + (attempt[file.id] ? `?retry=${attempt[file.id]}` : "")}
                    alt=""
                    loading="lazy"
                    onError={() => setUnavailable((v) => ({ ...v, [file.id]: true }))}
                  />
                )}
                <span>
                  {file.name}
                  {file.bytes > 0 && <small>{fileSize(file.bytes)}</small>}
                </span>
              </button>
            ) : (
              <DownloadLink className="attachment-open" href={file.url} name={file.name}>
                <Icon name="folder" />
                <span>
                  {file.name}
                  {file.bytes > 0 && <small>{fileSize(file.bytes)}</small>}
                </span>
              </DownloadLink>
            )}
            {onRemove && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Удалить ${file.name}`}
                disabled={disabled}
                onClick={() => onRemove(file.id)}
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
        ))}
      </fieldset>
      <dialog className="attachment-preview" ref={dialog} onCancel={() => setPreview(null)}>
        <div className="viewer-toolbar">
          <span>{preview?.name}</span>
          <DownloadLink className="secondary" href={preview?.url} name={preview?.name}>
            Скачать
          </DownloadLink>
          <button
            type="button"
            className="icon-button"
            onClick={() => setPreview(null)}
            aria-label="Закрыть изображение"
          >
            <Icon name="close" />
          </button>
        </div>
        {preview && (
          <div className="viewer-image">
            <img src={preview.previewUrl} alt={preview.name} />
          </div>
        )}
      </dialog>
    </>
  );
}
