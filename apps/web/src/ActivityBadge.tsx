import { Icon } from "./icons";

export function ActivityBadge({
  active = 0,
  unread = 0,
  waiting = 0,
  failed = false,
  counts = false,
}: {
  active?: number;
  unread?: number;
  waiting?: number;
  failed?: boolean;
  counts?: boolean;
}) {
  return (
    <span className="activity-badges">
      {(active > 0 || counts) && (
        <span
          className={`activity-badge ${active ? "is-active" : "is-empty"}`}
          role="img"
          aria-label={`Активно: ${active}${waiting ? `, ждут ответа: ${waiting}` : ""}`}
          title={`Активно: ${active}${waiting ? ` · ждут ответа: ${waiting}` : ""}`}
        >
          {active > waiting ? (
            <span className="spinner" />
          ) : waiting ? (
            <Icon name="help" size={15} />
          ) : (
            <Icon name="activity" size={14} />
          )}
          {counts && <b>{active}</b>}
        </span>
      )}
      {(unread > 0 || counts) && (
        <span
          className={`activity-badge ${unread ? "is-unread" : "is-empty"} ${failed ? "needs-attention" : ""}`}
          role="img"
          aria-label={`${failed ? "Требует проверки" : "Завершено, не просмотрено"}: ${unread}`}
          title={`${failed ? "Требует проверки" : "Завершено, не просмотрено"}: ${unread}`}
        >
          <Icon name={failed ? "help" : "check"} size={16} />
          {counts && <b>{unread}</b>}
        </span>
      )}
    </span>
  );
}
