import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./workspace-window.css";
import "./workspace-help.css";

const topics = {
  codex: {
    title: "Чат Codex",
    paragraphs: [
      "Выбери проект и разговор. Модель, режим и уровень размышления задаются рядом с полем сообщения.",
      "Файлы прикрепляются кнопкой «+». Результаты работы доступны в «Результатах»; на файл или картинку можно нажать прямо в сообщении.",
      "Во время работы доступны очередь и остановка. Изменение настроек очереди относится к следующим сообщениям.",
    ],
  },
  gpt: {
    title: "Чат GPT",
    paragraphs: [
      "Выбери разговор или создай новый. Модель и уровень размышления находятся рядом с полем сообщения.",
      "Ответы остаются в чате, промежуточные публичные действия — в раскрываемом ходе работы и «Результаты → Рассуждения».",
      "Если отправка не подтверждена, сначала проверь, пришло ли сообщение. Сохранённый текст можно вернуть в черновик; повторная отправка остаётся твоим решением. Другие разговоры продолжают работать независимо.",
    ],
  },
  results: {
    title: "Результаты",
    paragraphs: [
      "Нажми на название файла или картинку, чтобы открыть просмотрщик. Закрытие вернёт к той же ленте.",
      "Отправка и скачивание находятся на карточке. Короткие текстовые блоки остаются в сообщении, крупные имеют ссылку на результат.",
    ],
  },
  files: {
    title: "Файлы и просмотр",
    paragraphs: [
      "Файл открывается в общем просмотрщике. Свойства и разворачивание — в заголовке, действия с оригиналом — внизу.",
      "Для текстового файла доступен редактор с подсветкой. Рабочий файл редактируется на своём месте; вложение или результат открывается как копия с выбором места сохранения.",
      "ZIP открывает папки и вложенные файлы. DOCX и XLSX показывают содержимое без полного воспроизведения оформления Office. Ограничение предпросмотра не запрещает скачивание оригинала.",
      "При совпадении имени загрузка предлагает заменить файл, сохранить оба или пропустить.",
    ],
  },
  editor: {
    title: "Редактор",
    paragraphs: [
      "Изменения сохраняются явно. Для копии выбери место сохранения или скачай её; исходное вложение от этого не меняется.",
      "Если файл изменился с момента открытия, сравни версии и выбери действие. Ручная работа с файлами доступна и во время задачи Codex.",
      "Встроенное редактирование GitHub завершается проверкой изменений и коммитом в выбранную ветку.",
    ],
  },
  shared: {
    title: "Общие и общение",
    paragraphs: [
      "В «Общие» сначала выбери пространство и проект. Личное рабочее место сохраняется отдельно.",
      "В «Общение» нажми на человека для личного разговора. Именная группа создаётся отдельным действием.",
      "«Полный доступ» к проекту включает GitHub Write. Если требуется приглашение, участник принимает его своей учётной записью внутри приложения.",
    ],
  },
  brainstorm: {
    title: "Брейншторм",
    paragraphs: [
      "На планшете и компьютере двигай карточку за заголовок. Для соединения используй точку связи на карточке; на телефоне связи доступны как переходы между карточками.",
      "Рисуй внутри области рисунка. За её пределами остаётся обычная прокрутка. Отмена жеста не сохраняет случайное перемещение.",
    ],
  },
  activity: {
    title: "Активность и уведомления",
    paragraphs: [
      "Фильтры выбирают проект и автора. Обновление добавляет новые события, сохраняя загруженную ленту и её положение.",
      "Issue, PR и коммиты открываются во встроенном GitHub. Обсуждение в GPT и изучение в Codex запускаются отдельными кнопками.",
    ],
  },
} as const;
export type HelpTopic = keyof typeof topics;
const isTopic = (value: unknown): value is HelpTopic =>
  typeof value === "string" && Object.hasOwn(topics, value);
const eventName = "workspace-open-help";
export function HelpButton({ topic }: { topic?: HelpTopic }) {
  return (
    <button
      type="button"
      className="icon-button workspace-help-button"
      aria-label="Справка и клавиши"
      title="Справка и клавиши (F1)"
      onClick={() => window.dispatchEvent(new CustomEvent(eventName, { detail: topic }))}
    >
      <Icon name="help" />
    </button>
  );
}
export function WorkspaceHelp({ topic = "codex" }: { topic?: HelpTopic }) {
  const [opened, setOpened] = useState<HelpTopic | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent).detail;
      setOpened(isTopic(requested) ? requested : topic);
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "F1" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.repeat ||
        event.defaultPrevented
      )
        return;
      // Remote/terminal surfaces own their keyboard. Do not steal keys from those sessions.
      const active = document.activeElement;
      if (active?.closest('[data-help-keys="remote"], .remote-pane, .remote-view, .xterm')) return;
      const modal = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
      if (
        !modal &&
        Array.from(document.querySelectorAll(".remote-session")).some(
          (element) => element.getClientRects().length,
        )
      )
        return;
      const context =
        active?.closest<HTMLElement>("[data-help-context]")?.dataset.helpContext ??
        modal?.dataset.helpContext ??
        modal?.querySelector<HTMLElement>("[data-help-context]")?.dataset.helpContext;
      event.preventDefault();
      if (!document.querySelector(".workspace-help[open]"))
        setOpened(isTopic(context) ? context : topic);
    };
    window.addEventListener(eventName, open);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener(eventName, open);
      window.removeEventListener("keydown", key);
    };
  }, [topic]);
  return opened ? <HelpDialog initial={opened} onClose={() => setOpened(null)} /> : null;
}
function HelpDialog({ initial, onClose }: { initial: HelpTopic; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    [topic, setTopic] = useState(initial),
    [tab, setTab] = useState("guide");
  useWorkspaceDialog(dialog);
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window workspace-help"
      aria-label="Справка и клавиши"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="help-heading">
        <h2>Справка</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть справку"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <nav className="help-tabs" aria-label="Раздел справки">
        <button type="button" aria-pressed={tab === "guide"} onClick={() => setTab("guide")}>
          По разделам
        </button>
        <button type="button" aria-pressed={tab === "keys"} onClick={() => setTab("keys")}>
          Клавиши
        </button>
      </nav>
      <div className="help-content">
        {tab === "guide" ? (
          <>
            <label className="help-topic">
              Раздел
              <select
                value={topic}
                onChange={(e) => {
                  if (isTopic(e.target.value)) setTopic(e.target.value);
                }}
              >
                {Object.entries(topics).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.title}
                  </option>
                ))}
              </select>
            </label>
            <h3>{topics[topic].title}</h3>
            {topics[topic].paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </>
        ) : (
          <>
            <p>
              На Mac используй ⌘ вместо Ctrl. Сочетания редактора работают, когда курсор находится в
              тексте файла.
            </p>
            <dl className="help-keys">
              {[
                ["F1", "Открыть справку текущего окна"],
                ["Esc", "Закрыть верхнее окно; несохранённые изменения могут потребовать решения"],
                ["Ctrl / ⌘ + Enter", "Отправить сообщение в Codex или GPT из поля ввода"],
                ["Enter", "Новая строка в сообщении"],
                ["Ctrl / ⌘ + S", "Сохранить файл или перейти к выбору места / проверке изменений"],
                ["Ctrl / ⌘ + F", "Поиск в редакторе файла"],
                ["Ctrl / ⌘ + Z", "Отменить изменение текста"],
                ["Tab / Shift + Tab", "Перейти между элементами; в редакторе — изменить отступ"],
                ["← / →", "Изменить ширину панели, когда выбран разделитель"],
              ].map(([keys, description]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
            <p>
              В удалённом рабочем столе и терминале клавиши относятся к подключённому компьютеру.
            </p>
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
