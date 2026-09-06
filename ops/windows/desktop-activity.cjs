// Fixed metadata-only read used immediately before desktop maintenance.
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");
function readActivity(home, now = Date.now() / 1000) {
  let state, history;
  try {
    state = new DatabaseSync(join(home, "state_5.sqlite"), { readOnly: true });
    history = new DatabaseSync(join(home, "thread_history_1.sqlite"), { readOnly: true });
    for (const db of [state, history]) db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const last = history.prepare("SELECT status,started_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1");
    let active = 0;
    const threads = state.prepare("SELECT id,updated_at FROM threads WHERE archived=0").all();
    if (threads.length > 10000) throw Error("Unsupported catalog size");
    for (const thread of threads) {
      const turn = last.get(thread.id);
      if (turn?.status === "inProgress" && now - Math.max(thread.updated_at || 0, turn.started_at || 0) < 600) active++;
    }
    return { known: true, active };
  } catch { return { known: false, active: 0 }; }
  finally { history?.close(); state?.close(); }
}
module.exports = { readActivity };
if (require.main === module) process.stdout.write(JSON.stringify(readActivity(process.argv[2])));
