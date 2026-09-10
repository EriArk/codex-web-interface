import { lazy, Suspense, useEffect, useState } from "react";

const Workspace = lazy(() => import("./DeviceWorkspace"));
export const openDevices = () => window.dispatchEvent(new Event("open-device-workspace"));
export function DeviceWorkspaceHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true),
      hide = () => setOpen(false);
    window.addEventListener("open-device-workspace", show);
    window.addEventListener("private-session-ended", hide);
    return () => {
      window.removeEventListener("open-device-workspace", show);
      window.removeEventListener("private-session-ended", hide);
    };
  }, []);
  return open ? (
    <Suspense
      fallback={
        <div className="device-loading" role="status">
          Открываем устройства…
        </div>
      }
    >
      <Workspace onClose={() => setOpen(false)} />
    </Suspense>
  ) : null;
}
