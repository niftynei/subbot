package store_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/niftynei/subbot/internal/app"
	"github.com/niftynei/subbot/internal/store"
)

func TestSaveAndLoadLatestScan(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	accountHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	_, err = st.SaveScan(context.Background(), app.ScanRequest{
		AccountHash:  accountHash,
		AccountEmail: "user@example.com",
		Provider:     "gmail",
		WindowDays:   180,
		MessageCount: 42,
		ScannedAt:    "2026-05-16T18:00:00Z",
		Subscriptions: []app.Subscription{
			{
				Key:              "list:example",
				DisplayName:      "Example List",
				SenderEmail:      "news@example.com",
				SenderDomain:     "example.com",
				ListID:           "example",
				MessageCount:     12,
				FirstReceivedAt:  "2026-01-01T00:00:00Z",
				LastReceivedAt:   "2026-05-15T00:00:00Z",
				FrequencyLabel:   "1x/week",
				FrequencyPerWeek: 1,
				UnsubscribeMethods: []app.UnsubscribeMethod{
					{Type: "https_one_click", URL: "https://example.com/unsub", OneClick: true},
				},
				Messages: []app.SubscriptionMessage{
					{Subject: "Weekly update", ReceivedAt: "2026-05-15T00:00:00Z"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("save scan: %v", err)
	}

	latest, err := st.LatestScan(context.Background(), accountHash)
	if err != nil {
		t.Fatalf("latest scan: %v", err)
	}
	if latest == nil {
		t.Fatal("expected latest scan")
	}
	if latest.MessageCount != 42 {
		t.Fatalf("message count = %d, want 42", latest.MessageCount)
	}
	if latest.AccountEmail != "user@example.com" {
		t.Fatalf("account email = %q, want user@example.com", latest.AccountEmail)
	}
	if len(latest.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d, want 1", len(latest.Subscriptions))
	}
	if got := latest.Subscriptions[0].UnsubscribeMethods[0].Type; got != "https_one_click" {
		t.Fatalf("unsubscribe method = %q, want https_one_click", got)
	}
	if got := latest.Subscriptions[0].Messages[0].Subject; got != "Weekly update" {
		t.Fatalf("message subject = %q, want Weekly update", got)
	}

	accounts, err := st.ListAccounts(context.Background())
	if err != nil {
		t.Fatalf("list accounts: %v", err)
	}
	if len(accounts) != 1 {
		t.Fatalf("accounts = %d, want 1", len(accounts))
	}
	if accounts[0].Email != "user@example.com" {
		t.Fatalf("account export email = %q, want user@example.com", accounts[0].Email)
	}
}

func TestScansIncludeLatestUnsubscribeAttempt(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	ctx := context.Background()
	accountHash := "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	subscription := app.Subscription{
		Key:              "sender:news@example.com",
		DisplayName:      "Example News",
		SenderEmail:      "news@example.com",
		SenderDomain:     "example.com",
		MessageCount:     2,
		FirstReceivedAt:  "2026-05-10T00:00:00Z",
		LastReceivedAt:   "2026-05-16T00:00:00Z",
		FrequencyLabel:   "2x/week",
		FrequencyPerWeek: 2,
		UnsubscribeMethods: []app.UnsubscribeMethod{
			{Type: "https_one_click", URL: "https://example.com/unsub", OneClick: true},
		},
	}

	if err := st.RecordUnsubscribeAttempt(ctx, app.UnsubscribeAttemptInput{
		AccountHash:     accountHash,
		SubscriptionKey: subscription.Key,
		MethodType:      "https_one_click",
		Target:          "https://example.com/unsub",
		Status:          "success",
		HTTPStatus:      200,
		AttemptedAt:     "2026-05-15T12:00:00Z",
	}); err != nil {
		t.Fatalf("record unsubscribe attempt: %v", err)
	}

	saved, err := st.SaveScan(ctx, app.ScanRequest{
		AccountHash:   accountHash,
		AccountEmail:  "user@example.com",
		Provider:      "gmail",
		WindowDays:    30,
		MessageCount:  2,
		ScannedAt:     "2026-05-16T18:00:00Z",
		Subscriptions: []app.Subscription{subscription},
	})
	if err != nil {
		t.Fatalf("save scan: %v", err)
	}
	if saved.Subscriptions[0].UnsubscribeAttempt == nil {
		t.Fatal("saved scan missing unsubscribe attempt")
	}
	if got := saved.Subscriptions[0].UnsubscribeAttempt.AttemptedAt; got != "2026-05-15T12:00:00Z" {
		t.Fatalf("saved unsubscribe attempted_at = %q, want 2026-05-15T12:00:00Z", got)
	}

	latest, err := st.LatestScan(ctx, accountHash)
	if err != nil {
		t.Fatalf("latest scan: %v", err)
	}
	if latest.Subscriptions[0].UnsubscribeAttempt == nil {
		t.Fatal("latest scan missing unsubscribe attempt")
	}
	if got := latest.Subscriptions[0].UnsubscribeAttempt.Status; got != "success" {
		t.Fatalf("unsubscribe status = %q, want success", got)
	}
}
