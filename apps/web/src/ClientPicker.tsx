import "./clientPicker.css";
export function ClientPicker({
  value,
  onChange,
}: {
  value: "codex" | "gpt";
  onChange: (value: "codex" | "gpt") => void;
}) {
  return (
    <label className="client-picker">
      <span>{value === "gpt" ? "GPT" : "codex"}</span>
      <select
        aria-label="Режим приложения"
        value={value}
        onChange={(event) => onChange(event.target.value as "codex" | "gpt")}
      >
        <option value="codex">Codex</option>
        <option value="gpt">GPT</option>
      </select>
    </label>
  );
}
