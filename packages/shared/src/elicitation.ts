export type ElicitationValue = string | number | boolean | string[];
export interface ElicitationField {
  key: string;
  title: string;
  description: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  options?: { value: string; title: string; image?: string }[];
  input?: "files" | "images";
  allowFileUri?: boolean;
  fileKind?: "file" | "directory";
  accept?: string[];
  pattern?: string;
  default?: ElicitationValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: "email" | "uri" | "date" | "date-time";
}
export interface Elicitation {
  mode: "form" | "url" | "unsupported";
  serverName: string;
  message: string;
  fields?: ElicitationField[];
  host?: string;
}
