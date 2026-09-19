import { randomUUID } from "node:crypto";

export function nativeWorkspaceFixture() {
  const conversationId = randomUUID(),
    parentId = randomUUID();
  const state = {
    sends: 0,
    uploads: 0,
    finished: false,
    stopped: false,
    loseAck: false,
    manual: false,
    input: null,
    preparing: null,
  };
  const message = (id, role, text, channel = "final", complete = true) => ({
    id,
    nodeId: id,
    role,
    channel,
    text,
    hasAttachments: false,
    createdAt: 100,
    model: "native-model",
    effort: "standard",
    complete,
  });
  const output = () =>
    state.input
      ? [
          message("commentary", "assistant", "Проверяю вложение", "commentary", state.finished),
          ...(state.finished ? [message("final", "assistant", "nativeworkspaceok")] : []),
        ]
      : [];
  const messages = () => [
    message(parentId, "assistant", "Первый ответ"),
    ...(state.input
      ? [message(state.input.userMessageId, "user", state.input.text), ...output()]
      : []),
  ];
  const client = {
    status: async () => ({
      instanceId: randomUUID(),
      manual: state.manual,
      busy: false,
      writesEnabled: false,
    }),
    models: async () => ({
      versions: [
        {
          id: "latest",
          label: "Latest",
          enabled: true,
          presets: [
            {
              id: 1,
              label: "Standard",
              model: "native-model",
              effort: "standard",
              available: true,
            },
            {
              id: 2,
              label: "Extended",
              model: "native-model",
              effort: "extended",
              available: true,
            },
          ],
        },
        {
          id: "fast",
          label: "Fast",
          enabled: true,
          presets: [{ id: 0, label: "Instant", model: "instant", effort: null, available: true }],
        },
      ],
    }),
    catalog: async (offset, archived) => ({
      items:
        archived || offset
          ? []
          : [
              {
                id: conversationId,
                title: "Native workspace fixture",
                updatedAt: 100000,
                createdAt: 100000,
                projectId: null,
                origin: null,
              },
            ],
      nextOffset: null,
    }),
    pins: async () => ({
      items: [
        {
          id: conversationId,
          kind: "thread",
          title: "Native workspace fixture",
          updatedAt: 100000,
          projectId: null,
        },
      ],
    }),
    projects: async () => ({
      items: [
        {
          id: "g-p-example",
          name: "Native project",
          conversations: [],
          files: [],
          instructions: "Rules",
          canWrite: true,
          emoji: null,
          theme: null,
        },
      ],
      cursor: null,
    }),
    project: async () => (await client.projects()).items[0],
    conversationGraph: async (id) => {
      if (id !== conversationId) throw Error("NATIVE_CONVERSATION_MISMATCH");
      const items = messages();
      return {
        conversation_id: id,
        title: "Native workspace fixture",
        gizmo_id: null,
        current_node: items.at(-1).id,
        mapping: Object.fromEntries(
          items.map((m, i) => [
            m.id,
            {
              id: m.id,
              parent: items[i - 1]?.id ?? null,
              children: items[i + 1] ? [items[i + 1].id] : [],
              message: {
                id: m.id,
                author: { role: m.role },
                channel: m.channel,
                content: { content_type: "text", parts: [m.text] },
                create_time: m.createdAt,
                status: m.complete ? "finished_successfully" : "in_progress",
                end_turn: m.complete,
                metadata: { is_complete: m.complete },
              },
            },
          ]),
        ),
      };
    },
    prepareDispatch: async (input) => {
      if (state.preparing) await state.preparing;
      return {
        parentId,
        model: "native-model",
        effort: "standard",
        versionId: input.versionId,
        presetId: input.presetId,
      };
    },
    dispatchText: async (input) => {
      state.sends++;
      state.input = input;
      if (state.loseAck) throw Error("NATIVE_TIMEOUT");
      return { state: "unknown", userMessageId: input.userMessageId };
    },
    reconcileDispatch: async () => ({
      state: state.stopped ? "cancelled" : state.finished ? "completed" : "running",
      userMessageId: state.input.userMessageId,
      messages: output(),
    }),
    stopDispatch: async () => {
      state.stopped = true;
      return { stopIssued: true };
    },
    uploadFile: async ({ file }) => {
      state.uploads++;
      return {
        id: file.id,
        sha256: file.sha256,
        native: {
          id: "file-fixture",
          name: file.name,
          mimeType: file.mime,
          size: file.bytes,
          source: "local",
        },
      };
    },
    uploadFilePath: async (input) => client.uploadFile(input),
    download: async () => {
      throw Error("NATIVE_ARTIFACT_MISSING");
    },
  };
  return {
    client,
    state,
    conversationId,
    workspace: { client, conversations: new Set([conversationId]), creationKeys: new Set() },
    input: {
      nativeId: conversationId,
      text: "Disposable native workspace test",
      files: [],
      model: "latest",
      effort: "1",
    },
  };
}
