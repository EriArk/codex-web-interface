export const formRequest = {
  mode: "form",
  serverName: "Calendar",
  message: "Choose a schedule",
  requestedSchema: {
    type: "object",
    required: ["title", "enabled", "count", "labels"],
    properties: {
      title: { type: "string", minLength: 2, maxLength: 8 },
      enabled: { type: "boolean", default: false },
      count: { type: "integer", minimum: 0, maximum: 4 },
      ratio: { type: "number", minimum: -1, maximum: 1 },
      day: { type: "string", format: "date" },
      when: { type: "string", format: "date-time" },
      email: { type: "string", format: "email" },
      link: { type: "string", format: "uri" },
      style: {
        type: "string",
        oneOf: [
          { const: "a", title: "Alpha" },
          { const: "b", title: "Beta" },
        ],
      },
      labels: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: "x", title: "One" },
            { const: "y", title: "Two" },
          ],
        },
      },
    },
  },
};
