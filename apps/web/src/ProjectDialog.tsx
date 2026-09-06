import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Machine, Project } from "./types";

const folderName = (name: string) =>
  Array.from(name.trim())
    .filter((c) => c.charCodeAt(0) >= 32 && !'< >:"/\\|?*'.replace(" ", "").includes(c))
    .join("")
    .replace(/[. ]+$/, "")
    .slice(0, 100);
export function ProjectDialog({
  open,
  machines,
  onClose,
  onCreated,
}: {
  open: boolean;
  machines: Machine[];
  onClose: () => void;
  onCreated: (project: Project) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    attempt = useRef({ body: "", key: "" });
  const [mode, setMode] = useState<"new" | "existing">("new"),
    [name, setName] = useState(""),
    [machineId, setMachineId] = useState(""),
    [path, setPath] = useState(""),
    [pathEdited, setPathEdited] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [browse, setBrowse] = useState<{
      path: string;
      parent: string | null;
      entries: { name: string; path: string }[];
    } | null>(null),
    [browsing, setBrowsing] = useState(false);
  const machine = machines.find((m) => m.id === machineId) ?? machines[0];
  useEffect(() => {
    if (open) {
      setError("");
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!pathEdited && machine)
      setPath(
        machine.projectsDirectory +
          (mode === "new" && name
            ? (machine.type === "ssh-windows" ? "\\" : "/") + folderName(name)
            : ""),
      );
  }, [name, mode, machine, pathEdited]);
  const openFolder = async (value: string) => {
    if (!machine) return;
    setBrowsing(true);
    setError("");
    try {
      setBrowse(await api(`/machines/${machine.id}/directories?path=${encodeURIComponent(value)}`));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBrowsing(false);
    }
  };
  const submit = async () => {
    if (!machine || busy || machine.canCreateProjects === false) return;
    setBusy(true);
    setError("");
    const body = {
        machineId: machine.id,
        name: name.trim(),
        workingDirectory: path,
        createDirectory: mode === "new",
      },
      serialized = JSON.stringify(body);
    if (attempt.current.body !== serialized)
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    try {
      const project = await api<Project>("/projects", {
        method: "POST",
        key: attempt.current.key,
        body,
      });
      await onCreated(project);
      setName("");
      setPathEdited(false);
      setBrowse(null);
      attempt.current = { body: "", key: "" };
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">Твоя следующая идея</span>
          <h2>Новый проект</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть создание проекта"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="project-create-modes">
        <button
          type="button"
          className={mode === "new" ? "selected" : ""}
          onClick={() => {
            setMode("new");
            setPathEdited(false);
          }}
        >
          Создать папку
        </button>
        <button
          type="button"
          className={mode === "existing" ? "selected" : ""}
          onClick={() => {
            setMode("existing");
            setPathEdited(false);
          }}
        >
          Подключить папку
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field-label">
          Название
          <input
            autoComplete="off"
            name="projectName"
            aria-label="Название проекта"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="Например, новая игра"
            disabled={busy}
          />
        </label>
        <label className="field-label">
          Компьютер
          <select
            aria-label="Компьютер проекта"
            value={machine?.id ?? ""}
            onChange={(e) => {
              setMachineId(e.target.value);
              setPathEdited(false);
              setBrowse(null);
            }}
            disabled={busy}
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Папка на компьютере
          <div className="path-field">
            <input
              aria-label="Папка проекта"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setPathEdited(true);
              }}
              required
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Выбрать папку проекта"
              onClick={() => void openFolder(machine?.projectsDirectory ?? path)}
              disabled={busy || browsing}
            >
              <Icon name="folder" />
            </button>
          </div>
        </label>
        {browse && (
          <div className="folder-picker">
            <div className="folder-picker-heading">
              <strong>{browse.path}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть выбор папки"
                onClick={() => setBrowse(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="folder-picker-list">
              {browse.parent && (
                <button
                  type="button"
                  disabled={browsing}
                  onClick={() => void openFolder(browse.parent ?? "")}
                >
                  <Icon name="arrow-up" size={17} />
                  На уровень выше
                </button>
              )}
              {browse.entries.map((folder) => (
                <button
                  type="button"
                  key={folder.path}
                  disabled={browsing}
                  onClick={() => void openFolder(folder.path)}
                >
                  <Icon name="folder" size={17} />
                  {folder.name}
                  <Icon name="chevron" size={15} />
                </button>
              ))}
              {!browse.entries.length && <p className="small muted">Вложенных папок нет</p>}
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPath(browse.path);
                setPathEdited(true);
                setMode("existing");
                setBrowse(null);
              }}
            >
              Выбрать эту папку
            </button>
          </div>
        )}
        <p className="field-help">
          {mode === "new"
            ? "Папка будет создана на компьютере. Работай здесь или открой её в настольном Codex."
            : "Файлы останутся на своём месте. Диалоги в этой папке будут доступны здесь."}
        </p>
        {machine?.canCreateProjects === false && (
          <p className="form-error">
            Установленный Codex не поддерживает создание проектов. Существующие настроенные проекты
            доступны.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              busy || !machine || machine.canCreateProjects === false || !name.trim() || !path
            }
          >
            {busy ? "Создаём…" : mode === "new" ? "Создать проект" : "Подключить проект"}
            <Icon name="plus" size={17} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
