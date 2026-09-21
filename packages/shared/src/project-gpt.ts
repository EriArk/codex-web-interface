export const projectRuleLabels = {
  related: "Проверять влияние изменений на связанные проекты",
  tests: "Запускать подходящие тесты и сборку",
  focused: "Не делать несвязанный рефакторинг",
  dependencies: "Согласовывать новые зависимости",
  issues: "Предлагать технические issues для отдельной работы",
} as const;
export type ProjectRules = { enabled: (keyof typeof projectRuleLabels)[]; custom: string };
export type ProjectGpt = {
  projectId: string;
  name: string;
  nativeId: string | null;
  jobId: string | null;
  revision: number;
  rules: ProjectRules;
  context: string;
};
export const projectContextStart = "[CodexWeb: контекст проекта]\n";
export const projectContextEnd = "\n[/CodexWeb: контекст проекта]\n\n";
