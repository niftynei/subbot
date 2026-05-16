import type { BulkUnsubscribeResult, ScanResult, Subscription, UnsubscribeMethod } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function saveScan(input: {
  accountHash: string;
  accountEmail: string;
  windowDays: number;
  messageCount: number;
  subscriptions: Subscription[];
}): Promise<ScanResult> {
  const response = await fetch(`${API_BASE}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_hash: input.accountHash,
      account_email: input.accountEmail,
      provider: "gmail",
      window_days: input.windowDays,
      message_count: input.messageCount,
      scanned_at: new Date().toISOString(),
      subscriptions: input.subscriptions
    })
  });
  return parseJSON(response);
}

export async function loadLatestScan(accountHash: string): Promise<ScanResult | null> {
  const response = await fetch(`${API_BASE}/api/scans/latest?account_hash=${encodeURIComponent(accountHash)}`);
  const payload = await parseJSON<ScanResult | { scan: null }>(response);
  if ("scan" in payload && payload.scan === null) {
    return null;
  }
  return payload as ScanResult;
}

export async function bulkUnsubscribe(input: {
  accountHash: string;
  items: Array<{ subscriptionKey: string; method: UnsubscribeMethod }>;
}): Promise<BulkUnsubscribeResult[]> {
  const response = await fetch(`${API_BASE}/api/unsubscribe/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_hash: input.accountHash,
      items: input.items.map((item) => ({
        subscription_key: item.subscriptionKey,
        method: item.method
      }))
    })
  });
  const payload = await parseJSON<{ results: BulkUnsubscribeResult[] }>(response);
  return payload.results;
}

export async function downloadCollectedEmailsCSV(accessToken: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/accounts/export.csv`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = payload && typeof payload.error === "string" ? payload.error : response.statusText;
    throw new Error(message);
  }
  return response.blob();
}

async function parseJSON<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === "string" ? payload.error : response.statusText;
    throw new Error(message);
  }
  return payload as T;
}
