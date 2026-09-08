import { createRoot } from "react-dom/client";
import { configureApi } from "../../src/api";
import { DownloadLink } from "../../src/DownloadLink";
import "../../src/styles.css";
import "../../src/themes.css";

const session = await fetch("/api/auth/session").then((r) => r.json());
configureApi(session.csrf, () => {});
const query = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 16, height: "100dvh", overflow: "auto" }}>
    <textarea aria-label="Draft" defaultValue="Preserve this draft" />
    <div style={{ height: 400 }} />
    <DownloadLink href={query.get("file")!} name={query.get("name")!}>
      Открыть файл
    </DownloadLink>
    <div style={{ height: 1500 }}>Same chat</div>
  </main>,
);
