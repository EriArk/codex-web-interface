import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import type { Capabilities, TurnSettings } from "./types";

const efforts: Record<string, string> = {
  none: "Выключено",
  minimal: "Минимально",
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
  xhigh: "Очень высокое",
  max: "Максимум",
  ultra: "Ультра",
};
const cache = new Map<string, Capabilities>();
export function useTurnSettings(projectId: string, threadId: string, saved?: TurnSettings) {
  const [caps, setCaps] = useState<Capabilities | undefined>(cache.get(projectId));
  const [selection, setSelection] = useState<TurnSettings | undefined>(saved);
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const current = useRef(threadId);
  current.current = threadId;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    setLoading(true);
    setError("");
    const stored = cache.get(projectId);
    setCaps(stored);
    void (
      stored && revision === 0
        ? Promise.resolve(stored)
        : api<Capabilities>(`/projects/${projectId}/capabilities`)
    )
      .then((value) => {
        if (disposed) return;
        cache.set(projectId, value);
        setCaps(value);
      })
      .catch((e) => {
        if (!disposed) setError(messageOf(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [projectId, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A thread switch must reset an unsaved local selection.
  useEffect(() => {
    setSelection(saved ?? caps?.defaults);
    setSaving(false);
  }, [threadId, saved, caps]);
  const change = async (value: TurnSettings) => {
    if (!threadId || saving) return;
    const id = threadId;
    setSaving(true);
    setError("");
    setSelection(value);
    try {
      await api(`/threads/${id}/settings`, { method: "PATCH", body: value });
    } catch (e) {
      if (current.current === id) {
        setError(messageOf(e));
        setSelection(saved ?? caps?.defaults);
      }
    } finally {
      if (current.current === id) setSaving(false);
    }
  };
  return {
    caps,
    selection,
    loading,
    saving,
    error,
    change,
    reload: () => setRevision((v) => v + 1),
  };
}
export function ComposerOptions({
  options,
  disabled,
}: {
  options: ReturnType<typeof useTurnSettings>;
  disabled: boolean;
}) {
  const { caps, selection, loading, saving, error, change, reload } = options;
  const model = caps?.models.find((m) => m.id === selection?.model);
  if (!caps || !selection)
    return (
      <div className="composer-options options-loading">
        <span>{loading ? "Загружаем модели…" : error || "Выбери проект"}</span>
        {error && (
          <button type="button" className="text-button" onClick={reload}>
            Повторить
          </button>
        )}
      </div>
    );
  return (
    <>
      <div className="composer-options">
        <div className="composer-option model-option">
          <span aria-hidden="true">{model?.name ?? selection.model}</span>
          <select
            aria-label="Модель Codex"
            value={selection.model}
            disabled={disabled || saving}
            onChange={(e) => {
              const model = caps.models.find((m) => m.id === e.target.value);
              if (model)
                void change({
                  ...selection,
                  model: model.id,
                  effort: model.efforts.includes(selection.effort)
                    ? selection.effort
                    : model.defaultEffort,
                });
            }}
          >
            {caps.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="composer-option mode-option">
          <span aria-hidden="true">{selection.mode === "plan" ? "План" : "Работа"}</span>
          <select
            className="mode-select"
            aria-label="Режим Codex"
            value={selection.mode}
            disabled={disabled || saving}
            onChange={(e) =>
              void change({ ...selection, mode: e.target.value as TurnSettings["mode"] })
            }
          >
            {caps.modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode === "plan" ? "План" : "Работа"}
              </option>
            ))}
          </select>
        </div>
        <div className="composer-option effort-option">
          <span aria-hidden="true">{efforts[selection.effort] ?? selection.effort}</span>
          <select
            className="effort-select"
            aria-label="Уровень размышления"
            value={selection.effort}
            disabled={disabled || saving}
            onChange={(e) =>
              void change({ ...selection, effort: e.target.value as TurnSettings["effort"] })
            }
          >
            {model?.efforts.map((e) => (
              <option key={e} value={e}>
                {efforts[e] ?? e}
              </option>
            ))}
          </select>
        </div>
      </div>
      {selection.mode === "plan" && (
        <div className="composer-mode-hint">Планируем и уточняем задачу перед реализацией.</div>
      )}
      {error && (
        <div className="composer-error" role="alert">
          {error}
          <button type="button" className="text-button" onClick={reload}>
            Обновить модели
          </button>
        </div>
      )}
    </>
  );
}
