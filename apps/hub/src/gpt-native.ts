import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname, isAbsolute } from "node:path";
import type { GptFile, GptHistoryPage, GptMessage } from "@codex-web/shared";
import { z } from "zod";
import { gptSandboxFiles } from "./gpt-sandbox-files.js";

const uuid = z.string().uuid();
const projectId = z.string().regex(/^g-p-[a-zA-Z0-9-]{1,80}$/);
const projectConversation = z
  .object({
    id: uuid,
    title: z.string().max(4096),
    updatedAt: z.number().finite().nonnegative(),
    projectId,
  })
  .strict();
const projectSchema = z
  .object({
    id: projectId,
    name: z.string().max(500),
    instructions: z.string().max(100000),
    canWrite: z.boolean(),
    emoji: z.string().max(128).nullable(),
    theme: z.string().max(128).nullable(),
    files: z
      .array(
        z
          .object({
            id: z.string().regex(/^file[-_][a-zA-Z0-9_-]{1,150}$/),
            name: z.string().max(500),
            bytes: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(500),
    conversations: z.array(projectConversation).max(20),
  })
  .strict();
const projectCursor = z.string().max(4000).nullable();
const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifactId = z.string().regex(/^sandbox-[a-f0-9]{64}$/);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => {
  throw Error(`NATIVE_${code}`);
};
const historySchema = z
  .object({
    conversationId: uuid,
    projectId: projectId.optional(),
    currentNode: identity,
    before: identity.nullable(),
    mediaResolved: z.literal(false),
    messages: z
      .array(
        z
          .object({
            nodeId: identity,
            id: identity,
            role: z.enum(["user", "assistant"]),
            channel: z.enum(["commentary", "final"]),
            text: z.string().max(1024 * 1024),
            hasAttachments: z.boolean(),
            createdAt: z.number().finite().nonnegative(),
            model: z.string().max(128).nullable(),
            effort: z.string().max(128).nullable(),
            complete: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/** Private typed native transport. Dispatch requires the host's disposable-chat
 * canary allowlist; this client never selects the main GptService provider. */
export class NativeGptReadClient {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  constructor(
    private readonly binding: { socketPath: string; userId: string },
    private readonly authorize: () => void,
    private readonly urlPrefix: "/api/gpt/native" | "/gpt-connect/native" = "/api/gpt/native",
  ) {
    uuid.parse(binding.userId);
    if (!isAbsolute(binding.socketPath)) fail("INVALID_SOCKET");
  }
  private async call(input: Record<string, unknown>): Promise<unknown> {
    this.authorize();
    if (this.waiting >= 64) fail("BUSY");
    this.waiting++;
    const task = this.tail.then(() => this.request(input));
    this.tail = task.catch(() => {});
    try {
      return await task;
    } finally {
      this.waiting--;
    }
  }
  private async request(input: Record<string, unknown>): Promise<unknown> {
    this.authorize();
    // A configured same-UID private Unix socket, never a browser-supplied address.
    for (const [path, directory] of [
      [dirname(this.binding.socketPath), true],
      [this.binding.socketPath, false],
    ] as const) {
      const stat = await lstat(path);
      if (
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        (directory ? !stat.isDirectory() : !stat.isSocket())
      )
        fail("UNSAFE_SOCKET");
    }
    this.authorize();
    const result = await new Promise<unknown>((resolve, reject) => {
      const signal = AbortSignal.timeout(
        ["uploadStoredFile", "projectMutation"].includes(String(input.operation))
          ? 16 * 60000
          : input.operation === "uploadFile"
            ? 100000
            : 25000,
      );
      const req = request(
        {
          socketPath: this.binding.socketPath,
          method: "POST",
          path: "/v1",
          signal,
          agent: false,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let count = 0;
          res.on("data", (chunk: Buffer) => {
            count += chunk.length;
            if (count > 2 * 1024 * 1024) {
              req.destroy();
              reject(Error("NATIVE_RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => reject(Error("NATIVE_DISCONNECTED")));
          res.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode !== 200 || value.ok !== true)
                throw Error(
                  /^NATIVE_[A-Z_]+$/.test(value.code ?? "") ? value.code : "NATIVE_UNAVAILABLE",
                );
              resolve(value.result);
            } catch (error) {
              reject(
                Error(
                  error instanceof Error && /^NATIVE_[A-Z_]+$/.test(error.message)
                    ? error.message
                    : "NATIVE_INVALID_RESPONSE",
                ),
              );
            }
          });
        },
      );
      req.on("error", () =>
        reject(Error(signal.aborted ? "NATIVE_TIMEOUT" : "NATIVE_UNAVAILABLE")),
      );
      req.end(JSON.stringify({ ...input, userId: this.binding.userId }));
    });
    this.authorize();
    return result;
  }
  async createProject(key: string, name: string) {
    uuid.parse(key);
    z.string().trim().min(1).max(120).parse(name);
    return z
      .object({ projectId: projectId.nullable(), rejected: z.boolean().optional() })
      .strict()
      .parse(await this.call({ operation: "createProject", key, name }));
  }
  async projectContent(id: string) {
    projectId.parse(id);
    return projectSchema
      .omit({ conversations: true })
      .extend({ revision: digest })
      .strict()
      .parse(await this.call({ operation: "inspectProject", projectId: id }));
  }
  async projectMutation(input: NativeProjectMutation, path?: string) {
    uuid.parse(input.key);
    projectId.parse(input.projectId);
    digest.parse(input.revision);
    if (input.action === "upload") {
      if (!path || !isAbsolute(path)) fail("INVALID_UPLOAD");
      uuid.parse(input.file.id);
      digest.parse(input.file.sha256);
      let offset = 0;
      for await (const chunk of createReadStream(path!, { highWaterMark: 1024 * 1024 })) {
        this.authorize();
        const bytes = chunk as Buffer;
        const result = z
          .object({ offset: z.number().int().nonnegative() })
          .strict()
          .parse(
            await this.call({
              operation: "stageProjectUpload",
              key: input.key,
              projectId: input.projectId,
              file: input.file,
              offset,
              base64: bytes.toString("base64"),
            }),
          );
        offset += bytes.length;
        if (result.offset < offset || result.offset > input.file.bytes) fail("UPLOAD_CHANGED");
      }
      if (offset !== input.file.bytes) fail("UPLOAD_CHANGED");
    }
    return z
      .object({ state: z.enum(["completed", "unknown", "rejected"]) })
      .strict()
      .parse(await this.call({ operation: "projectMutation", ...input }));
  }
  async reconcileProject(key: string, id: string) {
    uuid.parse(key);
    projectId.parse(id);
    return z
      .object({ state: z.enum(["completed", "unknown", "rejected"]) })
      .strict()
      .parse(await this.call({ operation: "reconcileProject", key, projectId: id }));
  }
  async libraryMutation(
    input: { key: string; kind: "thread" | "project"; id: string } & (
      | { action: "rename"; name: string }
      | { action: "pin" | "archive"; value: boolean }
      | { action: "delete"; confirm: true }
    ),
    checkOnly = false,
  ) {
    uuid.parse(input.key);
    (input.kind === "thread" ? uuid : projectId).parse(input.id);
    return z
      .object({
        state: z.enum(["completed", "unknown", "rejected"]),
        name: z.string().max(4096),
        projectId: projectId.nullable(),
      })
      .strict()
      .parse(
        await this.call({
          operation: checkOnly ? "reconcileLibrary" : "libraryMutation",
          ...input,
        }),
      );
  }
  async status() {
    return z
      .object({
        instanceId: uuid,
        manual: z.boolean(),
        busy: z.boolean(),
        writesEnabled: z.literal(false),
      })
      .strict()
      .parse(await this.call({ operation: "status" }));
  }
  async catalog(offset = 0, archived = false) {
    z.number().int().min(0).max(10000).parse(offset);
    return z
      .object({
        items: z
          .array(
            z
              .object({
                id: uuid,
                title: z.string().max(4096),
                createdAt: z.number().finite().nonnegative(),
                updatedAt: z.number().finite().nonnegative(),
                projectId: z.string().max(128).nullable(),
                origin: z.string().max(128).nullable(),
              })
              .strict(),
          )
          .max(20),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .parse(await this.call({ operation: "readCatalog", offset, archived }));
  }
  async models() {
    const preset = z
      .object({
        id: z.number().int().nonnegative(),
        label: z.string().min(1).max(120),
        model: z.string().max(128),
        effort: z.string().max(128).nullable(),
        available: z.boolean(),
      })
      .strict();
    return z
      .object({
        versions: z
          .array(
            z
              .object({
                id: z.string().min(1).max(120),
                label: z.string().min(1).max(120),
                enabled: z.boolean(),
                presets: preset.array().max(16),
              })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict()
      .parse(await this.call({ operation: "readModels" }));
  }
  async pins() {
    return z
      .object({
        items: z
          .array(
            z
              .object({
                id: identity,
                kind: z.enum(["thread", "project"]),
                title: z.string().max(4096),
                updatedAt: z.number().finite().nonnegative(),
                projectId: projectId.nullable(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .parse(await this.call({ operation: "readPins" }));
  }
  async projects(cursor: string | null = null) {
    projectCursor.parse(cursor);
    return z
      .object({ items: projectSchema.array().max(20), cursor: projectCursor })
      .strict()
      .parse(await this.call({ operation: "readProjects", cursor }));
  }
  async project(id: string) {
    projectId.parse(id);
    const result = projectSchema.parse(
      await this.call({ operation: "readProject", projectId: id }),
    );
    if (result.id !== id) fail("PROJECT_MISMATCH");
    return result;
  }
  async projectConversations(id: string, cursor: string | null = null) {
    projectId.parse(id);
    projectCursor.parse(cursor);
    const result = z
      .object({ items: projectConversation.array().max(20), cursor: projectCursor })
      .strict()
      .parse(await this.call({ operation: "readProjectConversations", projectId: id, cursor }));
    if (result.items.some((c) => c.projectId !== id)) fail("PROJECT_MISMATCH");
    return result;
  }
  async conversationGraph(conversationId: string) {
    uuid.parse(conversationId);
    const result = z
      .object({
        conversation_id: uuid,
        current_node: identity,
        title: z.string().max(4096),
        gizmo_id: projectId.nullable(),
        mapping: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(await this.call({ operation: "readConversationGraph", conversationId }));
    if (
      result.conversation_id !== conversationId ||
      !Object.hasOwn(result.mapping, result.current_node) ||
      Object.keys(result.mapping).length > 10000
    )
      fail("INVALID_HISTORY");
    return result;
  }
  async manual(operation: "beginManual" | "endManual" | "resumeManual", leaseId?: string) {
    if (!["beginManual", "endManual", "resumeManual"].includes(operation)) fail("INVALID_REQUEST");
    if (operation !== "resumeManual") uuid.parse(leaseId);
    return z
      .object({ manual: z.boolean(), writesEnabled: z.literal(false) })
      .strict()
      .parse(await this.call({ operation, ...(leaseId ? { leaseId } : {}) }));
  }
  async prepareDispatch(input: NativeDispatchInput) {
    nativeDispatchInput.parse(input);
    return z
      .object({
        parentId: uuid,
        model: z.string().max(128),
        effort: z.string().max(128).nullable(),
        versionId: z.string().max(128),
        presetId: z.number().int(),
      })
      .strict()
      .parse(await this.call({ operation: "prepareDispatch", ...input }));
  }
  async dispatchText(
    input: NativeDispatchInput & {
      parentId: string;
      model: string;
      effort: string | null;
      intentPersisted: true;
      attachments?: NativeUploadedFile[];
    },
  ) {
    nativeDispatchInput
      .extend({
        parentId: uuid,
        model: z.string().max(128),
        effort: z.string().max(128).nullable(),
        intentPersisted: z.literal(true),
        attachments: nativeUploadedFile.array().max(8).optional(),
      })
      .parse(input);
    const result = z
      .object({ state: z.enum(["unknown", "completed"]), userMessageId: uuid })
      .strict()
      .parse(await this.call({ operation: "dispatchText", ...input }));
    if (result.userMessageId !== input.userMessageId) fail("SUBMISSION_MISMATCH");
    return result;
  }
  async uploadFile(input: {
    key: string;
    conversationId: string | null;
    file: {
      id: string;
      name: string;
      mime: string;
      bytes: number;
      sha256: string;
      base64: string;
    };
  }) {
    uuid.parse(input.key);
    uuid.nullable().parse(input.conversationId);
    const file = z
      .object({
        id: uuid,
        name: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (value) =>
              !value.includes("/") &&
              !value.includes("\\") &&
              [...value].every((c) => c.charCodeAt(0) >= 32),
          ),
        mime: z.string().regex(/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i),
        bytes: z
          .number()
          .int()
          .min(1)
          .max(20 * 1024 * 1024),
        sha256: digest,
        base64: z.string().max(27962028),
      })
      .strict()
      .parse(input.file);
    const bytes = Buffer.from(file.base64, "base64");
    if (
      bytes.length !== file.bytes ||
      bytes.toString("base64") !== file.base64 ||
      hash(bytes) !== file.sha256
    )
      fail("UPLOAD_CHANGED");
    const result = nativeUploadedFile.parse(
      await this.call({ operation: "uploadFile", ...input, file }),
    );
    if (
      result.id !== file.id ||
      result.sha256 !== file.sha256 ||
      result.native.name !== file.name ||
      result.native.size !== file.bytes ||
      result.native.mimeType !== file.mime
    )
      fail("UPLOAD_MISMATCH");
    return result;
  }
  async uploadFilePath(
    input: {
      key: string;
      conversationId: string | null;
      file: { id: string; name: string; mime: string; bytes: number; sha256: string };
    },
    path: string,
  ) {
    uuid.parse(input.key);
    uuid.nullable().parse(input.conversationId);
    uuid.parse(input.file.id);
    digest.parse(input.file.sha256);
    if (!isAbsolute(path) || input.file.mime.startsWith("image/")) fail("INVALID_UPLOAD");
    let offset = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      this.authorize();
      const bytes = chunk as Buffer;
      const value = z
        .object({ offset: z.number().int().nonnegative() })
        .strict()
        .parse(
          await this.call({
            operation: "stageUpload",
            ...input,
            offset,
            base64: bytes.toString("base64"),
          }),
        );
      offset += bytes.length;
      if (value.offset < offset || value.offset > input.file.bytes) fail("UPLOAD_CHANGED");
    }
    if (offset !== input.file.bytes) fail("UPLOAD_CHANGED");
    const result = nativeUploadedFile.parse(
      await this.call({ operation: "uploadStoredFile", ...input }),
    );
    if (
      result.id !== input.file.id ||
      result.sha256 !== input.file.sha256 ||
      result.native.name !== input.file.name ||
      result.native.mimeType !== input.file.mime ||
      result.native.size !== input.file.bytes
    )
      fail("UPLOAD_MISMATCH");
    return result;
  }
  async reconcileDispatch(key: string, conversationId: string | null) {
    uuid.parse(key);
    uuid.nullable().parse(conversationId);
    return z
      .object({
        state: z.enum(["unknown", "running", "completed", "cancelled"]),
        userMessageId: uuid,
        messages: historySchema.shape.messages,
        conversationId: uuid.nullable().optional(),
      })
      .strict()
      .parse(await this.call({ operation: "reconcileDispatch", key, conversationId }));
  }
  async stopDispatch(key: string, conversationId: string | null) {
    uuid.parse(key);
    uuid.nullable().parse(conversationId);
    return z
      .object({ stopIssued: z.boolean() })
      .strict()
      .parse(await this.call({ operation: "stopDispatch", key, conversationId }));
  }
  async history(conversationId: string, before?: string): Promise<GptHistoryPage> {
    uuid.parse(conversationId);
    if (before != null) uuid.parse(before);
    const native = historySchema.parse(
      await this.call({
        operation: "readConversation",
        conversationId,
        ...(before ? { before } : {}),
      }),
    );
    if (
      native.conversationId !== conversationId ||
      new Set(native.messages.map((m) => m.id)).size !== native.messages.length ||
      native.messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0) > 1024 * 1024
    )
      fail("INVALID_HISTORY");
    const items: GptMessage[] = native.messages.map((m) => {
      const links =
        m.role === "assistant"
          ? gptSandboxFiles(m.text, conversationId, m.id)
          : { text: m.text, files: [] };
      // Canary URLs remain in the separately authenticated read namespace.
      const rewrite = (value: string) =>
        value.replaceAll(
          `/api/gpt/downloads/${conversationId}/`,
          `${this.urlPrefix}/downloads/${conversationId}/`,
        );
      return {
        id: m.id,
        role: m.role,
        text: rewrite(links.text),
        createdAt: m.createdAt,
        phase: m.channel,
        complete: m.complete,
        files: links.files.map((f) => ({ ...f, url: rewrite(f.url) })),
        ...(m.hasAttachments ? { unsupported: ["other" as const] } : {}),
      };
    });
    const revision = hash(JSON.stringify([native.currentNode, items]));
    return {
      items,
      nextBefore: native.before,
      revision,
      prefix: hash(JSON.stringify(items.map((m) => m.id))),
      notModified: false,
      retainOlder: false,
    };
  }
  async download(
    conversationId: string,
    messageId: string,
    id: string,
  ): Promise<{ file: GptFile; bytes: Buffer }> {
    uuid.parse(conversationId);
    identity.parse(messageId);
    artifactId.parse(id);
    const value = z
      .object({
        artifact: z
          .object({
            id: artifactId,
            conversationId: uuid,
            messageId: identity,
            path: z.string().max(2048),
            name: z.string().max(2048),
            mime: z.string().max(128),
            image: z.boolean(),
          })
          .strict(),
        bytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024),
        sha256: digest,
        base64: z
          .string()
          .max(1398104)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      })
      .strict()
      .parse(
        await this.call({ operation: "readArtifact", conversationId, messageId, artifactId: id }),
      );
    const a = value.artifact;
    const expected = gptSandboxFiles(
      `[file](<sandbox:${a.path}>)`,
      conversationId,
      messageId,
    ).files;
    const file = expected[0];
    if (
      !file ||
      a.conversationId !== conversationId ||
      a.messageId !== messageId ||
      a.id !== id ||
      expected.length !== 1 ||
      file.id !== id ||
      file.name !== a.name ||
      file.image !== a.image
    )
      return fail("ARTIFACT_MISMATCH");
    const bytes = Buffer.from(value.base64, "base64");
    if (bytes.length !== value.bytes || hash(bytes) !== value.sha256) fail("ARTIFACT_CHECKSUM");
    return {
      file: {
        ...file,
        bytes: bytes.length,
        url: `${this.urlPrefix}/downloads/${conversationId}/${messageId}/${id}`,
      },
      bytes,
    };
  }
}

const nativeDispatchInput = z
  .object({
    key: uuid,
    conversationId: uuid.nullable(),
    userMessageId: uuid,
    projectId: projectId.optional(),
    text: z
      .string()
      .max(32768)
      .refine((value) => Buffer.byteLength(value) <= 32768),
    versionId: z.string().min(1).max(128),
    presetId: z.number().int().nonnegative(),
  })
  .strict();
export type NativeDispatchInput = z.infer<typeof nativeDispatchInput>;
const nativeUploadedFile = z
  .object({
    id: uuid,
    sha256: digest,
    native: z
      .object({
        id: z.string().regex(/^file[-_][a-zA-Z0-9_-]{1,150}$/),
        name: z.string().min(1).max(255),
        mimeType: z.string().regex(/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i),
        size: z
          .number()
          .int()
          .min(1)
          .max(512 * 1024 * 1024),
        source: z.literal("local"),
        width: z.number().int().min(1).max(8192).optional(),
        height: z.number().int().min(1).max(8192).optional(),
      })
      .strict(),
  })
  .strict();
export type NativeUploadedFile = z.infer<typeof nativeUploadedFile>;

export type NativeProjectMutation = { key: string; projectId: string; revision: string } & (
  | { action: "instructions"; text: string }
  | { action: "remove"; fileId: string; confirm: true }
  | {
      action: "upload";
      file: { id: string; name: string; mime: string; bytes: number; sha256: string };
    }
);
