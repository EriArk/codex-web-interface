import { type ComponentProps, isValidElement, type ReactNode } from "react";
import { CopyButton } from "./CopyButton";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}
export function CollapsibleCode({
  children,
  label = "Показать код",
}: ComponentProps<"pre"> & { label?: string }) {
  return (
    <div className="copyable-block">
      <details className="code-disclosure">
        <summary>{label}</summary>
        <pre>{children}</pre>
      </details>
      <CopyButton text={textOf(children)} label="Копировать блок" />
    </div>
  );
}
