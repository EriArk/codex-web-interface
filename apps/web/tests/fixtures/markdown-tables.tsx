import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownTable } from "../../src/MarkdownTable";
import { useProjectSwipe } from "../../src/useProjectSwipe";
import "../../src/fonts.css";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/project-files.css";

const examples = {
  sections: `| Раздел | Для чего |
| --- | --- |
| **Заметки** | Идеи, ссылки, полезные ответы, наброски. |
| **Задачи** | Твои напоминания: проверить на iPad, подобрать обложки, разобраться с ошибкой. |
| **Планы** | Сохранённые списки работ, которые можно передать Codex/GPT на выполнение. |
| **Основа проекта** | Постоянные требования: назначение, поведение, ограничения, архитектура и предпочтения. |
| **Отчёты** | Зафиксированные итоги очередного этапа работы. |`,
  features: `| Штука | Что получилось |
| --- | --- |
| GPT loading | Теперь существующий чат имеет отдельное состояние загрузки: остаётся его название, есть spinner/retry, а composer скрыт, пока история не готова. Cached history при revalidation не выбрасывается. |
| Project Wizard | Уже настоящий 4-шаговый мастер Проект → Папка → GitHub → Проверка, с сохранением черновика и восстановлением незавершённых setup-операций. |
| Sidebar | Появился отдельный NavigationFooter; Settings слева, Remote справа, а Codex/GPT теперь действительно **одна большая прямая toggle-кнопка**. |
| Project Overview | Переход в Task/Plan/File/etc. делается намеренно. |`,
  wide: `| Устройство | Система | Процессор | Память | Диски | Состояние |
| :--- | :---: | ---: | --- | --- | --- |
| Сервер | Linux | 8 | 16 GB | 2 TB | Работает |
| Компьютер | Windows | 12 | 32 GB | 1 TB | Доступен |`,
  tokens: `| Имя | Значение |
| --- | --- |
| Ссылка | [Документация](https://example.test/docs) |
| Длинный путь | \`${"directory".repeat(60)}\` |
| URL | https://example.test/${"path".repeat(80)} |`,
};

function App() {
  const root = useRef<HTMLElement>(null);
  const [opens, setOpens] = useState(0);
  const [streamed, setStreamed] = useState(false);
  useProjectSwipe(root, true, () => setOpens((n) => n + 1));
  return (
    <main ref={root} style={{ maxWidth: 720, margin: "auto", padding: 12 }}>
      <p data-testid="edge">
        Таблицы · меню: <span data-testid="opens">{opens}</span>
      </p>
      <textarea aria-label="Черновик" defaultValue="Мой черновик" />
      <button type="button" onClick={() => setStreamed(true)}>
        Продолжить ответ
      </button>
      {[
        ["codex", ""],
        ["gpt", "gpt-chat"],
        ["readme", "inspector-markdown"],
      ].map(([client, className]) => (
        <section key={client} className={className} data-client={client}>
          <h2>{client}</h2>
          {Object.entries(examples).map(([id, text]) => (
            <article key={id} className="message" data-example={id}>
              <div className="message-body">
                <Markdown remarkPlugins={[remarkGfm]} components={{ table: MarkdownTable }}>
                  {text +
                    (streamed && id === "features"
                      ? "\n| Новый ответ | Текст продолжения ответа. |"
                      : "")}
                </Markdown>
              </div>
            </article>
          ))}
        </section>
      ))}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App />);
