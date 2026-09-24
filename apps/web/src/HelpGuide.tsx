import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { helpArticle, helpArticles, helpCategories, searchHelp } from "./helpContent";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import type { HelpTopic } from "./WorkspaceHelp";

type Position = { id: string | null; index: boolean; scroll: number };
export function HelpGuide({ initial, onClose }: { initial: HelpTopic; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    body = useRef<HTMLDivElement>(null),
    catalog = useRef<HTMLElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<Position>({
      id: initial === "home" ? null : initial,
      index: initial === "home",
      scroll: 0,
    }),
    [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(
    () => new Set([helpArticle(initial)?.category ?? "Основы"]),
  );
  const history = useRef<Position[]>([]),
    focusArticle = useRef(false),
    focusIndex = useRef(false);
  useWorkspaceDialog(dialog);
  const article = position.id ? helpArticle(position.id) : undefined;
  const results = query.trim() ? searchHelp(query) : null;
  const open = (id: string) => {
    const selected = helpArticle(id);
    if (!selected) return;
    setExpanded((old) => new Set([...old, selected.category]));
    history.current = [
      ...history.current.slice(-49),
      { ...position, scroll: body.current?.scrollTop ?? 0 },
    ];
    focusArticle.current = true;
    setPosition({ id, index: false, scroll: 0 });
  };
  const index = () => {
    setPosition({ ...position, index: true, scroll: body.current?.scrollTop ?? 0 });
    focusIndex.current = true;
  };
  const back = () => {
    const previous = history.current.pop();
    if (!previous) {
      index();
      return;
    }
    focusArticle.current = !previous.index;
    setPosition(previous);
    focusIndex.current = previous.index;
  };
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = position.scroll;
    if (focusArticle.current) heading.current?.focus({ preventScroll: true });
    if (focusIndex.current) catalog.current?.focus({ preventScroll: true });
    focusArticle.current = false;
    focusIndex.current = false;
  }, [position]);
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window workspace-help"
      aria-label="Справка и клавиши"
      tabIndex={-1}
      data-index={position.index}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="help-heading">
        <h2>Справка</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть справку"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="help-toolbar">
        <button type="button" className="secondary" onClick={index} aria-label="Оглавление справки">
          Оглавление
        </button>
        <button type="button" className="secondary" onClick={() => open("keys")}>
          Клавиши
        </button>
        <label className="help-search">
          <input
            ref={search}
            aria-label="Поиск по справке"
            type="search"
            value={query}
            maxLength={180}
            placeholder="Найти в справке"
            onChange={(e) => {
              setQuery(e.target.value);
              setPosition((old) => ({
                ...old,
                index: true,
                scroll: body.current?.scrollTop ?? old.scroll,
              }));
            }}
          />
        </label>
      </div>
      <div className="help-layout">
        <nav ref={catalog} tabIndex={-1} className="help-index" aria-label="Категории справки">
          {results ? (
            <>
              <p className="help-match-count" role="status">
                Найдено статей: {results.length}
              </p>
              {results.length ? (
                results.map((entry) => (
                  <button
                    type="button"
                    className="help-entry"
                    key={entry.id}
                    onClick={() => open(entry.id)}
                    aria-current={article?.id === entry.id ? "page" : undefined}
                  >
                    <strong>{entry.title}</strong>
                    <small>
                      {entry.category} · {entry.group}
                    </small>
                    <span>{entry.summary}</span>
                  </button>
                ))
              ) : (
                <p>
                  Ничего не найдено. Попробуй название действия: «слияние», «приглашение»,
                  «черновик».
                </p>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setQuery("");
                  search.current?.focus();
                }}
              >
                Сбросить поиск
              </button>
            </>
          ) : (
            helpCategories.map((category) => (
              <details
                key={category}
                open={expanded.has(category)}
                onToggle={(event) => {
                  const opened = event.currentTarget.open;
                  setExpanded((old) => {
                    if (old.has(category) === opened) return old;
                    const next = new Set(old);
                    if (opened) next.add(category);
                    else next.delete(category);
                    return next;
                  });
                }}
              >
                <summary>{category}</summary>
                {[
                  ...new Set(
                    helpArticles
                      .filter((entry) => entry.category === category)
                      .map((entry) => entry.group),
                  ),
                ].map((group) => (
                  <section key={group}>
                    <h3>{group}</h3>
                    {helpArticles
                      .filter((entry) => entry.category === category && entry.group === group)
                      .map((entry) => (
                        <button
                          type="button"
                          className="help-entry"
                          key={entry.id}
                          onClick={() => open(entry.id)}
                          aria-current={article?.id === entry.id ? "page" : undefined}
                        >
                          {entry.title}
                        </button>
                      ))}
                  </section>
                ))}
              </details>
            ))
          )}
        </nav>
        <div className="help-content" ref={body}>
          {article ? (
            <article aria-labelledby="help-article-title">
              <button type="button" className="secondary help-back" onClick={back}>
                <Icon name="back" size={16} />
                Назад
              </button>
              <p className="help-breadcrumb">
                {article.category} · {article.group}
              </p>
              <h2 id="help-article-title" ref={heading} tabIndex={-1}>
                {article.title}
              </h2>
              <p className="help-lead">{article.summary}</p>
              <nav className="help-contents" aria-label="В этой статье">
                {article.sections.map((section, i) => (
                  <button
                    type="button"
                    key={section.title}
                    onClick={() => {
                      const target = body.current?.querySelector<HTMLElement>(
                        `[data-section="${i}"]`,
                      );
                      target?.scrollIntoView({ block: "start" });
                      target?.focus({ preventScroll: true });
                    }}
                  >
                    {section.title}
                  </button>
                ))}
              </nav>
              {article.sections.map((section, i) => (
                <section key={section.title}>
                  <h3 data-section={i} tabIndex={-1}>
                    {section.title}
                  </h3>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.steps && (
                    <ol>
                      {section.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  )}
                  {section.bullets && (
                    <ul>
                      {section.bullets.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
              <nav className="help-related" aria-label="Связанные статьи">
                <h3>Смотри также</h3>
                {article.related.map((id) => (
                  <button type="button" className="secondary" key={id} onClick={() => open(id)}>
                    {helpArticle(id)?.title}
                  </button>
                ))}
              </nav>
            </article>
          ) : (
            <article>
              <h2>Руководство пользователя</h2>
              <p>
                Выбери категорию и подкатегорию в оглавлении или введи вопрос в поиск. Поиск
                учитывает названия и полный текст статей.
              </p>
              <h3>Первое знакомство</h3>
              <p>
                Начни с устройства рабочего места. Если уже знаешь разделы, выбери рабочий пример: у
                каждого есть исходная ситуация, последовательность действий и ожидаемый результат.
              </p>
              <div className="help-related">
                <button type="button" className="secondary" onClick={() => open("start")}>
                  Как устроено рабочее место
                </button>
                {helpArticles
                  .filter((entry) => entry.category === "Рабочие циклы")
                  .map((entry) => (
                    <button
                      type="button"
                      className="secondary"
                      key={entry.id}
                      onClick={() => open(entry.id)}
                    >
                      {entry.title}
                    </button>
                  ))}
              </div>
            </article>
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
