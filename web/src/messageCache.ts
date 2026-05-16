import type { GmailMessageMetadata } from "./types";

const DB_NAME = "subbot-gmail-cache";
const DB_VERSION = 1;
const MESSAGE_STORE = "gmailMessages";

type CachedMessageRecord = {
  cacheKey: string;
  accountHash: string;
  messageId: string;
  cachedAt: string;
  message: GmailMessageMetadata;
};

export async function getCachedMessages(
  accountHash: string,
  messageIds: string[]
): Promise<Map<string, GmailMessageMetadata>> {
  const db = await openDB();
  try {
    const tx = db.transaction(MESSAGE_STORE, "readonly");
    const done = transactionDone(tx);
    const store = tx.objectStore(MESSAGE_STORE);
    const entries = await Promise.all(
      messageIds.map(async (messageId) => {
        const record = await requestToPromise<CachedMessageRecord | undefined>(
          store.get(cacheKey(accountHash, messageId))
        );
        return [messageId, record?.message] as const;
      })
    );

    await done;
    return new Map(
      entries
        .filter((entry): entry is readonly [string, GmailMessageMetadata] => Boolean(entry[1]))
        .map(([messageId, message]) => [messageId, message])
    );
  } finally {
    db.close();
  }
}

export async function putCachedMessages(accountHash: string, messages: GmailMessageMetadata[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const db = await openDB();
  try {
    const tx = db.transaction(MESSAGE_STORE, "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(MESSAGE_STORE);
    const cachedAt = new Date().toISOString();

    for (const message of messages) {
      store.put({
        cacheKey: cacheKey(accountHash, message.id),
        accountHash,
        messageId: message.id,
        cachedAt,
        message
      } satisfies CachedMessageRecord);
    }

    await done;
  } finally {
    db.close();
  }
}

function cacheKey(accountHash: string, messageId: string): string {
  return `${accountHash}:${messageId}`;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        const store = db.createObjectStore(MESSAGE_STORE, { keyPath: "cacheKey" });
        store.createIndex("accountHash", "accountHash", { unique: false });
        store.createIndex("cachedAt", "cachedAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another open Subbot tab"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
