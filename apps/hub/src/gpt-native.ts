import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname, isAbsolute } from "node:path";
import type { GptFile, GptHistoryPage, GptMessage } from "@codex-web/shared";
import { z } from "zod";
import { gptSandboxFiles } from "./gpt-sandbox-files.js";

const uuid = z.string().uuid();
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
      const signal = AbortSignal.timeout(25000);
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
  async catalog(offset = 0) {
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
      .parse(await this.call({ operation: "readCatalog", offset }));
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
    },
  ) {
    nativeDispatchInput
      .extend({
        parentId: uuid,
        model: z.string().max(128),
        effort: z.string().max(128).nullable(),
        intentPersisted: z.literal(true),
      })
      .parse(input);
    const result = z
      .object({ state: z.enum(["unknown", "completed"]), userMessageId: uuid })
      .strict()
      .parse(await this.call({ operation: "dispatchText", ...input }));
    if (result.userMessageId !== input.userMessageId) fail("SUBMISSION_MISMATCH");
    return result;
  }
  async reconcileDispatch(key: string, conversationId: string | null) {
    uuid.parse(key);
    uuid.nullable().parse(conversationId);
    return z
      .object({
        state: z.enum(["unknown", "running", "completed"]),
        userMessageId: uuid,
        messages: historySchema.shape.messages,
        conversationId: uuid.nullable().optional(),
      })
      .strict()
      .parse(await this.call({ operation: "reconcileDispatch", key, conversationId }));
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
    text: z.string().min(1).max(32768),
    versionId: z.string().min(1).max(128),
    presetId: z.number().int().nonnegative(),
  })
  .strict();
export type NativeDispatchInput = z.infer<typeof nativeDispatchInput>;
