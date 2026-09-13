import type { TeamContact } from "@codex-web/shared";
import { useState } from "react";
import { useSharedResource } from "./sharedResources";

export function TeamContactPicker({
  value,
  onChange,
  disabled,
  exclude = [],
}: {
  value: TeamContact | null;
  onChange: (value: TeamContact) => void;
  disabled?: boolean;
  exclude?: string[];
}) {
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0);
  const contacts = useSharedResource<{ items: TeamContact[]; nextOffset: number | null }>(
    "/team/contacts?" + new URLSearchParams({ q: query, offset: String(offset) }),
  );
  return (
    <fieldset className="team-contacts shared-form" disabled={disabled}>
      <legend>Выбрать человека</legend>
      <input
        type="search"
        aria-label="Найти человека"
        placeholder="Найти по имени…"
        value={query}
        maxLength={100}
        onChange={(e) => {
          setQuery(e.target.value);
          setOffset(0);
        }}
      />
      {value && (
        <p className="muted">
          Выбран: {value.name}
          {value.own ? " · Я" : ""}
        </p>
      )}
      {contacts.error && <p role="alert">{contacts.error}</p>}
      {contacts.loading && !contacts.value && <p role="status">Загружаем контакты…</p>}
      <fieldset className="team-contact-list" aria-label="Пользователи Hub">
        {contacts.value?.items
          .filter((person) => !exclude.includes(person.id))
          .map((person) => (
            <button
              key={person.id}
              type="button"
              className="team-contact secondary"
              aria-pressed={value?.id === person.id}
              onClick={() => onChange(person)}
            >
              <span className="team-contact-avatar" aria-hidden="true">
                {Array.from(person.name.trim())[0]?.toLocaleUpperCase("ru") ?? "•"}
              </span>
              <span>
                {person.name}
                {person.own ? " · Я" : ""}
              </span>
            </button>
          ))}
      </fieldset>
      {contacts.value?.items.length === 0 && <p className="muted">Никого не нашли.</p>}
      <div className="shared-actions">
        {offset > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Предыдущие контакты
          </button>
        )}
        {contacts.value?.nextOffset != null && (
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(contacts.value!.nextOffset!)}
          >
            Ещё контакты
          </button>
        )}
      </div>
    </fieldset>
  );
}
