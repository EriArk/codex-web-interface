import { createRoot } from "react-dom/client";
import App from "./App";
import { applyLayoutPreference } from "./AppearanceSettings";
import { DeviceWorkspaceHost } from "./DeviceWorkspaceHost";
import { GuiPreviewHost } from "./GuiPreviewHost";
import { ProjectDeliveryHost } from "./ProjectDeliveryHost";
import { QuickCaptureHost } from "./QuickCaptureHost";
import { applyTheme, cachedTheme } from "./theme";
import "./fonts.css";
import "./styles.css";
import "./workspace.css";
import "./themes.css";
import "./compact.css";
import "./queue.css";
import "./messageImages.css";
import "./motion.css";
import "./materials.css";
import "./tablet.css";
import "./polymer.css";

applyTheme(cachedTheme());
applyLayoutPreference();
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <>
    <App />
    <DeviceWorkspaceHost />
    <QuickCaptureHost />
    <ProjectDeliveryHost />
    <GuiPreviewHost />
  </>,
);
if ("serviceWorker" in navigator)
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  });
