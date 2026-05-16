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
	if len(latest.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d, want 1", len(latest.Subscriptions))
	}
	if got := latest.Subscriptions[0].UnsubscribeMethods[0].Type; got != "https_one_click" {
		t.Fatalf("unsubscribe method = %q, want https_one_click", got)
	}
}
