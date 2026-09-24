import {
  type AgentProfile,
  type AgentProfileSnapshot,
  agentEmphases,
  agentFieldLabels,
  agentProfileOptions,
  agentProfileSchema,
  agentProfileSummary,
  agentTemplate,
  type ProjectRules,
  renderProjectRules,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountSessionStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { ProjectRulesEditor } from "./ProjectRulesEditor";
import "./agent-profile.css";

const empty: ProjectRules = { enabled: [], custom: "" };
export function AgentProfileEditor({
  value,
  onChange,
}: {
  value: AgentProfile | null;
  onChange: (v: AgentProfile | null) => void;
}) {
  const remembered = useRef<AgentProfile | null>(value);
  if (value) remembered.current = value;
  const field = (key: keyof typeof agentFieldLabels) =>
    value && (
      <label key={key}>
        {agentFieldLabels[key]}
        <select
          aria-label={agentFieldLabels[key]}
          value={value[key]}
          onChange={(e) =>
            onChange(
              key === "template"
                ? {
                    ...agentTemplate(e.target.value as AgentProfile["template"]),
                    customRules: value.customRules,
                  }
                : { ...value, [key]: e.target.value },
            )
          }
        >
          {Object.entries(agentProfileOptions[key]).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <div className="agent-profile-editor">
      <label className="agent-check">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) =>
            onChange(e.target.checked ? (remembered.current ?? agentTemplate()) : null)
          }
        />
        Использовать профиль поведения
      </label>
      {!value && (
        <p className="muted">
          Обычные правила проекта продолжают действовать. Профиль добавляет твои предпочтения для
          Codex и GPT.
        </p>
      )}
      {value && (
        <>
          <div className="agent-fields">
            {field("template")}
            {field("quality")}
            {field("style")}
            {field("order")}
          </div>
          <p className="muted">
            Шаблон задаёт начальные значения. «Сначала контракты» — от основы к интерфейсу; рабочий
            сценарий — одна функция целиком; UI-прототип — сначала макет.
          </p>
          <details>
            <summary>Рабочий процесс</summary>
            <div className="agent-fields">
              {field("verification")}
              {field("commits")}
              {field("publication")}
              {field("documentation")}
              {field("interaction")}
            </div>
            <label className="agent-check">
              <input
                type="checkbox"
                checked={value.pullRequest}
                onChange={(e) => onChange({ ...value, pullRequest: e.target.checked })}
              />
              Подготовить PR по завершении
            </label>
          </details>
          <details>
            <summary>Инженерные приоритеты · {value.emphases.length}</summary>
            <div className="agent-fields">
              {Object.entries(agentEmphases).map(([id, label]) => (
                <label className="agent-check" key={id}>
                  <input
                    type="checkbox"
                    checked={value.emphases.includes(id as keyof typeof agentEmphases)}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        emphases: e.target.checked
                          ? [...value.emphases, id as keyof typeof agentEmphases]
                          : value.emphases.filter((v) => v !== id),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </details>
          <label>
            Дополнительные правила
            <textarea
              aria-label="Дополнительные правила агента"
              rows={5}
              maxLength={4000}
              value={value.customRules}
              onChange={(e) => onChange({ ...value, customRules: e.target.value })}
              placeholder="Например: сохраняй совместимость API, предпочитай Qt, учитывай слабые устройства…"
            />
          </label>
          <details>
            <summary>Итоговый профиль</summary>
            <ul>
              {agentProfileSummary(value).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
export function ProfilePreview({ rules }: { rules: ProjectRules }) {
  return (
    <details className="agent-preview">
      <summary>Просмотр CODEXWEB.md</summary>
      <pre>{renderProjectRules(rules) || "Дополнительных правил нет — файл не нужен."}</pre>
    </details>
  );
}
export function AdvancedAgentSettings({
  value,
  onChange,
}: {
  value: AgentProfile | null;
  onChange: (v: AgentProfile | null) => void;
}) {
  return (
    <details className="agent-advanced">
      <summary>Дополнительные настройки…</summary>
      <AgentProfileEditor value={value} onChange={onChange} />
      <ProfilePreview rules={{ ...empty, agentProfile: value }} />
    </details>
  );
}
export function AgentProfileButton({ projectId, name }: { projectId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="overview-row secondary" onClick={() => setOpen(true)}>
        <Icon name="settings" />
        <span>Поведение ИИ</span>
      </button>
      {open && (
        <AgentProfileWindow
          key={projectId}
          projectId={projectId}
          name={name}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function AgentProfileWindow({
  projectId,
  name,
  onClose,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    live = useRef(true),
    lock = useRef(false);
  const [snapshot, setSnapshot] = useState<AgentProfileSnapshot | null>(null),
    [rules, setRules] = useState<ProjectRules | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [review, setReview] = useState(false);
  const path = `/projects/${encodeURIComponent(projectId)}/agent-profile`,
    key = `agent-profile:${projectId}`;
  useEffect(() => {
    live.current = true;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    const abort = new AbortController();
    void api<AgentProfileSnapshot>(path, { signal: abort.signal })
      .then((data) => {
        if (abort.signal.aborted) return;
        let draft: ProjectRules = data.rules;
        try {
          const d = JSON.parse(storage.getItem(key) ?? "null");
          if (
            d?.binding === data.binding &&
            Array.isArray(d.rules?.enabled) &&
            typeof d.rules?.custom === "string" &&
            (!d.rules.agentProfile || agentProfileSchema.safeParse(d.rules.agentProfile).success)
          )
            draft = d.rules;
        } catch {}
        setSnapshot(data);
        setRules(draft);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(messageOf(e));
      });
    return () => {
      live.current = false;
      abort.abort();
      dialog.current?.close();
    };
  }, [path, key]);
  const change = (v: ProjectRules) => {
    setRules(v);
    setReview(false);
    setSaved(false);
    if (snapshot)
      try {
        storage.setItem(key, JSON.stringify({ binding: snapshot.binding, rules: v }));
      } catch {}
  };
  const refresh = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await api<AgentProfileSnapshot>(path);
      if (live.current) {
        setSnapshot(data);
        setRules((old) => old ?? data.rules);
        setReview(false);
      }
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const save = async (cancel = false) => {
    if (!snapshot || !rules || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await api<AgentProfileSnapshot>(path + (cancel ? "/cancel" : ""), {
        method: cancel ? "POST" : "PUT",
        body: cancel
          ? { revision: snapshot.revision, binding: snapshot.binding }
          : {
              rules,
              revision: snapshot.revision,
              fingerprint: snapshot.file.fingerprint,
              binding: snapshot.binding,
            },
      });
      if (live.current) {
        setSnapshot(data);
        if (!cancel) setRules(data.rules);
        setSaved(!cancel);
        setReview(false);
        if (!cancel) storage.removeItem(key);
      }
    } catch (e) {
      if (live.current) {
        setError(messageOf(e));
        setReview(false);
        try {
          setSnapshot(await api<AgentProfileSnapshot>(path));
        } catch {}
      }
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const changed = !!snapshot && !!rules && JSON.stringify(snapshot.rules) !== JSON.stringify(rules);
  const semantic = (v: ProjectRules) =>
    v.agentProfile ? agentProfileSummary(v.agentProfile) : ["Без дополнительного профиля"];
  const next = rules ? renderProjectRules(rules) : "";
  return createPortal(
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="workspace-window agent-profile-window"
      aria-label="Поведение ИИ проекта"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="notebook-heading">
        <div>
          <strong>Поведение ИИ</strong>
          <small title={name}>{name}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть профиль"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="shared-scroll agent-profile-body">
        <p className="muted">
          Для следующих запросов Codex и GPT. Личный CODEXWEB.md остаётся вне Git; права и AGENTS.md
          не меняются.
        </p>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {!snapshot && !error && <p role="status">Загружаю профиль…</p>}
        {snapshot && rules && (
          <>
            {(snapshot.pending || !snapshot.file.editable) && (
              <p role="status">
                {snapshot.pending
                  ? "Проверяем результат прошлого сохранения. Повторной записи не будет."
                  : snapshot.file.reason}
              </p>
            )}
            <fieldset disabled={busy || snapshot.pending}>
              <AgentProfileEditor
                value={rules.agentProfile ?? null}
                onChange={(v) => change({ ...rules, agentProfile: v })}
              />
              <details>
                <summary>Дополнительные пожелания проекта</summary>
                <ProjectRulesEditor value={rules} onChange={change} />
              </details>
              <ProfilePreview rules={rules} />
            </fieldset>
            {(review || !snapshot.file.editable) && (
              <section className="agent-comparison" aria-label="Изменения профиля">
                <div>
                  <h3>Сейчас</h3>
                  <ul>
                    {semantic(snapshot.rules).map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                  <details open={!snapshot.file.editable}>
                    <summary>Текущий файл</summary>
                    <pre>{snapshot.file.content || "Файла нет"}</pre>
                  </details>
                </div>
                <div>
                  <h3>После применения</h3>
                  <ul>
                    {semantic(rules).map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                  <details open={!snapshot.file.editable}>
                    <summary>Новый файл</summary>
                    <pre>{next || "Файл будет удалён"}</pre>
                  </details>
                </div>
                {!snapshot.file.editable && (
                  <details>
                    <summary>Сохранённая версия для разрешения конфликта</summary>
                    <pre>{snapshot.savedContent || "Файла не было"}</pre>
                  </details>
                )}
              </section>
            )}
            {saved && <p role="status">Профиль сохранён. Он применится к следующим запросам.</p>}
          </>
        )}
      </div>
      <footer className="agent-profile-footer">
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>
          Обновить сравнение
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || (!snapshot?.pending && (!changed || !snapshot?.file.editable))}
          onClick={() =>
            snapshot?.pending ? void save(true) : review ? void save() : setReview(true)
          }
        >
          {busy
            ? "Сохраняю…"
            : snapshot?.pending
              ? "Отменить сохранение"
              : review
                ? "Применить профиль"
                : "Сравнить изменения"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
