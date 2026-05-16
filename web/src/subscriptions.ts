import type { GmailMessageMetadata, GmailMessagePart, Subscription, UnsubscribeMethod } from "./types";

type Group = {
  key: string;
  displayName: string;
  senderEmail: string;
  senderDomain: string;
  listID: string;
  dates: Date[];
  methods: UnsubscribeMethod[];
};

export function buildSubscriptions(
  messages: GmailMessageMetadata[],
  options: { excludeSenderEmail?: string } = {}
): Subscription[] {
  const groups = new Map<string, Group>();
  const excludedSender = options.excludeSenderEmail?.trim().toLowerCase() ?? "";

  for (const message of messages) {
    const headers = message.payload?.headers ?? [];
    const from = parseAddress(headerValue(headers, "From") || headerValue(headers, "Sender"));
    if (excludedSender && from.email === excludedSender) {
      continue;
    }
    const date = parseMessageDate(message);
    const listID = normalizeListID(headerValue(headers, "List-ID") || headerValue(headers, "Mailing-List"));
    const methods = mergeMethods(
      parseUnsubscribeMethods(
        headerValue(headers, "List-Unsubscribe"),
        headerValue(headers, "List-Unsubscribe-Post")
      ),
      parseBodyUnsubscribeMethods(message)
    );

    const key = listID ? `list:${listID}` : from.email ? `sender:${from.email}` : `domain:${from.domain}`;
    if (!key || key === "domain:") {
      continue;
    }

    const current = groups.get(key);
    if (current) {
      current.dates.push(date);
      current.methods = mergeMethods(current.methods, methods);
      continue;
    }

    groups.set(key, {
      key,
      displayName: from.name || listID || from.domain || "Unknown sender",
      senderEmail: from.email,
      senderDomain: from.domain,
      listID,
      dates: [date],
      methods
    });
  }

  return Array.from(groups.values())
    .filter((group) => group.methods.length > 0)
    .map(toSubscription)
    .sort((a, b) => {
      if (b.frequency_per_week !== a.frequency_per_week) {
        return b.frequency_per_week - a.frequency_per_week;
      }
      if (b.message_count !== a.message_count) {
        return b.message_count - a.message_count;
      }
      return Date.parse(b.last_received_at) - Date.parse(a.last_received_at);
    });
}

export function oneClickMethod(subscription: Subscription): UnsubscribeMethod | undefined {
  return subscription.unsubscribe_methods.find((method) => method.type === "https_one_click" && method.one_click);
}

export function mailtoMethod(subscription: Subscription): UnsubscribeMethod | undefined {
  return subscription.unsubscribe_methods.find((method) => method.type === "mailto");
}

export function linkMethod(subscription: Subscription): UnsubscribeMethod | undefined {
  return subscription.unsubscribe_methods.find((method) => method.type === "https" && method.url);
}

function toSubscription(group: Group): Subscription {
  const dates = group.dates.sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0];
  const last = dates[dates.length - 1];
  const frequency = estimateFrequency(dates);

  return {
    key: group.key,
    display_name: group.displayName,
    sender_email: group.senderEmail,
    sender_domain: group.senderDomain,
    list_id: group.listID,
    message_count: dates.length,
    first_received_at: first.toISOString(),
    last_received_at: last.toISOString(),
    frequency_label: frequency.label,
    frequency_per_week: frequency.perWeek,
    unsubscribe_methods: group.methods
  };
}

function estimateFrequency(dates: Date[]): { label: string; perWeek: number } {
  if (dates.length <= 1) {
    return { label: "once", perWeek: 0 };
  }

  const first = dates[0].getTime();
  const last = dates[dates.length - 1].getTime();
  const spanDays = Math.max(1, (last - first) / 86_400_000);
  const perWeek = (dates.length - 1) / (spanDays / 7);
  const daysSinceLast = Math.max(0, (Date.now() - last) / 86_400_000);

  if (daysSinceLast > 90 && perWeek < 0.25) {
    return { label: "inactive", perWeek };
  }
  if (perWeek >= 1) {
    return { label: `${formatRate(perWeek)}x/week`, perWeek };
  }

  const perMonth = perWeek * 4.345;
  if (perMonth >= 1) {
    return { label: `${formatRate(perMonth)}x/month`, perWeek };
  }

  return { label: "less than monthly", perWeek };
}

function formatRate(value: number): string {
  if (value >= 10) {
    return String(Math.round(value));
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function parseMessageDate(message: GmailMessageMetadata): Date {
  if (message.internalDate) {
    const millis = Number(message.internalDate);
    if (Number.isFinite(millis)) {
      return new Date(millis);
    }
  }
  const headerDate = headerValue(message.payload?.headers ?? [], "Date");
  const parsed = Date.parse(headerDate);
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function parseUnsubscribeMethods(value: string, postValue: string): UnsubscribeMethod[] {
  const tokens = extractUnsubscribeTokens(value);
  const oneClick = /list-unsubscribe\s*=\s*one-click/i.test(postValue);
  const methods: UnsubscribeMethod[] = [];

  for (const token of tokens) {
    if (/^https:\/\//i.test(token)) {
      methods.push({
        type: oneClick ? "https_one_click" : "https",
        url: token,
        one_click: oneClick
      });
      continue;
    }
    if (/^mailto:/i.test(token)) {
      const parsed = parseMailto(token);
      if (parsed.email) {
        methods.push({
          type: "mailto",
          email: parsed.email,
          subject: parsed.subject
        });
      }
    }
  }

  return mergeMethods([], methods);
}

function parseBodyUnsubscribeMethods(message: GmailMessageMetadata): UnsubscribeMethod[] {
  const bodies = collectBodyParts(message.payload);
  const methods: UnsubscribeMethod[] = [];

  for (const html of bodies.html) {
    methods.push(...parseHTMLUnsubscribeLinks(html));
  }
  for (const text of bodies.text) {
    methods.push(...parseTextUnsubscribeLinks(text));
  }

  return mergeMethods([], methods);
}

function collectBodyParts(part: GmailMessagePart | undefined): { html: string[]; text: string[] } {
  const collected = { html: [] as string[], text: [] as string[] };
  if (!part) {
    return collected;
  }

  const decoded = part.body?.data ? decodeBase64URL(part.body.data) : "";
  if (decoded && part.mimeType === "text/html") {
    collected.html.push(decoded);
  } else if (decoded && part.mimeType === "text/plain") {
    collected.text.push(decoded);
  }

  for (const child of part.parts ?? []) {
    const childCollected = collectBodyParts(child);
    collected.html.push(...childCollected.html);
    collected.text.push(...childCollected.text);
  }

  return collected;
}

function parseHTMLUnsubscribeLinks(html: string): UnsubscribeMethod[] {
  const methods: UnsubscribeMethod[] = [];
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href") ?? "";
    const text = anchor.textContent ?? "";
    if (!looksLikeUnsubscribeLink(href, text)) {
      continue;
    }
    const method = unsubscribeMethodFromURL(href);
    if (method) {
      methods.push(method);
    }
  }

  return mergeMethods([], methods);
}

function parseTextUnsubscribeLinks(text: string): UnsubscribeMethod[] {
  const methods: UnsubscribeMethod[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!unsubscribeSignal.test(line)) {
      continue;
    }
    for (const url of extractURLs(line)) {
      const method = unsubscribeMethodFromURL(url);
      if (method) {
        methods.push(method);
      }
    }
  }

  for (const url of extractURLs(text)) {
    if (!unsubscribeSignal.test(url)) {
      continue;
    }
    const method = unsubscribeMethodFromURL(url);
    if (method) {
      methods.push(method);
    }
  }

  return mergeMethods([], methods);
}

const unsubscribeSignal =
  /unsubscribe|opt[-_\s]?out|email preferences|manage preferences|subscription preferences|notification settings|mailing preferences/i;

function looksLikeUnsubscribeLink(href: string, text: string): boolean {
  return unsubscribeSignal.test(href) || unsubscribeSignal.test(text);
}

function extractURLs(value: string): string[] {
  return Array.from(value.matchAll(/\b(?:https?:\/\/|mailto:)[^\s<>"')]+/gi)).map((match) =>
    match[0].replace(/[.,;:!?]+$/g, "")
  );
}

function unsubscribeMethodFromURL(value: string): UnsubscribeMethod | null {
  const trimmed = value.trim();
  if (/^mailto:/i.test(trimmed)) {
    const parsed = parseMailto(trimmed);
    return parsed.email ? { type: "mailto", email: parsed.email, subject: parsed.subject } : null;
  }

  try {
    const url = new URL(trimmed, window.location.origin);
    if (url.protocol !== "https:") {
      return null;
    }
    return { type: "https", url: url.toString() };
  } catch {
    return null;
  }
}

function decodeBase64URL(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function extractUnsubscribeTokens(value: string): string[] {
  if (!value) {
    return [];
  }

  const angleTokens = Array.from(value.matchAll(/<([^>]+)>/g)).map((match) => match[1].trim());
  if (angleTokens.length > 0) {
    return angleTokens;
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseMailto(value: string): { email: string; subject?: string } {
  try {
    const url = new URL(value);
    return {
      email: url.pathname,
      subject: url.searchParams.get("subject") ?? undefined
    };
  } catch {
    return { email: "" };
  }
}

function mergeMethods(existing: UnsubscribeMethod[], incoming: UnsubscribeMethod[]): UnsubscribeMethod[] {
  const byKey = new Map<string, UnsubscribeMethod>();
  for (const method of [...existing, ...incoming]) {
    const key = `${method.type}:${method.url ?? method.email ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, method);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => methodRank(a) - methodRank(b));
}

function methodRank(method: UnsubscribeMethod): number {
  if (method.type === "https_one_click") {
    return 0;
  }
  if (method.type === "mailto") {
    return 1;
  }
  return 2;
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseAddress(value: string): { name: string; email: string; domain: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { name: "", email: "", domain: "" };
  }

  const match = trimmed.match(/^(.*?)<([^>]+)>$/);
  const email = normalizeEmail(match ? match[2] : trimmed);
  const rawName = match ? match[1] : trimmed.split("@")[0];
  const domain = email.includes("@") ? email.split("@").pop() ?? "" : "";

  return {
    name: cleanDisplayName(rawName),
    email,
    domain
  };
}

function cleanDisplayName(value: string): string {
  return value
    .replace(/^"+|"+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value: string): string {
  return value.trim().replace(/^mailto:/i, "").replace(/^"+|"+$/g, "").toLowerCase();
}

function normalizeListID(value: string): string {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
