import { z } from "zod";
import { type ProjectRules, projectRuleLabels } from "./project-gpt.js";

export const agentProfileOptions = {
  template: {
    general: "Общий проект",
    web: "Веб-приложение",
    backend: "Сервер / API",
    desktop: "Десктоп",
    tooling: "CLI / библиотека",
    hardware: "Устройства / прошивки",
    game: "Игра",
    research: "Исследование / прототип",
  },
  quality: { prototype: "Прототип", balanced: "Сбалансированно", production: "К эксплуатации" },
  style: {
    conservative: "Бережные изменения",
    balanced: "Сбалансированно",
    proactive: "Улучшать по ходу задачи",
  },
  order: {
    contracts: "Сначала контракты и основа",
    vertical: "Один рабочий сценарий целиком",
    ui: "Сначала прототип интерфейса",
  },
  verification: {
    smoke: "Основные проверки",
    normal: "Обычные проверки проекта",
    strict: "Подробная проверка",
  },
  commits: { completion: "По завершении работы", checkpoints: "На содержательных этапах" },
  publication: {
    ask: "Согласовывать отправку и PR",
    authorized: "По разрешённому процессу проекта",
  },
  documentation: {
    changes: "При изменении поведения",
    notes: "Краткие заметки реализации",
    architecture: "Архитектура и решения",
    minimal: "Минимум для прототипа",
  },
  interaction: {
    autonomous: "Решать самостоятельно в рамках задачи",
    architecture: "Согласовывать архитектурные решения",
  },
} as const;
export const agentEmphases = {
  compatibility: "Совместимость",
  security: "Безопасность",
  performance: "Производительность",
  accessibility: "Доступность интерфейса",
  offline: "Работа без сети",
  mobile: "Мобильный интерфейс",
  resources: "Слабые устройства",
  reproducibility: "Воспроизводимость",
  hardware: "Физические ограничения",
} as const;
const choice = <T extends Record<string, string>>(options: T) =>
  z.enum(Object.keys(options) as [keyof T & string, ...(keyof T & string)[]]);
export const agentProfileSchema = z
  .object({
    version: z.literal(1),
    template: choice(agentProfileOptions.template),
    quality: choice(agentProfileOptions.quality),
    style: choice(agentProfileOptions.style),
    order: choice(agentProfileOptions.order),
    verification: choice(agentProfileOptions.verification),
    commits: choice(agentProfileOptions.commits),
    publication: choice(agentProfileOptions.publication),
    pullRequest: z.boolean(),
    documentation: choice(agentProfileOptions.documentation),
    interaction: choice(agentProfileOptions.interaction),
    emphases: z
      .array(choice(agentEmphases))
      .max(9)
      .refine((v) => new Set(v).size === v.length),
    customRules: z.string().max(4000),
  })
  .strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export function agentTemplate(template: AgentProfile["template"] = "general"): AgentProfile {
  const p: AgentProfile = {
    version: 1,
    template,
    quality: "balanced",
    style: "balanced",
    order: "contracts",
    verification: "normal",
    commits: "completion",
    publication: "ask",
    pullRequest: false,
    documentation: "changes",
    interaction: "autonomous",
    emphases: [],
    customRules: "",
  };
  if (template === "web") p.emphases = ["mobile", "accessibility"];
  if (template === "backend") p.emphases = ["security", "compatibility"];
  if (template === "desktop") p.emphases = ["offline", "accessibility"];
  if (template === "tooling") p.emphases = ["compatibility", "reproducibility"];
  if (template === "hardware") {
    p.emphases = ["hardware", "resources", "reproducibility"];
    p.verification = "strict";
    p.interaction = "architecture";
  }
  if (template === "game") {
    p.emphases = ["performance"];
    p.order = "vertical";
  }
  if (template === "research") {
    p.quality = "prototype";
    p.verification = "smoke";
    p.documentation = "notes";
  }
  return p;
}
export const agentFieldLabels = {
  template: "Шаблон",
  quality: "Качество",
  style: "Стиль работы",
  order: "Порядок разработки",
  verification: "Проверки",
  commits: "Коммиты",
  publication: "Отправка и PR",
  documentation: "Документация",
  interaction: "Самостоятельность",
} as const;
export function agentProfileSummary(p: AgentProfile): string[] {
  return [
    ...Object.entries(agentFieldLabels).map(
      ([key, label]) =>
        `${label}: ${(agentProfileOptions[key as keyof typeof agentProfileOptions] as Record<string, string>)[p[key as keyof typeof agentFieldLabels]]}`,
    ),
    `Подготовить PR по завершении: ${p.pullRequest ? "да" : "нет"}`,
    `Приоритеты: ${p.emphases.map((e) => agentEmphases[e]).join(", ") || "общие"}`,
  ];
}
export function agentProfileInstructions(p: AgentProfile): string {
  return [
    "## Профиль поведения проекта",
    ...agentProfileSummary(p).map((s) => `- ${s}`),
    "Завершай связанный рабочий этап целиком; на передаче результата называй оставшиеся вопросы и непроверенные предположения.",
    p.quality === "prototype"
      ? "Помечай временные решения и ограничения прототипа."
      : "Предусматривай ошибки и восстановление; не выдавай заглушки за готовое поведение.",
    p.style === "proactive"
      ? "Улучшай соседний код только когда это необходимо для задачи или явно уменьшает её риск; несвязанный рефакторинг не разрешён."
      : "Сохраняй архитектуру и ограничивай изменения задачей.",
    "Находи реальные команды проекта. Минимальные проверки не отменяют обязательные проверки; UI-прототип не означает готовый backend. Отдельно указывай реализованное, проверенное, развёрнутое и принятое на устройстве.",
    p.publication === "ask"
      ? "Перед push или созданием PR запроси подтверждение владельца."
      : "Публикуй только в уже разрешённых рамках через обычный процесс проекта с точной идентичностью репозитория, пользователя и подтверждением результата; неизвестные операции не повторяй.",
    "Профиль не даёт прав и не отменяет AGENTS.md, ограничения доступа, проверки конфликтов, обязательные подтверждения и действующую политику совместной работы. Не делай force push или merge на основании профиля.",
    p.customRules ? `### Дополнительные правила владельца\n${p.customRules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
export function renderProjectRules(rules: ProjectRules): string {
  if (!rules.enabled.length && !rules.custom && !rules.agentProfile) return "";
  return (
    [
      "<!-- CodexWeb: personal project rules -->",
      "# CODEXWEB",
      "",
      "Read this alongside AGENTS.md. These are this user's optional project preferences.",
      ...rules.enabled.map((r) => `- ${projectRuleLabels[r]}`),
      rules.custom,
      rules.agentProfile ? agentProfileInstructions(rules.agentProfile) : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}
export type ProjectRulesFile = {
  path: "CODEXWEB.md";
  fingerprint: string | null;
  content: string;
  editable: boolean;
  reason?: string;
  receipt?: "running" | "complete" | "failed" | "unknown";
};
export type AgentProfileSnapshot = {
  projectId: string;
  revision: number;
  rules: ProjectRules;
  file: ProjectRulesFile;
  pending: boolean;
  binding: string;
  savedContent: string;
};
