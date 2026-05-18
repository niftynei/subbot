import type { GmailMessageMetadata } from "./types";
import { getCachedMessages, putCachedMessages } from "./messageCache";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_FETCH_TIMEOUT_MS = 30_000;
const PROGRESS_REPORT_INTERVAL = 5;
const METADATA_MESSAGE_HEADERS = [
  "From",
  "Sender",
  "Date",
  "Subject",
  "List-ID",
  "Mailing-List",
  "List-Unsubscribe",
  "List-Unsubscribe-Post"
];
const SCAN_PROFILES = {
  fast: {
    format: "metadata",
    concurrency: 12,
    initialIntervalMs: 50,
    minIntervalMs: 20,
    maxIntervalMs: 2_000
  },
  complete: {
    format: "full",
    concurrency: 8,
    initialIntervalMs: 75,
    minIntervalMs: 40,
    maxIntervalMs: 3_000
  }
} as const;

export type GmailScanMode = keyof typeof SCAN_PROFILES;

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
};

export type GmailScanProgress = {
  listed: number;
  fetched: number;
  cached: number;
  matched: number;
  cappedAt: number;
  batchInspected: number;
  batchTotal: number;
  notice?: string;
};

export type GmailAccessToken = {
  clientId: string;
  token: string;
  expiresAt: number;
  scope: string;
};

export class GmailAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GmailAuthError";
    this.code = code;
  }
}

class GmailAPIError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GmailAPIError";
    this.status = status;
    this.code = code;
  }
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }) => GoogleTokenClient;
        };
      };
    };
  }
}

export async function requestGmailAccessToken(
  clientId: string,
  options: { forceConsent?: boolean } = {}
): Promise<GmailAccessToken> {
  await loadGoogleIdentityServices();

  return new Promise((resolve, reject) => {
    if (!window.google) {
      reject(new Error("Google Identity Services did not load"));
      return;
    }

    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(
            new GmailAuthError(
              response.error,
              response.error_description || authErrorMessage(response.error)
            )
          );
          return;
        }
        if (!response.access_token) {
          reject(new Error("Google did not return an access token"));
          return;
        }
        const expiresInSeconds = Math.max(60, response.expires_in ?? 3600);
        resolve({
          clientId,
          token: response.access_token,
          expiresAt: Date.now() + (expiresInSeconds - 60) * 1000,
          scope: response.scope ?? ""
        });
      }
    });

    client.requestAccessToken({ prompt: options.forceConsent ? "consent" : "" });
  });
}

export function tokenIsUsable(token: GmailAccessToken | null, clientId: string): token is GmailAccessToken {
  return Boolean(
    token &&
      token.clientId === clientId &&
      token.expiresAt > Date.now() + 30_000 &&
      token.scope.split(/\s+/).includes(GMAIL_SCOPE)
  );
}

export function needsInteractiveAuth(error: unknown): boolean {
  if (!(error instanceof GmailAuthError)) {
    return false;
  }
  return ["account_selection_required", "consent_required", "interaction_required", "login_required"].includes(
    error.code
  );
}

export function isReadonlyScopeRequiredError(error: unknown): boolean {
  return (
    error instanceof GmailAPIError &&
    error.status === 403 &&
    /metadata scope.+format full/i.test(error.message)
  );
}

export async function scanGmailMetadata(input: {
  accessToken: string;
  maxMessages: number;
  months: number;
  mode?: GmailScanMode;
  onProgress: (progress: GmailScanProgress) => void;
  onProfile?: (profile: GmailProfile) => void;
}): Promise<{ profile: GmailProfile; messages: GmailMessageMetadata[] }> {
  const messages: GmailMessageMetadata[] = [];
  const cutoff = Date.now() - input.months * 30.44 * 86_400_000;
  const scanMode = input.mode ?? "fast";
  const scanProfile = SCAN_PROFILES[scanMode];
  const messageGetPacer = new AdaptiveRequestPacer({
    initialIntervalMs: scanProfile.initialIntervalMs,
    minIntervalMs: scanProfile.minIntervalMs,
    maxIntervalMs: scanProfile.maxIntervalMs
  });
  let pageToken = "";
  let listed = 0;
  let fetchedCount = 0;
  let cachedCount = 0;
  let batchInspected = 0;
  let batchTotal = 0;

  const report = (notice = "") => {
    input.onProgress({
      listed,
      fetched: fetchedCount,
      cached: cachedCount,
      matched: messages.length,
      cappedAt: input.maxMessages,
      batchInspected,
      batchTotal,
      notice
    });
  };

  const inspectMessage = (message: GmailMessageMetadata, source: "cache" | "gmail", forceReport = false) => {
    fetchedCount += 1;
    batchInspected += 1;
    if (source === "cache") {
      cachedCount += 1;
    }
    const inWindow = messageTime(message) >= cutoff;
    if (inWindow) {
      messages.push(message);
    }
    if (forceReport || batchInspected === batchTotal || fetchedCount % PROGRESS_REPORT_INTERVAL === 0) {
      report();
    }
    return inWindow;
  };

  report("Connecting to Gmail.");
  const profile = await gmailFetch<GmailProfile>(input.accessToken, "/users/me/profile", {
    onRetry: (delayMs) => report(`Gmail is throttling profile access. Retrying in ${formatDelay(delayMs)}.`)
  });
  input.onProfile?.(profile);
  const accountHash = await hashEmail(profile.emailAddress);
  report("Loading Gmail message list.");

  while (fetchedCount < input.maxMessages) {
    const remaining = input.maxMessages - fetchedCount;
    const pageSize = Math.min(500, remaining);
    const params = new URLSearchParams({
      maxResults: String(pageSize)
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const listedPage = await gmailFetch<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    }>(input.accessToken, `/users/me/messages?${params.toString()}`, {
      onRetry: (delayMs) => report(`Gmail is throttling message listing. Retrying in ${formatDelay(delayMs)}.`)
    });

    const ids = listedPage.messages ?? [];
    listed += ids.length;
    batchInspected = 0;
    batchTotal = ids.length;
    report(`Found ${listed} Gmail messages to inspect so far.`);
    if (ids.length === 0) {
      break;
    }

    let cachedMessages = new Map<string, GmailMessageMetadata>();
    try {
      cachedMessages = await getCachedMessages(
        accountHash,
        ids.map((message) => message.id)
      );
    } catch {
      report("Local message cache is unavailable; fetching from Gmail.");
    }

    const missing = ids.filter((message) => !cachedMessages.has(message.id));
    if (cachedMessages.size > 0) {
      report(`Loaded ${cachedMessages.size} messages from local cache.`);
    }

    let pageMessages = 0;
    let pageInWindow = 0;

    for (const message of ids) {
      const cached = cachedMessages.get(message.id);
      if (!cached) {
        continue;
      }
      pageMessages += 1;
      if (inspectMessage(cached, "cache")) {
        pageInWindow += 1;
      }
    }

    const fetchedMessages = await mapWithConcurrency(missing, scanProfile.concurrency, async (message) => {
      const fetched = await getMessageMetadata(input.accessToken, message.id, scanMode, messageGetPacer, (delayMs) => {
        report(`Gmail quota pacing: retrying in ${formatDelay(delayMs)}.`);
      });
      pageMessages += 1;
      if (inspectMessage(fetched, "gmail")) {
        pageInWindow += 1;
      }
      return fetched;
    });

    try {
      await putCachedMessages(accountHash, fetchedMessages);
    } catch {
      report("Could not update local message cache; scan will continue.");
    }

    report();

    if (pageMessages > 0 && pageInWindow === 0) {
      break;
    }

    pageToken = listedPage.nextPageToken ?? "";
    if (!pageToken) {
      break;
    }
  }

  return { profile, messages };
}

export async function hashEmail(email: string): Promise<string> {
  const encoded = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getMessageMetadata(
  accessToken: string,
  messageID: string,
  mode: GmailScanMode,
  pacer: AdaptiveRequestPacer,
  onRetry: (delayMs: number) => void
): Promise<GmailMessageMetadata> {
  const params = new URLSearchParams({ format: SCAN_PROFILES[mode].format });
  if (mode === "fast") {
    for (const header of METADATA_MESSAGE_HEADERS) {
      params.append("metadataHeaders", header);
    }
  }
  return gmailFetch<GmailMessageMetadata>(accessToken, `/users/me/messages/${messageID}?${params.toString()}`, {
    beforeRequest: () => pacer.wait(),
    onSuccess: () => pacer.recordSuccess(),
    onThrottle: () => pacer.recordThrottle(),
    onRetry
  });
}

function messageTime(message: GmailMessageMetadata): number {
  if (message.internalDate) {
    const millis = Number(message.internalDate);
    if (Number.isFinite(millis)) {
      return millis;
    }
  }
  const dateHeader = message.payload?.headers?.find((header) => header.name.toLowerCase() === "date")?.value ?? "";
  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function gmailFetch<T>(
  accessToken: string,
  path: string,
  options: {
    beforeRequest?: () => Promise<void>;
    onSuccess?: () => void;
    onThrottle?: () => void;
    onRetry?: (delayMs: number) => void;
    maxRetries?: number;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 6;
  const timeoutMs = options.timeoutMs ?? GMAIL_FETCH_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await options.beforeRequest?.();

    const controller = new AbortController();
    const timeoutID = window.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${GMAIL_API}${path}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        signal: controller.signal
      });
    } catch (err) {
      window.clearTimeout(timeoutID);
      if (attempt < maxRetries && err instanceof DOMException && err.name === "AbortError") {
        const delayMs = backoffDelayMs(attempt);
        options.onRetry?.(delayMs);
        await sleep(delayMs);
        continue;
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutID);
    }
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      options.onSuccess?.();
      return payload as T;
    }

    const apiError = parseAPIError(response, payload);
    if (attempt < maxRetries && isRetriableGmailError(apiError)) {
      options.onThrottle?.();
      const retryAfter = retryAfterMs(response.headers.get("Retry-After"));
      const delayMs = retryAfter ?? backoffDelayMs(attempt);
      options.onRetry?.(delayMs);
      await sleep(delayMs);
      continue;
    }

    throw apiError;
  }

  throw new Error("Gmail request failed after retries");
}

class AdaptiveRequestPacer {
  private nextAt = 0;
  private queue = Promise.resolve();
  private intervalMs: number;

  constructor(
    private readonly config: {
      initialIntervalMs: number;
      minIntervalMs: number;
      maxIntervalMs: number;
    }
  ) {
    this.intervalMs = config.initialIntervalMs;
  }

  wait(): Promise<void> {
    const scheduled = this.queue.then(async () => {
      const now = Date.now();
      const delayMs = Math.max(0, this.nextAt - now);
      this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    });

    this.queue = scheduled.catch(() => undefined);
    return scheduled;
  }

  recordSuccess() {
    this.intervalMs = Math.max(this.config.minIntervalMs, Math.floor(this.intervalMs * 0.9));
  }

  recordThrottle() {
    this.intervalMs = Math.min(this.config.maxIntervalMs, Math.max(this.intervalMs + 100, this.intervalMs * 2));
  }
}

function parseAPIError(response: Response, payload: any): GmailAPIError {
  const code = payload?.error?.status || payload?.error?.errors?.[0]?.reason || "";
  const message = payload?.error?.message || payload?.error_description || response.statusText || "Gmail request failed";
  return new GmailAPIError(response.status, code, message);
}

function isRetriableGmailError(error: GmailAPIError): boolean {
  if (error.status === 429 || error.status >= 500) {
    return true;
  }
  return ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED"].includes(error.code);
}

function retryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function backoffDelayMs(attempt: number): number {
  return Math.min(64_000, 2 ** attempt * 1000 + Math.floor(Math.random() * 1000));
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1000) {
    return `${delayMs}ms`;
  }
  return `${Math.ceil(delayMs / 1000)}s`;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function authErrorMessage(code: string): string {
  switch (code) {
    case "consent_required":
      return "Google requires consent before issuing a Gmail access token.";
    case "login_required":
      return "Google requires sign-in before issuing a Gmail access token.";
    case "interaction_required":
      return "Google requires user interaction before issuing a Gmail access token.";
    default:
      return code;
  }
}

async function loadGoogleIdentityServices(): Promise<void> {
  if (window.google?.accounts?.oauth2) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-google-identity]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Identity Services")), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(script);
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}
