import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { HelpButton } from "./WorkspaceHelp";
import "./settings-sections.css";

export type SettingsCategory =
  | "appearance"
  | "sound"
  | "connections"
  | "library"
  | "maintenance"
  | "access";
const categories = [
  { id: "appearance", title: "Оформление", hint: "Тема, цвета и компоновка", icon: "settings" },
  { id: "sound", title: "Звук и уведомления", hint: "Озвучивание и оповещения", icon: "speaker" },
  { id: "connections", title: "Подключения", hint: "Codex, GPT и компьютеры", icon: "remote" },
  { id: "library", title: "Проекты и история", hint: "Обновление списков и архив", icon: "folder" },
  {
    id: "maintenance",
    title: "Обслуживание",
    hint: "Обновления, диагностика и место",
    icon: "activity",
  },
  { id: "access", title: "Доступ", hint: "Пароль и вход на устройствах", icon: "lock" },
] as const;

/** One settings hierarchy for both clients. Hidden sections keep forms and operation state. */
export function SettingsSections({
  open,
  onClose,
  sections,
  overview,
}: {
  open: boolean;
  onClose: () => void;
  sections: Record<SettingsCategory, (visible: boolean) => ReactNode>;
  overview?: (visible: boolean) => ReactNode;
}) {
  const [selected, setSelected] = useState<SettingsCategory | null>(null);
  const active = selected ?? "appearance",
    prefix = useId();
  const content = useRef<HTMLDivElement>(null),
    nav = useRef<HTMLElement>(null);
  const previous = useRef<SettingsCategory | null>(null);
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 759px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width: 759px)");
    const changed = () => setCompact(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const overviewVisible = open && (compact ? selected === null : active !== "connections");
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);
  useLayoutEffect(() => {
    if (open && selected) content.current?.focus({ preventScroll: true });
    else if (open && previous.current)
      nav.current
        ?.querySelector<HTMLButtonElement>(`[data-category="${previous.current}"]`)
        ?.focus({ preventScroll: true });
    previous.current = selected;
  }, [selected, open]);
  return (
    <div className="settings-sections" data-help-context="home" data-detail={selected !== null}>
      <div className="dialog-heading settings-heading">
        <button
          type="button"
          className="icon-button panel-close settings-back"
          aria-label="Все категории настроек"
          onClick={() => setSelected(null)}
        >
          <Icon name="back" />
        </button>
        <h2>
          <span className="settings-index-title">Настройки</span>
          <span className="settings-detail-title">
            {categories.find((c) => c.id === active)?.title}
          </span>
        </h2>
        <HelpButton />
        <button
          type="button"
          className="icon-button panel-close"
          onClick={onClose}
          aria-label="Закрыть настройки"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-layout">
        <div className="settings-overview">
          <nav ref={nav} className="settings-categories" aria-label="Категории настроек">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                data-category={category.id}
                aria-current={active === category.id ? "page" : undefined}
                aria-controls={prefix + category.id}
                onClick={() => setSelected(category.id)}
              >
                <span className="settings-category-icon">
                  <Icon name={category.icon} />
                </span>
                <span>
                  <strong>{category.title}</strong>
                  <small>{category.hint}</small>
                </span>
                <Icon name="chevron" size={16} />
              </button>
            ))}
          </nav>
          {overview && (
            <div className="settings-usage-summary" hidden={!overviewVisible}>
              {overviewVisible && overview(true)}
            </div>
          )}
        </div>
        <div ref={content} className="settings-content" tabIndex={-1}>
          {categories.map((category) => (
            <section
              key={category.id}
              id={prefix + category.id}
              className="settings-section"
              hidden={active !== category.id}
              aria-labelledby={prefix + category.id + "-title"}
            >
              <h3 id={prefix + category.id + "-title"} className="settings-section-title">
                {category.title}
              </h3>
              {sections[category.id](
                open && active === category.id && (!compact || selected !== null),
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
