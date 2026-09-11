export const caseColorIds = [
  "graphite",
  "turquoise",
  "green",
  "blue",
  "red",
  "orange",
  "silver",
] as const;
export type CaseColor = (typeof caseColorIds)[number];
export interface CasePreferences {
  crtCaseColor?: CaseColor;
  hitechCaseColor?: CaseColor;
}
