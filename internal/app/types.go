package app

type UnsubscribeMethod struct {
	Type     string `json:"type"`
	URL      string `json:"url,omitempty"`
	Email    string `json:"email,omitempty"`
	Subject  string `json:"subject,omitempty"`
	OneClick bool   `json:"one_click,omitempty"`
}

type Subscription struct {
	Key                string              `json:"key"`
	DisplayName        string              `json:"display_name"`
	SenderEmail        string              `json:"sender_email,omitempty"`
	SenderDomain       string              `json:"sender_domain,omitempty"`
	ListID             string              `json:"list_id,omitempty"`
	MessageCount       int                 `json:"message_count"`
	FirstReceivedAt    string              `json:"first_received_at"`
	LastReceivedAt     string              `json:"last_received_at"`
	FrequencyLabel     string              `json:"frequency_label"`
	FrequencyPerWeek   float64             `json:"frequency_per_week"`
	UnsubscribeMethods []UnsubscribeMethod `json:"unsubscribe_methods"`
	UnsubscribeAttempt *UnsubscribeAttempt `json:"unsubscribe_attempt,omitempty"`
}

type UnsubscribeAttempt struct {
	MethodType  string `json:"method_type"`
	Target      string `json:"target"`
	Status      string `json:"status"`
	HTTPStatus  int    `json:"http_status,omitempty"`
	Error       string `json:"error,omitempty"`
	AttemptedAt string `json:"attempted_at"`
}

type ScanRequest struct {
	AccountHash   string         `json:"account_hash"`
	AccountEmail  string         `json:"account_email"`
	Provider      string         `json:"provider"`
	WindowDays    int            `json:"window_days"`
	MessageCount  int            `json:"message_count"`
	ScannedAt     string         `json:"scanned_at,omitempty"`
	Subscriptions []Subscription `json:"subscriptions"`
}

type ScanResult struct {
	ID            int64          `json:"id"`
	AccountHash   string         `json:"account_hash"`
	AccountEmail  string         `json:"account_email,omitempty"`
	Provider      string         `json:"provider"`
	WindowDays    int            `json:"window_days"`
	MessageCount  int            `json:"message_count"`
	ScannedAt     string         `json:"scanned_at"`
	Subscriptions []Subscription `json:"subscriptions,omitempty"`
}

type Account struct {
	Email       string `json:"email"`
	Provider    string `json:"provider"`
	FirstSeenAt string `json:"first_seen_at"`
	LastSeenAt  string `json:"last_seen_at"`
}

type BulkUnsubscribeRequest struct {
	AccountHash string                `json:"account_hash"`
	Items       []BulkUnsubscribeItem `json:"items"`
}

type BulkUnsubscribeItem struct {
	SubscriptionKey string            `json:"subscription_key"`
	Method          UnsubscribeMethod `json:"method"`
}

type UnsubscribeResult struct {
	SubscriptionKey string `json:"subscription_key"`
	MethodType      string `json:"method_type"`
	Target          string `json:"target"`
	Status          string `json:"status"`
	HTTPStatus      int    `json:"http_status,omitempty"`
	Error           string `json:"error,omitempty"`
	AttemptedAt     string `json:"attempted_at"`
}

type BulkUnsubscribeResponse struct {
	Results []UnsubscribeResult `json:"results"`
}

type UnsubscribeAttemptInput struct {
	AccountHash     string
	SubscriptionKey string
	MethodType      string
	Target          string
	Status          string
	HTTPStatus      int
	ErrorMessage    string
	AttemptedAt     string
}
