import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import { ProjectFileUpload } from "./ProjectFileUpload";
import { useWorkspaceDialog } from "./useWorkspaceDialog";

/** Destination choice delegates all writes/collisions/receipts to ordinary uploads. */
export function FileCopySave({
  file,
  onClose,
  onSaved,
}: {
  file: File;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [projects, setProjects] = useState<{ id: string; name: string; unassigned?: boolean }[]>(
      [],
    ),
    [project, setProject] = useState(""),
    [folder, setFolder] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [grant, setGrant] = useState<{ capability: string; checkout: string } | null>(null);
  const live = useRef(true),
    binding = useRef<{ project: string; capability: string } | null>(null);
  useEffect(() => {
    live.current = true;
    const abort = new AbortController();
    void api<{ projects: typeof projects }>("/projects", { signal: abort.signal })
      .then((v) => {
        if (!abort.signal.aborted) setProjects(v.projects.filter((p) => !p.unassigned));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(messageOf(e));
      });
    return () => {
      live.current = false;
      abort.abort();
      const b = binding.current;
      if (b)
        void api(`/projects/${encodeURIComponent(b.project)}/file-tools/access`, {
          method: "POST",
          body: { unlock: false, capability: b.capability },
        }).catch(() => {});
    };
  }, [file]);
  const prepare = async () => {
    if (busy || !project) return;
    setBusy(true);
    setError("");
    try {
      const v = await api<{ capability: string; checkout: string }>(
        `/projects/${encodeURIComponent(project)}/file-tools/access`,
        {
          method: "POST",
          body: { unlock: true },
        },
      );
      if (!live.current) {
        void api(`/projects/${encodeURIComponent(project)}/file-tools/access`, {
          method: "POST",
          body: { unlock: false, capability: v.capability },
        }).catch(() => {});
        return;
      }
      binding.current = { project, capability: v.capability };
      setGrant(v);
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window file-copy-save"
      aria-label="Сохранить копию"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading">
        <strong>Сохранить копию</strong>
        <button
          className="icon-button"
          type="button"
          aria-label="Закрыть сохранение копии"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="file-copy-fields">
        <label>
          Проект
          <select
            aria-label="Проект для копии"
            value={project}
            disabled={!!grant || busy}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">Выбери проект</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Папка в проекте
          <input
            aria-label="Папка для копии"
            placeholder="Корень проекта"
            value={folder}
            disabled={!!grant || busy}
            onChange={(e) => setFolder(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {grant && (
          <ProjectFileUpload
            projectId={project}
            projectName={projects.find((p) => p.id === project)?.name ?? project}
            {...grant}
            folder={folder}
            initialFile={file}
            onDone={onSaved}
            onDismiss={onClose}
          />
        )}
      </div>
      <footer className="file-copy-actions">
        <DownloadLink preparedFile={file} directDownload>
          Скачать копию
        </DownloadLink>
        <button
          className="primary"
          type="button"
          disabled={!project || busy || !!grant}
          onClick={() => void prepare()}
        >
          {busy ? "Открываю…" : "Сохранить в проект"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
