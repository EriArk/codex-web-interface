export function capabilityReply(method) {
  if (method === "model/list")
    return {
      data: [
        {
          id: "qa-model",
          model: "qa-model",
          displayName: "QA Model",
          description: "Simulated capabilities for isolated tests",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
          ],
          defaultReasoningEffort: "high",
          inputModalities: ["text", "image"],
        },
        {
          id: "qa-text",
          model: "qa-text",
          displayName: "QA Text",
          description: "Text-only fixture",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          defaultReasoningEffort: "low",
          inputModalities: ["text"],
        },
      ],
      nextCursor: null,
    };
  if (method === "collaborationMode/list") return { data: [{ mode: "default" }, { mode: "plan" }] };
  if (method === "config/read")
    return { config: { model: "qa-model", model_reasoning_effort: "xhigh" } };
}
