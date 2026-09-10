import { z } from "zod";
export const GPT_BRIDGE_REVISION = "96802cc0d2ea0b7449cf465f8adb3c228decd297";
export const gptConnectionStateSchema = z.enum([
  "disabled",
  "starting",
  "attention",
  "healthy",
  "login_required",
  "incompatible",
  "busy",
  "degraded",
  "unavailable",
]);
export type GptConnectionState = z.infer<typeof gptConnectionStateSchema>;
const connectorStorage = z.object({
  uploadBytes: z.number().nonnegative(),
  artifactBytes: z.number().nonnegative(),
  uploadLimit: z.number().positive(),
  artifactLimit: z.number().positive(),
  partial: z.boolean(),
});
export const gptConnectorReportSchema = z.object({
  storage: connectorStorage.optional(),
  contract: z.literal(1),
  bridgeRevision: z.literal(GPT_BRIDGE_REVISION),
  bridgeVersion: z.literal("6.3.14"),
  extensionProtocol: z.literal(5),
  state: gptConnectionStateSchema,
  login: z.enum(["authenticated", "required", "unknown"]),
  capabilities: z.object({
    composer: z.boolean(),
    attachments: z.boolean(),
    models: z.boolean(),
    effort: z.boolean(),
    settingsReadback: z.boolean(),
  }),
  privateState: z.object({ permissions: z.boolean(), locked: z.boolean() }),
});
export type GptConnectorReport = z.infer<typeof gptConnectorReportSchema>;
export interface GptConnection {
  configured: boolean;
  state: GptConnectionState;
  message: string;
  canSend: boolean;
  canRead: boolean;
  bridgeRevision?: string;
  bridgeVersion?: string;
  extensionProtocol?: number;
  privateState?: GptConnectorReport["privateState"];
  storage?: z.infer<typeof connectorStorage>;
  activeJobs: number;
  unknownJobs: number;
  connectUrl: "/gpt-connect";
}
export const gptConnectionMessages: Record<GptConnectionState, string> = {
  disabled: "Подключение GPT ещё не настроено.",
  starting: "Подключение GPT запускается.",
  healthy: "GPT на связи.",
  attention: "В ChatGPT открыто окно, требующее внимания.",
  login_required: "Нужно снова войти в ChatGPT.",
  incompatible: "ChatGPT изменился. Подключение требует обновления.",
  busy: "GPT работает.",
  degraded: "Отправка GPT требует проверки.",
  unavailable: "Нет связи с подключением GPT.",
};
export function normalizeGptConnection(raw: unknown, configured = true): GptConnection {
  const parsed = gptConnectorReportSchema.safeParse(raw);
  let state: GptConnectionState = configured
    ? raw === null
      ? "unavailable"
      : parsed.success
        ? parsed.data.state
        : "incompatible"
    : "disabled";
  if (parsed.success) {
    const report = parsed.data;
    if (report.login === "required") state = "login_required";
    else if (
      (state === "healthy" || state === "busy") &&
      !Object.values(report.capabilities).every(Boolean)
    )
      state = "degraded";
    else if ((state === "healthy" || state === "busy") && report.login !== "authenticated")
      state = "starting";
    if (!report.privateState.permissions || !report.privateState.locked) state = "degraded";
  }
  return {
    configured,
    state,
    message: gptConnectionMessages[state],
    canSend: state === "healthy" || state === "busy",
    canRead: parsed.success && parsed.data.login === "authenticated",
    ...(parsed.success
      ? {
          bridgeRevision: parsed.data.bridgeRevision,
          bridgeVersion: parsed.data.bridgeVersion,
          extensionProtocol: parsed.data.extensionProtocol,
          privateState: parsed.data.privateState,
          storage: parsed.data.storage,
        }
      : {}),
    activeJobs: 0,
    unknownJobs: 0,
    connectUrl: "/gpt-connect",
  };
}
