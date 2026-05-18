import { Fragment, useEffect, useMemo, useState } from "react";
import { bulkUnsubscribe, downloadCollectedEmailsCSV, saveScan } from "./api";
import {
  hashEmail,
  isReadonlyScopeRequiredError,
  needsInteractiveAuth,
  requestGmailAccessToken,
  scanGmailMetadata,
  tokenIsUsable,
  type GmailScanMode,
  type GmailAccessToken,
  type GmailScanProgress
} from "./gmail";
import { buildSubscriptions, linkMethod, mailtoMethod, oneClickMethod } from "./subscriptions";
import type { BulkUnsubscribeResult, ScanResult, Subscription, UnsubscribeAttempt } from "./types";

type ScanStatus = "idle" | "authorizing" | "scanning" | "saving" | "done" | "error";

const SCAN_MONTHS = 6;
const MAX_MESSAGES = 1_000;
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const ADMIN_EMAIL = "niftynei@gmail.com";
const GITHUB_REPO_URL = "https://github.com/niftynei/subbot";
const PRODUCT_NAME = "sub-scription bot";
const SITE_URL = "https://subbot.me";
const BRAND_MARK_SRC = "/brand-mark-136.png";

const PAGE_METADATA = {
  home: {
    title: "sub-scription bot | Gmail subscription audit tool",
    description:
      "Audit Gmail subscriptions, see how often senders email you, review last received dates, and find unsubscribe options from one dashboard.",
    path: "/"
  },
  terms: {
    title: "Terms of Service | sub-scription bot",
    description: "Review the terms for using sub-scription bot to audit Gmail subscriptions and unsubscribe options.",
    path: "/terms"
  },
  policy: {
    title: "Privacy Policy | sub-scription bot",
    description:
      "Learn what sub-scription bot collects from Gmail, what is stored locally or on the server, and how account data is used.",
    path: "/policy"
  }
} as const;

function App() {
  if (window.location.pathname === "/terms") {
    return <TermsPage />;
  }
  if (window.location.pathname === "/policy") {
    return <PrivacyPolicyPage />;
  }
  return <AuditPage />;
}

function AuditPage() {
  useDocumentMetadata(PAGE_METADATA.home);

  const [months, setMonths] = useState(SCAN_MONTHS);
  const [maxMessages, setMaxMessages] = useState(MAX_MESSAGES);
  const [scanMode, setScanMode] = useState<GmailScanMode>("fast");
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [progress, setProgress] = useState<GmailScanProgress>({
    listed: 0,
    fetched: 0,
    cached: 0,
    matched: 0,
    cappedAt: maxMessages,
    batchInspected: 0,
    batchTotal: 0
  });
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [accountHash, setAccountHash] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [gmailToken, setGmailToken] = useState<GmailAccessToken | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [attempts, setAttempts] = useState<Record<string, BulkUnsubscribeResult>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const subscriptions = scan?.subscriptions ?? [];
  const selectedSubscriptions = useMemo(
    () =>
      subscriptions.filter(
        (subscription) =>
          selected.has(subscription.key) && canSendOneClickRequest(subscription, attempts[subscription.key])
      ),
    [attempts, selected, subscriptions]
  );

  async function runScan() {
    setError("");
    setStatus("authorizing");
    setScan(null);
    setSelected(new Set());
    setExpanded(new Set());
    setAttempts({});
    setProgress({
      listed: 0,
      fetched: 0,
      cached: 0,
      matched: 0,
      cappedAt: maxMessages,
      batchInspected: 0,
      batchTotal: 0
    });

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
          mode: scanMode,
          onProgress: setProgress,
          onProfile: (profile) => setAccountEmail(profile.emailAddress)
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
          mode: scanMode,
          onProgress: setProgress,
          onProfile: (profile) => setAccountEmail(profile.emailAddress)
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
        accountEmail: result.profile.emailAddress,
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
    if (!canSendOneClickRequest(subscription, attempts[subscription.key])) {
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
    const selectable = subscriptions.filter((subscription) =>
      canSendOneClickRequest(subscription, attempts[subscription.key])
    );
    setSelected((current) => {
      if (selectable.every((subscription) => current.has(subscription.key))) {
        return new Set();
      }
      return new Set(selectable.map((subscription) => subscription.key));
    });
  }

  function toggleExpanded(subscription: Subscription) {
    if (!subscription.messages?.length) {
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(subscription.key)) {
        next.delete(subscription.key);
      } else {
        next.add(subscription.key);
      }
      return next;
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

  async function downloadCollectedEmails() {
    setError("");

    try {
      const accessToken = await getAccessToken();
      const blob = await downloadCollectedEmailsCSV(accessToken);
      const objectURL = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectURL;
      link.download = `sub-scription-bot-collected-emails-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectURL);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Email CSV download failed");
    }
  }

  const busy = status === "authorizing" || status === "scanning" || status === "saving";
  const hasReusableToken = tokenIsUsable(gmailToken, GOOGLE_CLIENT_ID);
  const isExportAdmin = accountEmail.toLowerCase() === ADMIN_EMAIL;
  const unsubscribeRequestedCount = subscriptions.filter((subscription) =>
    isSuccessfulUnsubscribe(latestAttempt(subscription, attempts[subscription.key]))
  ).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src={BRAND_MARK_SRC} alt="" aria-hidden="true" />
          <div>
            <h1>{PRODUCT_NAME}</h1>
            <p>Email subscription audit for Gmail</p>
          </div>
        </div>
        <div className="topbar-actions">
          <a href="/terms">Terms</a>
          <a href="/policy">Privacy</a>
          <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          {isExportAdmin && (
            <button onClick={downloadCollectedEmails}>
              Download emails CSV
            </button>
          )}
          {accountEmail && <div className="account-pill">{accountEmail}</div>}
        </div>
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
          Scan mode
          <select value={scanMode} onChange={(event) => setScanMode(event.target.value as GmailScanMode)}>
            <option value="fast">Fast headers</option>
            <option value="complete">Complete bodies</option>
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
            {progress.batchTotal > 0
              ? `${progress.batchInspected} / ${progress.batchTotal} inspected in current batch`
              : `${progress.fetched} inspected`}
            {progress.fetched > 0 ? `, ${progress.fetched} total` : ""}
            {progress.cached > 0 ? `, ${progress.cached} from cache` : ""}, {progress.matched} in {months}mo window
          </span>
          {progress.notice && <div className="progress-note">{progress.notice}</div>}
        </section>
      )}

      {error && <div className="error-banner">{error}</div>}

      <section className="summary-grid">
        <Metric label="Subscriptions" value={String(subscriptions.length)} />
        <Metric label="Messages in window" value={String(scan?.message_count ?? 0)} />
        <Metric label="One-click available" value={String(subscriptions.filter(oneClickMethod).length)} />
        <Metric label="Requested" value={String(unsubscribeRequestedCount)} />
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
            <button
              disabled={
                !subscriptions.some((subscription) =>
                  canSendOneClickRequest(subscription, attempts[subscription.key])
                )
              }
              onClick={toggleAllOneClick}
            >
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
                const attempt = latestAttempt(subscription, attempts[subscription.key]);
                const canRequest = canSendOneClickRequest(subscription, attempts[subscription.key]);
                const isExpanded = expanded.has(subscription.key);
                const messages = subscription.messages ?? [];
                return (
                  <Fragment key={subscription.key}>
                    <tr>
                      <td>
                        <div className="select-cell">
                          <button
                            className={`expander ${isExpanded ? "expanded" : ""}`}
                            type="button"
                            aria-label={`${isExpanded ? "Hide" : "Show"} message subjects for ${subscription.display_name}`}
                            aria-expanded={isExpanded}
                            disabled={messages.length === 0}
                            onClick={() => toggleExpanded(subscription)}
                          >
                            <span aria-hidden="true" />
                          </button>
                          <input
                            type="checkbox"
                            aria-label={`Select ${subscription.display_name}`}
                            checked={selected.has(subscription.key)}
                            disabled={!canRequest}
                            onChange={() => toggleSelection(subscription)}
                          />
                        </div>
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
                      <td>
                        {attempt ? (
                          <AttemptBadge attempt={attempt} lastReceivedAt={subscription.last_received_at} />
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="message-row">
                        <td />
                        <td colSpan={6}>
                          <div className="message-list">
                            {messages.map((message, index) => (
                              <div className="message-summary" key={`${message.received_at}:${index}`}>
                                <span>{formatDate(message.received_at)}</span>
                                <strong>{message.subject || "(no subject)"}</strong>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

function TermsPage() {
  useDocumentMetadata(PAGE_METADATA.terms);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src={BRAND_MARK_SRC} alt="" aria-hidden="true" />
          <div>
            <h1>Terms of Service</h1>
            <p>Last updated May 16, 2026</p>
          </div>
        </div>
        <div className="topbar-actions">
          <a href="/policy">Privacy Policy</a>
          <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="/">Back to {PRODUCT_NAME}</a>
        </div>
      </header>

      <section className="terms-section">
        <h2>Use of {PRODUCT_NAME}</h2>
        <p>
          {PRODUCT_NAME} helps you audit Gmail subscription messages and unsubscribe from mailing lists where
          unsubscribe methods are available. You authorize {PRODUCT_NAME} to access Gmail through Google OAuth for
          the purpose of scanning subscription mail and calculating subscription summaries.
        </p>

        <h2>Information Collected</h2>
        <p>
          When you connect Gmail and run a scan, {PRODUCT_NAME} collects and stores your Gmail account email
          address, a hashed account identifier, scan timing and message-count metadata, aggregate
          subscription records, message subjects for listed subscription mail, unsubscribe methods found in
          messages, and unsubscribe attempt records.
          {PRODUCT_NAME} does not store full email message bodies or attachments on the server.
        </p>

        <h2>Local Browser Data</h2>
        <p>
          {PRODUCT_NAME} may store fetched Gmail message payloads in your browser's IndexedDB so repeated or
          interrupted scans can avoid refetching the same messages. Clearing site data for {PRODUCT_NAME} removes
          that local browser cache.
        </p>

        <h2>Use of Your Email Address</h2>
        <p>
          {PRODUCT_NAME} may use your Gmail account email address to operate the service, provide support, send
          product updates, and send marketing communications. Marketing emails should include a way to
          unsubscribe or opt out.
        </p>

        <h2>Unsubscribe Requests</h2>
        <p>
          If you choose to unsubscribe through {PRODUCT_NAME}, the service may send one-click unsubscribe requests
          to mailing-list endpoints discovered in your email. {PRODUCT_NAME} records the target, status, and time of
          those attempts.
        </p>

        <h2>Data Removal</h2>
        <p>
          If you want your stored account email address or scan records removed, contact the {PRODUCT_NAME}
          operator. Removing Google OAuth access from your Google account stops future access but does not
          automatically delete records already stored by {PRODUCT_NAME}.
        </p>
      </section>
    </main>
  );
}

function PrivacyPolicyPage() {
  useDocumentMetadata(PAGE_METADATA.policy);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src={BRAND_MARK_SRC} alt="" aria-hidden="true" />
          <div>
            <h1>Privacy Policy</h1>
            <p>Last updated May 16, 2026</p>
          </div>
        </div>
        <div className="topbar-actions">
          <a href="/terms">Terms</a>
          <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="/">Back to {PRODUCT_NAME}</a>
        </div>
      </header>

      <section className="terms-section">
        <h2>Overview</h2>
        <p>
          {PRODUCT_NAME} helps you audit Gmail subscription messages and identify unsubscribe options. This policy
          explains what {PRODUCT_NAME} collects, how that information is used, and what is stored locally in your
          browser versus on the {PRODUCT_NAME} server.
        </p>

        <h2>Information You Authorize From Google</h2>
        <p>
          When you connect Gmail, {PRODUCT_NAME} requests Gmail readonly access through Google OAuth. The browser
          uses that access to read Gmail profile metadata, message metadata, message headers, and message
          bodies needed to find subscription senders and unsubscribe links.
        </p>

        <h2>Information Stored On The Server</h2>
        <p>
          {PRODUCT_NAME} stores your Gmail account email address, a hashed account identifier, scan timing and
          message-count metadata, aggregate subscription records, message subjects for listed subscription mail,
          unsubscribe methods discovered in messages, and unsubscribe attempt records.
        </p>

        <h2>Information Not Stored On The Server</h2>
        <p>
          {PRODUCT_NAME} does not store full email message bodies, attachments, full raw Gmail payloads, or your
          Gmail OAuth access token on the server. Gmail message payloads may be cached locally in your
          browser's IndexedDB to avoid refetching the same messages during repeated or interrupted scans.
        </p>

        <h2>How Information Is Used</h2>
        <p>
          {PRODUCT_NAME} uses collected information to operate the subscription audit, display subscription
          summaries, save scan history, process one-click unsubscribe attempts, provide support, and contact
          users with service notices, product updates, or marketing communications.
        </p>

        <h2>Google API Data Use</h2>
        <p>
          {PRODUCT_NAME}'s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>

        <h2>Sharing</h2>
        <p>
          {PRODUCT_NAME} does not sell stored account data or subscription audit data. {PRODUCT_NAME} may share information
          when required to operate hosting, database, security, or support services; to comply with law; to
          investigate abuse or security issues; or as part of a merger, acquisition, or sale of assets.
        </p>

        <h2>Security And Retention</h2>
        <p>
          {PRODUCT_NAME} uses HTTPS in production and stores server-side records in its application database. Records
          are retained while needed to operate the service unless deletion is requested or retention is
          otherwise required for security, legal, or operational reasons.
        </p>

        <h2>Your Choices</h2>
        <p>
          You can revoke {PRODUCT_NAME}'s Google access from your Google Account permissions page. You can clear
          {PRODUCT_NAME} site data in your browser to remove the local IndexedDB message cache. To request deletion
          of stored account email or scan records, contact the {PRODUCT_NAME} operator.
        </p>

        <h2>Children</h2>
        <p>
          {PRODUCT_NAME} is not intended for children under 13 and should not be used to connect a child's Gmail
          account.
        </p>

        <h2>Changes</h2>
        <p>
          {PRODUCT_NAME} may update this policy as the service changes. Material changes should be reflected by an
          updated date on this page.
        </p>
      </section>
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

function useDocumentMetadata(meta: (typeof PAGE_METADATA)[keyof typeof PAGE_METADATA]) {
  useEffect(() => {
    document.title = meta.title;
    setMeta("name", "description", meta.description);
    setCanonical(`${SITE_URL}${meta.path}`);
  }, [meta]);
}

function setMeta(attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.content = content;
}

function setCanonical(href: string) {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement("link");
    element.rel = "canonical";
    document.head.append(element);
  }
  element.href = href;
}

function AttemptBadge(props: { attempt: UnsubscribeAttempt; lastReceivedAt: string }) {
  const sentAfterRequest = emailArrivedAfterAttempt(props.lastReceivedAt, props.attempt.attempted_at);
  if (props.attempt.status === "success" && sentAfterRequest) {
    return (
      <div className="status-stack">
        <span className="badge status-still_sending">Still sending</span>
        <span className="status-detail">
          requested {formatDate(props.attempt.attempted_at)}, last mail {formatDate(props.lastReceivedAt)}
        </span>
      </div>
    );
  }

  const label =
    props.attempt.status === "success"
      ? `Requested ${formatDate(props.attempt.attempted_at)}`
      : props.attempt.status === "manual_required"
        ? "Manual"
        : `Failed ${formatDate(props.attempt.attempted_at)}`;
  return (
    <div className="status-stack">
      <span className={`badge status-${props.attempt.status}`}>{label}</span>
      {props.attempt.status !== "success" && props.attempt.error && (
        <span className="status-detail">{props.attempt.error}</span>
      )}
    </div>
  );
}

function latestAttempt(
  subscription: Subscription,
  currentAttempt: BulkUnsubscribeResult | undefined
): UnsubscribeAttempt | undefined {
  return currentAttempt ?? subscription.unsubscribe_attempt;
}

function canSendOneClickRequest(
  subscription: Subscription,
  currentAttempt: BulkUnsubscribeResult | undefined
): boolean {
  if (!oneClickMethod(subscription)) {
    return false;
  }
  const attempt = latestAttempt(subscription, currentAttempt);
  if (attempt?.status !== "success") {
    return true;
  }
  return emailArrivedAfterAttempt(subscription.last_received_at, attempt.attempted_at);
}

function isSuccessfulUnsubscribe(attempt: UnsubscribeAttempt | undefined): boolean {
  return attempt?.status === "success";
}

function emailArrivedAfterAttempt(lastReceivedAt: string, attemptedAt: string): boolean {
  const lastReceived = Date.parse(lastReceivedAt);
  const attempted = Date.parse(attemptedAt);
  return Number.isFinite(lastReceived) && Number.isFinite(attempted) && lastReceived > attempted;
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
