import type { ProjectSetupInput, ProjectSetupOperation, SetupRepository } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedAgentSettings, ProfilePreview } from "./AgentProfileEditor";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Machine, Project } from "./types";
import "./project-setup.css";

function repositoryAddress(value: string) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]{0,99})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    );
  return match && ![".", ".."].includes(match[2]!) ? { owner: match[1]!, name: match[2]! } : null;
}
const draftKey = "codex-project-setup-draft-v1";
const folderName = (value: string) =>
  value
    .trim()
    .replace(/[<>:"/\\|?*]/g, "")
    .split("")
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("")
    .replace(/[. ]+$/, "")
    .slice(0, 100);
const initial: ProjectSetupInput = {
  machineId: "",
  name: "",
  workingDirectory: "",
  createDirectory: true,
  repository: { mode: "none", owner: "", name: "", visibility: "private", description: "" },
};
function restore(draftKey: string) {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey) ?? "null");
    if (
      !value ||
      !value.input ||
      !["machineId", "name", "workingDirectory"].every(
        (key) => typeof value.input[key] === "string",
      ) ||
      typeof value.input.createDirectory !== "boolean" ||
      !value.input.repository ||
      !["none", "create", "connect"].includes(value.input.repository.mode) ||
      !["owner", "name", "description", "visibility"].every(
        (key) => typeof value.input.repository[key] === "string",
      )
    )
      return null;
    return {
      input: value.input,
      operationId: typeof value.operationId === "string" ? value.operationId : "",
      attempt:
        typeof value.attempt?.body === "string" && typeof value.attempt?.key === "string"
          ? value.attempt
          : { body: "", key: "" },
    };
  } catch {
    return null;
  }
}
const labels: Record<string, string> = {
  "create-directory": "Создать папку",
  "git-init": "Инициализировать Git",
  "create-repository": "Создать репозиторий GitHub",
  "link-origin": "Подключить origin",
  clone: "Клонировать репозиторий",
  "register-project": "Подключить проект в CodexWeb",
  "agent-profile": "Применить профиль поведения",
  complete: "Проект готов",
  review: "Проверь перед созданием",
};
type Folder = { path: string; parent: string | null; entries: { name: string; path: string }[] };
export type ProjectSetupSeed = {
  name: string;
  repository: string;
  scope: string;
  receiptId?: string;
  resetReview?: (fingerprint: string) => Promise<void>;
};
type ProjectDialogProps = {
  open: boolean;
  machines: Machine[];
  onClose: () => void;
  onCreated: (project: Project) => Promise<void>;
  seed?: ProjectSetupSeed;
};
export function ProjectDialog(props: ProjectDialogProps) {
  const scope = props.seed ? `${props.seed.scope}:${props.seed.repository}` : "personal";
  return <ProjectDialogContent key={scope} {...props} draftScope={scope} />;
}
function ProjectDialogContent({
  open,
  machines,
  onClose,
  onCreated,
  seed,
  draftScope,
}: ProjectDialogProps & { draftScope: string }) {
  const storageKey = seed ? `${draftKey}:${encodeURIComponent(draftScope)}` : draftKey;
  const restored = useRef(restore(storageKey));
  const matchesSeed = useCallback(
    (value: ProjectSetupInput) =>
      !seed?.repository ||
      (value.repository.mode === "connect" &&
        `https://github.com/${value.repository.owner}/${value.repository.name}`.toLowerCase() ===
          seed.repository.toLowerCase()),
    [seed],
  );
  if (restored.current && !matchesSeed(restored.current.input)) restored.current = null;
  const [input, setInput] = useState<ProjectSetupInput>(() => restored.current?.input ?? initial),
    [step, setStep] = useState(0),
    [editedPath, setEditedPath] = useState(!!restored.current?.input?.workingDirectory);
  const [operation, setOperation] = useState<ProjectSetupOperation | null>(null),
    [pending, setPending] = useState<ProjectSetupOperation[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [browse, setBrowse] = useState<Folder | null>(null),
    [browsing, setBrowsing] = useState(false),
    [repos, setRepos] = useState<SetupRepository[]>([]),
    [repoSearch, setRepoSearch] = useState(""),
    [repoPage, setRepoPage] = useState(1),
    [more, setMore] = useState(false),
    [repoBusy, setRepoBusy] = useState(false),
    [repoError, setRepoError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    openRef = useRef(open),
    generation = useRef(0),
    folderGeneration = useRef(0),
    repoGeneration = useRef(0),
    repoController = useRef<AbortController | null>(null),
    attempt = useRef<{ body: string; key: string }>(
      restored.current?.attempt ?? { body: "", key: "" },
    );
  const visibilityGeneration = useRef(0);
  useEffect(() => {
    if (!open) visibilityGeneration.current++;
    return () => {
      visibilityGeneration.current++;
    };
  }, [open]);
  const delivering = useRef(false),
    persistedOperation = useRef<string>(restored.current?.operationId || seed?.receiptId || "");
  const [restoringOperation, setRestoringOperation] = useState(!!persistedOperation.current);
  openRef.current = open;
  const machine = machines.find((m) => m.id === input.machineId) ?? machines[0];
  const locked =
    busy ||
    restoringOperation ||
    operation?.state === "running" ||
    operation?.state === "unknown" ||
    operation?.state === "complete";
  const setField = useCallback((patch: Partial<ProjectSetupInput>) => {
    generation.current++;
    setOperation(null);
    persistedOperation.current = "";
    setError("");
    setInput((old) => ({ ...old, ...patch }));
  }, []);
  const setRepository = (patch: Partial<ProjectSetupInput["repository"]>) =>
    setField({ repository: { ...input.repository, ...patch } });
  const appliedSeed = useRef<typeof seed>(undefined);
  useEffect(() => {
    if (!open || !seed || appliedSeed.current === seed || restored.current) return;
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(seed.repository);
    if (!match && seed.repository) return;
    appliedSeed.current = seed;
    setField({
      ...initial,
      machineId: machine?.id ?? "",
      name: seed.name,
      repository: match
        ? { ...initial.repository, mode: "connect", owner: match[1]!, name: match[2]! }
        : { ...initial.repository },
    });
    setEditedPath(false);
    setStep(0);
  }, [open, seed, machine?.id, setField]);
  useEffect(() => {
    if (!machine) return;
    setInput((old) => ({
      ...old,
      machineId: machine.id,
      ...(!editedPath
        ? {
            workingDirectory:
              (input.createDirectory && input.name
                ? machine.projectsDirectory.replace(/[\\/]+$/, "")
                : machine.projectsDirectory) +
              (input.createDirectory && input.name
                ? (machine.type === "ssh-windows" ? "\\" : "/") + folderName(input.name)
                : ""),
          }
        : {}),
    }));
  }, [machine, editedPath, input.name, input.createDirectory]);
  useEffect(() => {
    if (!open) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          input,
          attempt: attempt.current,
          operationId: operation?.id ?? persistedOperation.current,
        }),
      );
    } catch {
      setError(
        "Не удалось сохранить черновик на устройстве. Операция на сервере сохранится отдельно.",
      );
    }
  }, [open, input, operation, storageKey]);
  useEffect(() => {
    if (!open) {
      dialog.current?.close();
      return;
    }
    dialog.current?.showModal();
    const controller = new AbortController();
    const receipt = seed?.receiptId || persistedOperation.current;
    setRestoringOperation(!!receipt);
    void api<{ operations: ProjectSetupOperation[] }>("/project-setup", {
      signal: controller.signal,
    })
      .then((v) => setPending(v.operations.filter((row) => !seed || row.id === receipt)))
      .catch(() => {});
    if (receipt)
      void api<ProjectSetupOperation>(`/project-setup/${receipt}`, {
        signal: controller.signal,
      })
        .then((v) => {
          if (!controller.signal.aborted && v.id === receipt && matchesSeed(v.input)) {
            persistedOperation.current = receipt;
            setOperation(v);
            setInput(v.input);
            setEditedPath(true);
            setStep(3);
            setRestoringOperation(false);
          }
        })
        .catch((e) => {
          if (controller.signal.aborted) return;
          if (e instanceof ApiError && e.status === 404) setRestoringOperation(false);
          else setError(messageOf(e));
        });
    return () => controller.abort();
  }, [open, seed, matchesSeed]);
  const operationId = operation?.id,
    operationState = operation?.state;
  useEffect(() => {
    if (!open || !operationId || operationState !== "running") return;
    let active = true,
      reading = false;
    const controller = new AbortController(),
      id = operationId;
    const refresh = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const value = await api<ProjectSetupOperation>(`/project-setup/${id}`, {
          signal: controller.signal,
        });
        if (active) setOperation(value);
      } catch (e) {
        if (active) setError(messageOf(e));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [open, operationId, operationState]);
  useEffect(() => {
    if (open)
      return () => {
        repoGeneration.current++;
        repoController.current?.abort();
      };
    setRepoBusy(false);
  }, [open]);
  const loadRepos = async (page = 1, search = repoSearch) => {
    if (!machine) return;
    const serial = ++repoGeneration.current,
      mid = machine.id;
    const controller = new AbortController();
    repoController.current?.abort();
    repoController.current = controller;
    setRepoBusy(true);
    setRepoError("");
    try {
      const value = await api<{ login: string; repositories: SetupRepository[]; hasMore: boolean }>(
        `/machines/${encodeURIComponent(mid)}/github-repositories?search=${encodeURIComponent(search)}&page=${page}`,
        { signal: controller.signal },
      );
      if (serial !== repoGeneration.current) return;
      setRepos((old) => (page === 1 ? value.repositories : [...old, ...value.repositories]));
      setMore(value.hasMore);
      setRepoPage(page);
      setInput((old) => ({
        ...old,
        repository: {
          ...old.repository,
          owner: old.repository.mode === "create" ? value.login : old.repository.owner,
        },
      }));
    } catch (e) {
      if (serial === repoGeneration.current) setRepoError(messageOf(e));
    } finally {
      if (serial === repoGeneration.current) setRepoBusy(false);
    }
  };
  const openFolder = async (path: string) => {
    if (!machine) return;
    const serial = ++folderGeneration.current;
    setBrowsing(true);
    setError("");
    try {
      const value = await api<Folder>(
        `/machines/${machine.id}/directories?path=${encodeURIComponent(path)}`,
      );
      if (serial === folderGeneration.current) setBrowse(value);
    } catch (e) {
      if (serial === folderGeneration.current) setError(messageOf(e));
    } finally {
      if (serial === folderGeneration.current) setBrowsing(false);
    }
  };
  const review = async () => {
    if (!machine || busy) return;
    setBusy(true);
    setError("");
    const value = { ...input, machineId: machine.id },
      body = JSON.stringify(value),
      version = generation.current;
    if (attempt.current.body !== body)
      attempt.current = { body, key: seed?.receiptId ?? crypto.randomUUID() };
    try {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ input: value, attempt: attempt.current, operationId: "" }),
        );
      } catch {}
      const result = await api<ProjectSetupOperation>("/project-setup/prepare", {
        method: "POST",
        key: attempt.current.key,
        body: value,
      });
      if (version === generation.current) {
        setOperation(result);
        persistedOperation.current = result.id;
        setStep(3);
      }
    } catch (e) {
      if (version === generation.current) setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (!operation?.project || delivering.current) return;
    delivering.current = true;
    const visibility = visibilityGeneration.current;
    setBusy(true);
    setError("");
    try {
      await onCreated(operation.project as Project);
      if (visibility !== visibilityGeneration.current) return;
      persistedOperation.current = "";
      attempt.current = { body: "", key: "" };
      setOperation(null);
      setInput(initial);
      setEditedPath(false);
      setStep(0);
      try {
        localStorage.removeItem(storageKey);
      } catch {}
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      delivering.current = false;
      setBusy(false);
    }
  };
  const execute = async () => {
    if (!operation || busy) return;
    setBusy(true);
    setError("");
    try {
      setOperation(
        await api<ProjectSetupOperation>(`/project-setup/${operation.id}/execute`, {
          method: "POST",
          body: {},
        }),
      );
    } catch (e) {
      setError(messageOf(e));
      try {
        setOperation(await api(`/project-setup/${operation.id}`));
      } catch {}
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    if (step === 2) void review();
    else {
      setStep((v) => v + 1);
      if (step === 1 && !seed?.repository && input.repository.mode !== "none") void loadRepos();
    }
  };
  return (
    <dialog
      ref={dialog}
      className="project-dialog project-setup-dialog"
      aria-label="Создание проекта"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-heading">
        <div>
          <small className="eyebrow">Рабочее пространство</small>
          <h2>
            {operation?.state === "complete"
              ? "Проект готов"
              : seed?.repository
                ? "Рабочая копия"
                : "Новый проект"}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button panel-close"
          aria-label="Закрыть создание проекта"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <ol className="setup-steps" aria-label="Этапы создания">
        {["Проект", "Папка", "GitHub", "Проверка"].map((name, index) => (
          <li
            key={name}
            aria-current={step === index ? "step" : undefined}
            className={step === index ? "active" : step > index ? "done" : ""}
          >
            <span>{step > index ? <Icon name="check" size={13} /> : index + 1}</span>
            {name}
          </li>
        ))}
      </ol>
      <div className="setup-body">
        {step === 3 && operation?.input.agentProfile && (
          <ProfilePreview
            rules={{ enabled: [], custom: "", agentProfile: operation.input.agentProfile }}
          />
        )}
        {step === 0 && (
          <>
            <label className="field-label">
              Название
              <input
                aria-label="Название проекта"
                value={input.name}
                maxLength={120}
                disabled={locked}
                onChange={(e) => setField({ name: e.target.value })}
                autoComplete="off"
                placeholder="Название проекта"
              />
            </label>
            <label className="field-label">
              Компьютер
              <select
                aria-label="Компьютер проекта"
                value={machine?.id ?? ""}
                disabled={locked}
                onChange={(e) => {
                  folderGeneration.current++;
                  repoGeneration.current++;
                  setBrowsing(false);
                  setRepoBusy(false);
                  setEditedPath(false);
                  setBrowse(null);
                  setRepos([]);
                  setField({
                    machineId: e.target.value,
                    repository: {
                      ...input.repository,
                      owner: seed?.repository ? input.repository.owner : "",
                    },
                  });
                }}
              >
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset disabled={locked} className="agent-setup-fields">
              <AdvancedAgentSettings
                value={input.agentProfile ?? null}
                onChange={(agentProfile) => setField({ agentProfile })}
              />
            </fieldset>
            {pending.length > 0 && (
              <details className="setup-pending">
                <summary>
                  Незавершённые настройки <small>{pending.length}</small>
                </summary>
                {pending.map((row) => (
                  <button
                    type="button"
                    key={row.id}
                    onClick={() => {
                      setOperation(row);
                      persistedOperation.current = row.id;
                      setInput(row.input);
                      setEditedPath(true);
                      setStep(3);
                    }}
                  >
                    <Icon name="folder" />
                    <span>
                      {row.input.name}
                      <small>{labels[row.phase] ?? "Проверить состояние"}</small>
                    </span>
                    <Icon name="chevron" />
                  </button>
                ))}
              </details>
            )}
          </>
        )}
        {step === 1 && (
          <>
            <div className="project-create-modes">
              <button
                type="button"
                disabled={locked}
                className={input.createDirectory ? "selected" : ""}
                onClick={() => {
                  setField({ createDirectory: true });
                  setEditedPath(false);
                }}
              >
                Создать папку
              </button>
              <button
                type="button"
                disabled={locked}
                className={!input.createDirectory ? "selected" : ""}
                onClick={() => {
                  setField({ createDirectory: false });
                  setEditedPath(false);
                }}
              >
                Подключить папку
              </button>
            </div>
            <label className="field-label">
              Папка на компьютере
              <div className="path-field">
                <input
                  aria-label="Папка проекта"
                  value={input.workingDirectory}
                  disabled={locked}
                  onChange={(e) => {
                    setEditedPath(true);
                    setField({ workingDirectory: e.target.value });
                  }}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Выбрать папку проекта"
                  disabled={locked || browsing}
                  onClick={() =>
                    void openFolder(machine?.projectsDirectory ?? input.workingDirectory)
                  }
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
                    <Icon name="close" />
                  </button>
                </div>
                <div className="folder-picker-list">
                  {machine?.allowedProjectRoots && machine.allowedProjectRoots.length > 1 && (
                    <label className="field-label">
                      Разрешённые папки
                      <select
                        aria-label="Разрешённая корневая папка"
                        value={machine.allowedProjectRoots.includes(browse.path) ? browse.path : ""}
                        disabled={browsing}
                        onChange={(event) => {
                          if (event.target.value) void openFolder(event.target.value);
                        }}
                      >
                        <option value="" disabled>
                          Перейти в другую папку…
                        </option>
                        {machine.allowedProjectRoots.map((root) => (
                          <option key={root} value={root}>
                            {root}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {browse.parent && (
                    <button
                      type="button"
                      disabled={browsing}
                      onClick={() => void openFolder(browse.parent!)}
                    >
                      <Icon name="arrow-up" />
                      На уровень выше
                    </button>
                  )}
                  {browse.entries.map((row) => (
                    <button
                      type="button"
                      key={row.path}
                      disabled={browsing}
                      onClick={() => void openFolder(row.path)}
                    >
                      <Icon name="folder" />
                      {row.name}
                      <Icon name="chevron" />
                    </button>
                  ))}
                  {!browse.entries.length && <p>Вложенных папок нет</p>}
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditedPath(true);
                    setField({ workingDirectory: browse.path, createDirectory: false });
                    setBrowse(null);
                  }}
                >
                  Выбрать эту папку
                </button>
              </div>
            )}
          </>
        )}
        {step === 2 && seed?.repository && (
          <p className="setup-review">
            <Icon name="repository" size={18} />{" "}
            {seed.repository.replace("https://github.com/", "")}
          </p>
        )}
        {step === 2 && !seed?.repository && (
          <>
            <div className="setup-repo-modes">
              {[
                ["none", "Без репозитория", "folder"],
                ["create", "Создать GitHub", "plus"],
                ["connect", "Подключить GitHub", "repository"],
              ].map(([mode, title, icon]) => (
                <button
                  type="button"
                  key={mode}
                  className={input.repository.mode === mode ? "selected" : ""}
                  disabled={locked}
                  onClick={() => {
                    repoGeneration.current++;
                    repoController.current?.abort();
                    setRepoBusy(false);
                    setRepoError("");
                    setRepoSearch("");
                    setRepos([]);
                    setMore(false);
                    setRepository({
                      mode: mode as "none" | "create" | "connect",
                      owner: "",
                      name: mode === "create" ? folderName(input.name) : "",
                    });
                    if (mode !== "none") void loadRepos(1, "");
                  }}
                >
                  <Icon name={icon as "folder"} />
                  {title}
                </button>
              ))}
            </div>
            {input.repository.mode !== "none" && (
              <>
                {repoBusy && (
                  <p role="status">
                    <span className="spinner" />
                    Подключаем GitHub…
                  </p>
                )}
                {repoError && (
                  <p className="form-error" role="alert">
                    {repoError}{" "}
                    <button type="button" onClick={() => void loadRepos()}>
                      Повторить
                    </button>
                  </p>
                )}
                {input.repository.mode === "create" ? (
                  <>
                    <label className="field-label">
                      Репозиторий
                      <div className="setup-repo-name">
                        <span>{input.repository.owner || "GitHub"} /</span>
                        <input
                          aria-label="Название репозитория"
                          value={input.repository.name}
                          maxLength={100}
                          onChange={(e) => setRepository({ name: e.target.value })}
                        />
                      </div>
                    </label>
                    <label className="field-label">
                      Доступ
                      <select
                        aria-label="Видимость репозитория"
                        value={input.repository.visibility}
                        onChange={(e) =>
                          setRepository({ visibility: e.target.value as "private" | "public" })
                        }
                      >
                        <option value="private">Приватный</option>
                        <option value="public">Публичный</option>
                      </select>
                    </label>
                    <label className="field-label">
                      Описание
                      <input
                        aria-label="Описание репозитория"
                        value={input.repository.description}
                        maxLength={350}
                        onChange={(e) => setRepository({ description: e.target.value })}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <form
                      className="setup-repo-search"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const address = repositoryAddress(repoSearch);
                        if (address) {
                          repoGeneration.current++;
                          repoController.current?.abort();
                          setRepoBusy(false);
                          setRepoError("");
                          setRepos([]);
                          setMore(false);
                          setRepository(address);
                        } else void loadRepos();
                      }}
                    >
                      <input
                        aria-label="Найти репозиторий"
                        value={repoSearch}
                        onChange={(e) => {
                          repoGeneration.current++;
                          repoController.current?.abort();
                          setRepoBusy(false);
                          setRepoError("");
                          setRepos([]);
                          setMore(false);
                          setRepoSearch(e.target.value);
                          setRepository({ owner: "", name: "" });
                        }}
                        placeholder="Поиск, ссылка или владелец/репозиторий"
                      />
                      <button
                        type="submit"
                        className="icon-button"
                        aria-label="Поиск репозиториев"
                        disabled={repoBusy}
                      >
                        <Icon name="search" />
                      </button>
                    </form>
                    {input.repository.owner && input.repository.name && (
                      <p className="setup-review">
                        <Icon name="repository" size={18} /> {input.repository.owner}/
                        {input.repository.name}
                      </p>
                    )}
                    <div className="setup-repo-list">
                      {repos.map((repo) => (
                        <button
                          type="button"
                          key={repo.id}
                          className={
                            input.repository.owner === repo.owner &&
                            input.repository.name === repo.name
                              ? "selected"
                              : ""
                          }
                          onClick={() =>
                            setRepository({
                              owner: repo.owner,
                              name: repo.name,
                              visibility: repo.private ? "private" : "public",
                            })
                          }
                        >
                          <Icon name="repository" />
                          <span>
                            {repo.owner} / {repo.name}
                            <small>{repo.private ? "Приватный" : "Публичный"}</small>
                          </span>
                          {input.repository.owner === repo.owner &&
                            input.repository.name === repo.name && <Icon name="check" />}
                        </button>
                      ))}
                      {more && (
                        <button
                          type="button"
                          disabled={repoBusy}
                          onClick={() => void loadRepos(repoPage + 1)}
                        >
                          Ещё репозитории
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
        {step === 3 && operation && (
          <>
            <section className="setup-review">
              <h3>{operation.input.name}</h3>
              <p>{machine?.name}</p>
              <code>{operation.input.workingDirectory}</code>
              {operation.input.repository.mode !== "none" && (
                <p>
                  <Icon name="repository" size={16} />
                  {operation.input.repository.owner}/{operation.input.repository.name} ·{" "}
                  {(
                    operation.input.repository.mode === "connect" && operation.inspection.remote
                      ? operation.inspection.remote.private
                      : operation.input.repository.visibility === "private"
                  )
                    ? "Приватный"
                    : "Публичный"}
                </p>
              )}
              <ol>
                {operation.inspection.steps.map((item) => (
                  <li key={item}>
                    <Icon name={operation.state === "complete" ? "check" : "chevron"} size={16} />
                    {labels[item] ?? item}
                  </li>
                ))}
              </ol>
              {operation.inspection.git && (
                <small>
                  Текущая ветка: {operation.inspection.branch || "отдельный коммит"}
                  {operation.inspection.dirty ? " · есть изменения" : ""}
                </small>
              )}
              {operation.input.repository.mode === "connect" && operation.inspection.origin && (
                <p>Папка уже связана с этим репозиторием.</p>
              )}
            </section>
            {operation.state === "running" && (
              <p className="setup-progress" role="status">
                <span className="spinner" />
                {labels[operation.phase] ?? "Подготавливаем проект…"}
              </p>
            )}
            {operation.error && (
              <p className="form-error" role="alert">
                {operation.error}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {machine?.canCreateProjects === false && (
          <p className="form-error">Установленный Codex не поддерживает создание проектов.</p>
        )}
      </div>
      <footer className="dialog-actions setup-footer">
        {step > 0 && !locked && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (seed?.resetReview && operation?.state === "prepared") {
                setBusy(true);
                void seed
                  .resetReview(operation.inspection.fingerprint)
                  .then(() => {
                    setOperation(null);
                    persistedOperation.current = "";
                    attempt.current = { body: "", key: "" };
                    setStep(2);
                  })
                  .catch((e) => setError(messageOf(e)))
                  .finally(() => setBusy(false));
                return;
              }
              setStep((v) => v - 1);
              if (operation?.state === "failed") {
                attempt.current = { body: "", key: "" };
                setOperation(null);
                persistedOperation.current = "";
              }
            }}
          >
            Назад
          </button>
        )}
        {step < 3 ? (
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              restoringOperation ||
              (input.repository.mode !== "none" && repoBusy) ||
              !machine ||
              machine.canCreateProjects === false ||
              !input.name.trim() ||
              (step > 0 && !input.workingDirectory) ||
              (step === 2 &&
                input.repository.mode !== "none" &&
                (!input.repository.owner || !input.repository.name))
            }
            onClick={next}
          >
            {busy ? (
              <>
                <span className="spinner" />
                Проверяем…
              </>
            ) : step === 2 ? (
              "Проверить"
            ) : (
              "Далее"
            )}
            <Icon name="chevron" size={16} />
          </button>
        ) : operation?.state === "complete" ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void finish()}>
            Открыть проект
            <Icon name="chevron" />
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || operation?.state === "running" || operation?.state === "failed"}
            onClick={() => void execute()}
          >
            {operation?.state === "unknown"
              ? "Проверить и продолжить"
              : input.createDirectory
                ? "Создать проект"
                : "Подключить проект"}
            {busy || operation?.state === "running" ? (
              <span className="spinner" />
            ) : (
              <Icon name="plus" size={17} />
            )}
          </button>
        )}
      </footer>
    </dialog>
  );
}
