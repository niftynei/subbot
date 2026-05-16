package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/niftynei/subbot/internal/app"
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

func TestExportAccountsCSVAllowsAdminGmailProfile(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	_, err = st.SaveScan(context.Background(), app.ScanRequest{
		AccountHash:  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		AccountEmail: "user@example.com",
		Provider:     "gmail",
		WindowDays:   30,
		MessageCount: 0,
	})
	if err != nil {
		t.Fatalf("save scan: %v", err)
	}

	handler := httpapi.NewWithHTTPClient(st, "", gmailProfileClient("niftynei@gmail.com", http.StatusOK))
	req := httptest.NewRequest(http.MethodGet, "/api/accounts/export.csv", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET export status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/csv") {
		t.Fatalf("content type = %q, want text/csv", got)
	}
	if !strings.Contains(rec.Body.String(), "email,provider,first_seen_at,last_seen_at") {
		t.Fatalf("CSV missing header: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "user@example.com") {
		t.Fatalf("CSV missing account email: %s", rec.Body.String())
	}
}

func TestExportAccountsCSVRejectsNonAdminGmailProfile(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	handler := httpapi.NewWithHTTPClient(st, "", gmailProfileClient("other@example.com", http.StatusOK))
	req := httptest.NewRequest(http.MethodGet, "/api/accounts/export.csv", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("GET export status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestExportAccountsCSVRequiresBearerToken(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	handler := httpapi.NewWithHTTPClient(st, "", gmailProfileClient("niftynei@gmail.com", http.StatusOK))
	req := httptest.NewRequest(http.MethodGet, "/api/accounts/export.csv", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET export status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestStaticRoutesServeSEOAndReal404(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "subbot.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	staticDir := t.TempDir()
	index := `<!doctype html><html><head><!-- SEO_META_START --><title>fallback</title><!-- SEO_META_END --></head><body><div id="root"></div></body></html>`
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte(index), 0644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "robots.txt"), []byte("User-agent: *\n"), 0644); err != nil {
		t.Fatalf("write robots.txt: %v", err)
	}

	handler := httpapi.New(st, staticDir)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "<title>sub-scription bot | Gmail subscription audit tool</title>") {
		t.Fatalf("home HTML missing SEO title: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"@type": "SoftwareApplication"`) {
		t.Fatalf("home HTML missing software JSON-LD: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/policy", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /policy status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "<title>Privacy Policy | sub-scription bot</title>") {
		t.Fatalf("policy HTML missing route title: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `href="https://subbot.me/policy"`) {
		t.Fatalf("policy HTML missing canonical URL: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/terms", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /terms status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "<title>Terms of Service | sub-scription bot</title>") {
		t.Fatalf("terms HTML missing route title: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `href="https://subbot.me/terms"`) {
		t.Fatalf("terms HTML missing canonical URL: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/robots.txt", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /robots.txt status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "User-agent: *") {
		t.Fatalf("robots.txt not served: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/missing", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /missing status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "<html") {
		t.Fatalf("unknown route should not serve SPA HTML: %s", rec.Body.String())
	}
}

func gmailProfileClient(email string, status int) *http.Client {
	return &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body := `{"emailAddress":` + strconvQuote(email) + `}`
			return &http.Response{
				StatusCode: status,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    req,
			}, nil
		}),
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
