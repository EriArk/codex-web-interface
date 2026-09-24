import type { ProjectScope } from "@codex-web/shared";
import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ActivitySourceTarget, ActivitySourceWindow } from "./ActivitySourceWindow";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { PersonalProjectPicker } from "./SharedPublication";
import { useSharedResource } from "./sharedResources";
import { useWorkspaceDialog } from "./useWorkspaceDialog";

export function HumanReferencePicker({ onChoose }: { onChoose: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(!open)}>
        Ссылка
      </button>
      {open && (
        <ReferenceChoices
          onChoose={(text) => {
            onChoose(text);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
function ReferenceChoices({ onChoose }: { onChoose: (text: string) => void }) {
  const spaces = useSharedResource<{
      spaces: { id: string; title: string; projects: { id: string; name: string }[] }[];
    }>("/team/spaces"),
    rooms = useSharedResource<{ rooms: { id: string; title: string }[] }>("/team/brainstorm");
  const label = (value: string) => value.replace(/[[\]\\\n]/g, " ");
  return (
    <div className="human-reference-choices">
      {spaces.value?.spaces.flatMap((s) =>
        s.projects.map((p) => (
          <button
            type="button"
            className="secondary"
            key={p.id}
            onClick={() => onChoose(`[${label(p.name)}](/#space=${s.id}&project=${p.id})`)}
          >
            {p.name}
          </button>
        )),
      )}
      {rooms.value?.rooms.map((r) => (
        <button
          type="button"
          className="secondary"
          key={r.id}
          onClick={() => onChoose(`[${label(r.title)}](/#room=${r.id})`)}
        >
          Брейншторм · {r.title}
        </button>
      ))}
    </div>
  );
}
export function HumanReferenceLink({ href, children }: { href?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const room = href?.match(/^\/#room=([a-f0-9-]{36})$/),
    project = href?.match(/^\/#space=([a-f0-9-]{36})&project=([a-f0-9-]{36})$/);
  if (room || project)
    return (
      <>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setError("");
            const verify = async () => {
              if (room) await api(`/team/brainstorm/${room[1]}`);
              else {
                const data = await api<{ spaces: { id: string; projects: { id: string }[] }[] }>(
                  "/team/spaces",
                );
                if (
                  !data.spaces.some(
                    (s) => s.id === project![1] && s.projects.some((p) => p.id === project![2]),
                  )
                )
                  throw Error("Проект недоступен твоему аккаунту.");
              }
              window.dispatchEvent(
                new CustomEvent("open-shared-reference", {
                  detail: room
                    ? { kind: "brainstorm", id: room[1] }
                    : { kind: "project", id: project![1], projectId: project![2] },
                }),
              );
            };
            void verify().catch((e) => setError(messageOf(e)));
          }}
        >
          {children}
        </button>
        {error && <span role="alert">{error}</span>}
      </>
    );
  if (href && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*$/.test(href))
    return (
      <>
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          {children}
        </button>
        {open && <GitHubReference url={href} onClose={() => setOpen(false)} />}
      </>
    );
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
function GitHubReference({ url, onClose }: { url: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(ref);
  const [project, setProject] = useState<ProjectScope | null>(null),
    [target, setTarget] = useState<ActivitySourceTarget | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return createPortal(
    <dialog
      ref={ref}
      className="workspace-window result-share-window"
      aria-label="Открыть ссылку GitHub"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="notebook-heading">
        <strong>GitHub</strong>
        <button type="button" className="icon-button" aria-label="Закрыть ссылку" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="result-share-body shared-form">
        <p>Открой через свою рабочую копию этого репозитория.</p>
        <PersonalProjectPicker
          value={project}
          onChange={(p) => {
            setProject(p);
            setTarget(null);
          }}
          codexOnly
          disabled={busy}
        />
        {error && <p role="alert">{error}</p>}
        <button
          type="button"
          className="primary"
          disabled={!project || busy}
          onClick={() => {
            if (!project) return;
            setBusy(true);
            setError("");
            void api<ActivitySourceTarget>("/team/communication/github", {
              method: "POST",
              body: { projectId: project.projectId, url },
            })
              .then(setTarget)
              .catch((e) => setError(messageOf(e)))
              .finally(() => setBusy(false));
          }}
        >
          Открыть внутри приложения
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer">
          Открыть сайт GitHub
        </a>
      </div>
      {target && project && (
        <ActivitySourceWindow
          target={target}
          personalProjectId={project.projectId}
          onClose={() => setTarget(null)}
        />
      )}
    </dialog>,
    document.body,
  );
}
