export type UnsubscribeMethod = {
  type: "https_one_click" | "https" | "mailto";
  url?: string;
  email?: string;
  subject?: string;
  one_click?: boolean;
};

export type Subscription = {
  key: string;
  display_name: string;
  sender_email?: string;
  sender_domain?: string;
  list_id?: string;
  message_count: number;
  first_received_at: string;
  last_received_at: string;
  frequency_label: string;
  frequency_per_week: number;
  unsubscribe_methods: UnsubscribeMethod[];
};

export type ScanResult = {
  id: number;
  account_hash: string;
  provider: "gmail";
  window_days: number;
  message_count: number;
  scanned_at: string;
  subscriptions: Subscription[];
};

export type BulkUnsubscribeResult = {
  subscription_key: string;
  method_type: string;
  target: string;
  status: "pending" | "success" | "failed" | "manual_required";
  http_status?: number;
  error?: string;
  attempted_at: string;
};

export type GmailHeader = {
  name: string;
  value: string;
};

export type GmailMessagePartBody = {
  data?: string;
  size?: number;
  attachmentId?: string;
};

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
};

export type GmailMessageMetadata = {
  id: string;
  internalDate?: string;
  payload?: GmailMessagePart;
};
