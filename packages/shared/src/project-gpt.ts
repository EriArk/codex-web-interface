export const projectRuleLabels = {
  related: "Проверять влияние изменений на связанные проекты",
  tests: "Запускать подходящие тесты и сборку",
  focused: "Не делать несвязанный рефакторинг",
  dependencies: "Согласовывать новые зависимости",
  issues: "Предлагать технические issues для отдельной работы",
} as const;
export type ProjectRules = {
  enabled: (keyof typeof projectRuleLabels)[];
  custom: string;
  agentProfile?: import("./agent-profile.js").AgentProfile | null;
};
export type ProjectGpt = {
  projectId: string;
  name: string;
  nativeId: string | null;
  jobId: string | null;
  revision: number;
  rules: ProjectRules;
  context: string;
};
export type ActivityGptHandoff = {
  id: string;
  spaceId: string;
  sharedProjectId: string;
  projectId: string;
  name: string;
  title: string;
  sources: number;
  sourceKeys: string[];
  truncated: boolean;
};
export const projectContextStart = "[CodexWeb: контекст проекта]\n";
export const projectContextEnd = "\n[/CodexWeb: контекст проекта]\n\n";
