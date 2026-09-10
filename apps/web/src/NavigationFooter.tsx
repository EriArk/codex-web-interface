import { ClientPicker } from "./ClientPicker";
import { openDevices } from "./DeviceWorkspaceHost";
import { Icon } from "./icons";
export function NavigationFooter({
  client,
  onClient,
  onSettings,
  onRemote,
  remoteHref,
}: {
  client: "codex" | "gpt";
  onClient?: (value: "codex" | "gpt") => void;
  onSettings: () => void;
  onRemote?: () => void;
  remoteHref?: string;
}) {
  return (
    <div className="navigation-system-row">
      <button
        type="button"
        className="nav-settings"
        onClick={onSettings}
        aria-label="Настройки"
        title="Настройки"
      >
        <Icon name="settings" size={19} />
        <span className="nav-settings-label">Настройки</span>
      </button>
      <div className="navigation-mode-controls">
        <button
          type="button"
          className="icon-button"
          onClick={openDevices}
          aria-label="Открыть устройства"
          title="Устройства"
        >
          <Icon name="terminal" />
        </button>
        {remoteHref ? (
          <a
            className="icon-button nav-remote"
            href={remoteHref}
            aria-label="Открыть Remote"
            title="Remote"
          >
            <Icon name="remote" />
          </a>
        ) : (
          onRemote && (
            <button
              type="button"
              className="icon-button nav-remote"
              onClick={onRemote}
              aria-label="Открыть Remote"
              title="Remote"
            >
              <Icon name="remote" />
            </button>
          )
        )}
        {onClient && <ClientPicker value={client} onChange={onClient} />}
      </div>
    </div>
  );
}
