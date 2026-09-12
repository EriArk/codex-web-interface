export const caseColorIds = [
  "graphite",
  "white",
  "silver",
  "red",
  "orange",
  "yellow",
  "green",
  "mint",
  "turquoise",
  "blue",
  "purple",
  "pink",
] as const;
export type CaseColor = (typeof caseColorIds)[number];
export interface CasePreferences {
  crtCaseColor?: CaseColor;
  hitechCaseColor?: CaseColor;
  organizerAccentColor?: CaseColor;
  darkAccentColor?: CaseColor;
}
