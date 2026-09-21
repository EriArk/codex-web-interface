import type { ReactNode } from "react";
import { Icon } from "./icons";
import "./navigationHeader.css";

export function NavigationHeader({
  children,
  leading,
  onClose,
}: {
  children: ReactNode;
  leading?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="navigation-top-row navigation-header">
      {leading}
      {children}
      <button
        type="button"
        className="icon-button mobile-only panel-close"
        aria-label="Закрыть проекты"
        data-drawer-close
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
