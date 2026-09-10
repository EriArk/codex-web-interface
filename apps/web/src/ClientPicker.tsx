import { Icon } from "./icons";
import "./clientPicker.css";
export function ClientPicker({
  value,
  onChange,
}: {
  value: "codex" | "gpt";
  onChange: (value: "codex" | "gpt") => void;
}) {
  const next = value === "codex" ? "gpt" : "codex";
  return (
    <button
      type="button"
      className="client-picker"
      data-client={value}
      aria-label={next === "gpt" ? "Переключиться на GPT" : "Переключиться на Codex"}
      title={value === "gpt" ? "GPT" : "Codex"}
      onClick={() => onChange(next)}
    >
      <Icon name={value === "gpt" ? "chat" : "repository"} size={27} />
    </button>
  );
}
