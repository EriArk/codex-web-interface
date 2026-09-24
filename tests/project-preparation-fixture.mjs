import { createHash, randomUUID } from "node:crypto";
import { issueFixture } from "./issue-drawer-fixture.mjs";
export async function preparationFixture(origin) {
  const f = await issueFixture(origin),
    service = f.preparation,
    sends = [],
    jobs = new Map();
  let head = "a".repeat(40),
    identity = { id: 7, login: "actual-user" },
    sourceText = "Settled exact discussion",
    proposal = {
      title: "Документы и первый этап",
      files: [
        { path: "README.md", text: "# Обновлённый проект\r\n\r\nСогласованный результат." },
        { path: "docs/PLAN.md", text: "# План\n\n- Реализовать критерии" },
      ],
      issues: [{ title: "Первый этап", body: "Согласованный объём и проверяемые критерии." }],
    };
  const docs = {
    "README.md": "# Existing\r\n",
    "AGENTS.md": "Keep this",
    "CODEXWEB.md": "User rules",
  };
  const blob = (t) => createHash("sha1").update(t).digest("hex");
  f.projectGpts.get = () => ({
    projectId: "project",
    name: "Project",
    nativeId: "native-project",
    revision: 1,
    context: "Immutable room snapshot",
    rules: { enabled: [], custom: "" },
  });
  f.projectGpts.send = (_project, id, input) => {
    sends.push({ id, input });
    jobs.set(id, {
      id,
      status: "completed",
      nativeId: "native-project",
      answer: JSON.stringify(proposal),
    });
    return jobs.get(id);
  };
  f.gpt.job = (id) => {
    if (!jobs.has(id)) throw Error("missing job");
    return jobs.get(id);
  };
  f.gpt.historyCache.snapshot = async () => ({
    items: [{ id: "settled", role: "assistant", phase: "final", complete: true, text: sourceText }],
  });
  const original = f.d.resolveSource.bind(f.d);
  f.d.resolveSource = async (source) =>
    source.client === "gpt"
      ? {
          source,
          text:
            source.messageId === "settled"
              ? sourceText
              : (jobs.get(source.messageId)?.answer ?? ""),
        }
      : original(source);
  service.inspect = f.d.inspect;
  const native = f.native;
  service.probe = async (_m, _root, q) => {
    if (q.op === "observe")
      return {
        repository: q.repository,
        repositoryId: 42,
        identity,
        access: "write",
        issues: true,
        preparation: {
          branch: "main",
          head,
          files: q.query.paths.map((path) => ({
            path,
            sha: docs[path] === undefined ? null : blob(docs[path]),
            content: docs[path] ?? null,
            bytes: docs[path]?.length ?? 0,
          })),
        },
      };
    if (
      q.input?.kind.startsWith("preparation-") ||
      f.receipts.get(q.id)?.input.kind.startsWith("preparation-")
    ) {
      f.operations.push(q);
      if (q.op === "prepare") {
        const r = {
          id: q.id,
          state: "prepared",
          fingerprint: createHash("sha256").update(q.id).digest("hex"),
          input: q.input,
          snapshot: {
            repository: q.repository,
            repositoryId: 42,
            identity,
            access: "write",
            issues: true,
          },
        };
        f.receipts.set(q.id, r);
        return structuredClone(r);
      }
      const r = f.receipts.get(q.id);
      if (q.op === "apply") {
        r.state = "completed";
        r.result = {
          sha: r.input.kind === "preparation-branch" ? head : "b".repeat(40),
          branch: r.input.branch,
          number: r.input.kind === "preparation-pr" ? 12 : undefined,
          url:
            r.input.kind === "preparation-pr"
              ? "https://github.com/me/first/pull/12"
              : "https://github.com/me/first/commit/" + "b".repeat(40),
        };
      }
      return structuredClone(r);
    }
    return native(_m, _root, q);
  };
  const input = { messages: ["settled"], brief: "Согласованная идея", model: "model", effort: "3" };
  const request = (method, tail = "", payload) =>
    f.app.inject({
      method,
      url: "/api/projects/project/preparation" + tail,
      headers: f.headers,
      payload,
    });
  const create = async () => {
    const p = await service.create("project", randomUUID(), input);
    return service.get("project", p.id);
  };
  const save = (p) =>
    service.edit("project", p.id, {
      revision: p.revision,
      title: p.title,
      files: p.files.map(({ path, content, choice }) => ({ path, content, choice })),
      issues: p.issues,
    });
  return {
    ...f,
    service,
    sends,
    jobs,
    input,
    request,
    create,
    save,
    docs,
    changeHead: (v) => (head = v),
    changeIdentity: (v) => (identity = v),
    changeProposal: (v) => (proposal = v),
    changeSource: (v) => (sourceText = v),
  };
}
