package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	httpapi "github.com/niftynei/subbot/internal/http"
	"github.com/niftynei/subbot/internal/store"
)

func TestCreateAndLoadScan(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	handler := httpapi.New(st, "")
	accountHash := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	body := map[string]any{
		"account_hash":  accountHash,
		"account_email": "user@example.com",
		"provider":      "gmail",
		"window_days":   30,
		"message_count": 3,
		"subscriptions": []map[string]any{
			{
				"key":                 "sender:example.com",
				"display_name":        "Example",
				"sender_domain":       "example.com",
				"message_count":       3,
				"first_received_at":   "2026-05-01T00:00:00Z",
				"last_received_at":    "2026-05-15T00:00:00Z",
				"frequency_label":     "1.5x/week",
				"frequency_per_week":  1.5,
				"unsubscribe_methods": []map[string]any{},
			},
		},
	}
	payload, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/scans", bytes.NewReader(payload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /api/scans status = %d, body = %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/scans/latest?account_hash="+accountHash, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET latest status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"display_name":"Example"`)) {
		t.Fatalf("latest response missing subscription: %s", rec.Body.String())
	}
}
