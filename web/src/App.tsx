import { useMemo, useState } from "react";
import { bulkUnsubscribe, saveScan } from "./api";
import {
  hashEmail,
  isReadonlyScopeRequiredError,
  needsInteractiveAuth,
  requestGmailAccessToken,
  scanGmailMetadata,
  tokenIsUsable,
  type GmailAccessToken,
  type GmailScanProgress
} from "./gmail";
import { buildSubscriptions, linkMethod, mailtoMethod, oneClickMethod } from "./subscriptions";
import type { BulkUnsubscribeResult, ScanResult, Subscription } from "./types";

type ScanStatus = "idle" | "authorizing" | "scanning" | "saving" | "done" | "error";

const SCAN_MONTHS = 12;
const MAX_MESSAGES = 5_000;
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

function App() {
  const [months, setMonths] = useState(SCAN_MONTHS);
  const [maxMessages, setMaxMessages] = useState(MAX_MESSAGES);
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [progress, setProgress] = useState<GmailScanProgress>({
    listed: 0,
    fetched: 0,
    cached: 0,
    matched: 0,
    cappedAt: maxMessages
  });
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [accountHash, setAccountHash] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [gmailToken, setGmailToken] = useState<GmailAccessToken | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attempts, setAttempts] = useState<Record<string, BulkUnsubscribeResult>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const subscriptions = scan?.subscriptions ?? [];
  const selectedSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => selected.has(subscription.key) && oneClickMethod(subscription)),
    [selected, subscriptions]
  );

  async function runScan() {
    setError("");
    setStatus("authorizing");
    setScan(null);
    setSelected(new Set());
    setAttempts({});
    setProgress({ listed: 0, fetched: 0, cached: 0, matched: 0, cappedAt: maxMessages });

    try {
      if (!GOOGLE_CLIENT_ID) {
        throw new Error("Missing VITE_GOOGLE_CLIENT_ID. Add it to web/.env.local and restart the dev server.");
      }
      let accessToken = await getAccessToken();
      setStatus("scanning");
      let result;
      try {
        result = await scanGmailMetadata({
          accessToken,
          maxMessages,
          months,
          onProgress: setProgress
        });
      } catch (err) {
        if (!isReadonlyScopeRequiredError(err)) {
          throw err;
        }

        setGmailToken(null);
        setStatus("authorizing");
        accessToken = await getAccessToken({ forceConsent: true });
        setStatus("scanning");
        result = await scanGmailMetadata({
          accessToken,
          maxMessages,
          months,
          onProgress: setProgress
        });
      }
      const hash = await hashEmail(result.profile.emailAddress);
      const builtSubscriptions = buildSubscriptions(result.messages, {
        excludeSenderEmail: result.profile.emailAddress
      });

      setAccountHash(hash);
      setAccountEmail(result.profile.emailAddress);
      setStatus("saving");
      const saved = await saveScan({
        accountHash: hash,
        windowDays: Math.round(months * 30.4),
        messageCount: result.messages.length,
        subscriptions: builtSubscriptions
      });
      setScan(saved);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setStatus("error");
    }
  }

  async function getAccessToken(options: { forceConsent?: boolean } = {}): Promise<string> {
    if (!options.forceConsent && tokenIsUsable(gmailToken, GOOGLE_CLIENT_ID)) {
      return gmailToken.token;
    }

    try {
      const token = await requestGmailAccessToken(GOOGLE_CLIENT_ID, {
        forceConsent: options.forceConsent
      });
      setGmailToken(token);
      return token.token;
    } catch (err) {
      if (!needsInteractiveAuth(err)) {
        throw err;
      }

      const token = await requestGmailAccessToken(GOOGLE_CLIENT_ID, { forceConsent: true });
      setGmailToken(token);
      return token.token;
    }
  }

  function toggleSelection(subscription: Subscription) {
    if (!oneClickMethod(subscription)) {
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(subscription.key)) {
        next.delete(subscription.key);
      } else {
        next.add(subscription.key);
      }
      return next;
    });
  }

  function toggleAllOneClick() {
    const selectable = subscriptions.filter(oneClickMethod);
    setSelected((current) => {
      if (selectable.every((subscription) => current.has(subscription.key))) {
        return new Set();
      }
      return new Set(selectable.map((subscription) => subscription.key));
    });
  }

  async function runBulkUnsubscribe() {
    setError("");
    setConfirming(false);

    try {
      const results = await bulkUnsubscribe({
        accountHash,
        items: selectedSubscriptions.map((subscription) => ({
          subscriptionKey: subscription.key,
          method: oneClickMethod(subscription)!
        }))
      });
      setAttempts((current) => {
        const next = { ...current };
        for (const result of results) {
          next[result.subscription_key] = result;
        }
        return next;
      });
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk unsubscribe failed");
    }
  }

  const busy = status === "authorizing" || status === "scanning" || status === "saving";
  const hasReusableToken = tokenIsUsable(gmailToken, GOOGLE_CLIENT_ID);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Subbot</h1>
          <p>Email subscription audit for Gmail</p>
        </div>
        {accountEmail && <div className="account-pill">{accountEmail}</div>}
      </header>

      <section className="controls">
        <label>
          Scan window
          <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
            <option value={24}>24 months</option>
          </select>
        </label>
        <label>
          Message cap
          <select value={maxMessages} onChange={(event) => setMaxMessages(Number(event.target.value))}>
            <option value={250}>250</option>
            <option value={1000}>1,000</option>
            <option value={2500}>2,500</option>
            <option value={5000}>5,000</option>
          </select>
        </label>
        <button className="primary" disabled={!GOOGLE_CLIENT_ID || busy} onClick={runScan}>
          {busy ? statusLabel(status) : hasReusableToken ? "Scan Gmail" : "Connect and scan"}
        </button>
      </section>

      {busy && (
        <section className="progress-band" aria-live="polite">
          <span>{statusLabel(status)}</span>
          <progress value={progress.fetched} max={progress.cappedAt} />
          <span>
            {progress.fetched} inspected
            {progress.cached > 0 ? `, ${progress.cached} from cache` : ""}, {progress.matched} in {months}mo
            window
          </span>
          {progress.notice && <div className="progress-note">{progress.notice}</div>}
        </section>
      )}

      {error && <div className="error-banner">{error}</div>}

      <section className="summary-grid">
        <Metric label="Subscriptions" value={String(subscriptions.length)} />
        <Metric label="Messages in window" value={String(scan?.message_count ?? 0)} />
        <Metric label="One-click available" value={String(subscriptions.filter(oneClickMethod).length)} />
        <Metric label="Last scan" value={scan ? formatDateTime(scan.scanned_at) : "Not run"} />
      </section>

      <section className="results-section">
        <div className="results-header">
          <div>
            <h2>Subscriptions</h2>
            <p>
              {subscriptions.length
                ? "Sorted from most frequent to least frequent"
                : "Run a scan to populate this table"}
            </p>
          </div>
          <div className="table-actions">
            <button disabled={!subscriptions.some(oneClickMethod)} onClick={toggleAllOneClick}>
              Select one-click
            </button>
            <button
              className="danger"
              disabled={selectedSubscriptions.length === 0}
              onClick={() => setConfirming(true)}
            >
              Unsubscribe selected
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>Sender</th>
                <th>Cadence</th>
                <th>Last received</th>
                <th>Count</th>
                <th>Unsubscribe</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => {
                const oneClick = oneClickMethod(subscription);
                const link = linkMethod(subscription);
                const mailto = mailtoMethod(subscription);
                const attempt = attempts[subscription.key];
                return (
                  <tr key={subscription.key}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${subscription.display_name}`}
                        checked={selected.has(subscription.key)}
                        disabled={!oneClick}
                        onChange={() => toggleSelection(subscription)}
                      />
                    </td>
                    <td>
                      <div className="sender-name">{subscription.display_name}</div>
                      <div className="muted">{subscription.sender_email || subscription.sender_domain}</div>
                    </td>
                    <td>{subscription.frequency_label}</td>
                    <td>{formatDate(subscription.last_received_at)}</td>
                    <td>{subscription.message_count}</td>
                    <td>
                      {oneClick ? (
                        <span className="badge good">One-click</span>
                      ) : link ? (
                        <a className="badge action-link" href={link.url} target="_blank" rel="noreferrer">
                          Open link
                        </a>
                      ) : mailto ? (
                        <a className="badge" href={mailtoHref(mailto.email!, mailto.subject)}>
                          Email
                        </a>
                      ) : (
                        <span className="badge muted-badge">None</span>
                      )}
                    </td>
                    <td>{attempt ? <AttemptBadge attempt={attempt} /> : <span className="muted">-</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {confirming && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">Confirm bulk unsubscribe</h2>
            <p>
              This will send one-click unsubscribe requests for {selectedSubscriptions.length} selected
              subscriptions.
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirming(false)}>Cancel</button>
              <button className="danger" onClick={runBulkUnsubscribe}>
                Send requests
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function AttemptBadge(props: { attempt: BulkUnsubscribeResult }) {
  const label =
    props.attempt.status === "success"
      ? "Success"
      : props.attempt.status === "manual_required"
        ? "Manual"
        : "Failed";
  return <span className={`badge status-${props.attempt.status}`}>{label}</span>;
}

function statusLabel(status: ScanStatus): string {
  switch (status) {
    case "authorizing":
      return "Authorizing";
    case "scanning":
      return "Scanning";
    case "saving":
      return "Saving";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value)
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function mailtoHref(email: string, subject?: string): string {
  const url = new URL(`mailto:${email}`);
  if (subject) {
    url.searchParams.set("subject", subject);
  }
  return url.toString();
}

export default App;
