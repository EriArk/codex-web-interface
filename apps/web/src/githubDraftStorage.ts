import { accountLocalStorage, pageWorkspace } from "./accountStorage";

// Large reviews contain original bytes, edited bytes and durable operation receipts.
// IndexedDB avoids the small synchronous localStorage quota; never evict pending work.
let ended = false;
const revisions = new Map<string, number>();
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open(`codex-github-drafts:${pageWorkspace || "owner"}`, 2);
  open.onupgradeneeded = () => {
    const store = open.result.objectStoreNames.contains("drafts")
      ? open.transaction!.objectStore("drafts")
      : open.result.createObjectStore("drafts");
    if (!store.indexNames.contains("size")) store.createIndex("size", "size");
  };
  open.onsuccess = () => {
    open.result.onversionchange = () => open.result.close();
    resolve(open.result);
  };
  open.onblocked = () => reject(Error("Закрой другую вкладку редактора и открой файл снова."));
  open.onerror = () => reject(open.error);
});
void database.catch(() => {});
function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, set: (v: T) => void) => void,
): Promise<T> {
  return database.then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        if (ended) {
          reject(Error("Сессия завершена."));
          return;
        }
        const tx = db.transaction("drafts", mode),
          store = tx.objectStore("drafts");
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error || Error("Не удалось сохранить черновик."));
        tx.onerror = () => {};
        try {
          action(store, (v) => {
            value = v;
          });
        } catch (e) {
          tx.abort();
          reject(e);
        }
      }),
  );
}
export const githubDraftStorage = {
  async getItem(key: string) {
    if (ended) throw Error("Сессия завершена.");
    const journal = accountLocalStorage.getItem(key);
    if (journal !== null) return journal;
    const value = await transaction<string | null>("readonly", (store, set) => {
      const r = store.get(key);
      r.onsuccess = () => set(r.result?.value ?? null);
    });
    return value ?? accountLocalStorage.getItem(key);
  },
  async setItem(key: string, value: string) {
    if (ended) throw Error("Сессия завершена.");
    const revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    const size = new TextEncoder().encode(value).length;
    if (size <= 65536) {
      try {
        accountLocalStorage.setItem(key, value);
      } catch {
        /* Durable IndexedDB remains authoritative. */
      }
    }
    await transaction<void>("readwrite", (store) => {
      let count = 0,
        total = 0;
      const r = store.index("size").openKeyCursor();
      r.onsuccess = () => {
        const cursor = r.result;
        if (cursor) {
          if (cursor.primaryKey !== key) {
            count++;
            total += Number(cursor.key);
          }
          cursor.continue();
          return;
        }
        if (count >= 32 || total + size > 64 * 1024 * 1024) {
          store.transaction.abort();
          return;
        }
        store.put({ key, value, size }, key);
      };
    });
    if (
      revisions.get(key) === revision &&
      (accountLocalStorage.getItem(key) === value || size > 65536)
    )
      accountLocalStorage.removeItem(key);
  },
  async removeItem(key: string) {
    await transaction<void>("readwrite", (store) => {
      store.delete(key);
    });
    accountLocalStorage.removeItem(key);
  },
};
window.addEventListener("private-session-ended", () => {
  ended = true;
  try {
    const keys = Array.from({ length: accountLocalStorage.length }, (_, i) =>
      accountLocalStorage.key(i),
    );
    for (const key of keys)
      if (
        key &&
        (key.startsWith("workspace-github-file-review:") ||
          key.startsWith("workspace-file-copy:github:"))
      )
        accountLocalStorage.removeItem(key);
  } catch {
    /* Session revocation still blocks reads and late writes. */
  }
  void database
    .then((db) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").clear();
    })
    .catch(() => {});
});
