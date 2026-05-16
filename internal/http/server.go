package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/niftynei/subbot/internal/app"
	"github.com/niftynei/subbot/internal/store"
)

const maxJSONBody = 4 << 20

var accountHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Server struct {
	store     *store.Store
	client    *http.Client
	staticDir string
}

func New(st *store.Store, staticDir string) http.Handler {
	s := &Server{
		store: st,
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
		staticDir: staticDir,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/scans", s.handleCreateScan)
	mux.HandleFunc("GET /api/scans/latest", s.handleLatestScan)
	mux.HandleFunc("POST /api/unsubscribe/bulk", s.handleBulkUnsubscribe)
	mux.HandleFunc("/", s.handleStatic)

	return withCORS(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleCreateScan(w http.ResponseWriter, r *http.Request) {
	var req app.ScanRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateScan(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := s.store.SaveScan(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save scan failed")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) handleLatestScan(w http.ResponseWriter, r *http.Request) {
	accountHash := strings.TrimSpace(r.URL.Query().Get("account_hash"))
	if !accountHashPattern.MatchString(accountHash) {
		writeError(w, http.StatusBadRequest, "account_hash must be a SHA-256 hex string")
		return
	}

	result, err := s.store.LatestScan(r.Context(), accountHash)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load latest scan failed")
		return
	}
	if result == nil {
		writeJSON(w, http.StatusOK, map[string]any{"scan": nil})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleBulkUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var req app.BulkUnsubscribeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !accountHashPattern.MatchString(strings.TrimSpace(req.AccountHash)) {
		writeError(w, http.StatusBadRequest, "account_hash must be a SHA-256 hex string")
		return
	}
	if len(req.Items) == 0 {
		writeError(w, http.StatusBadRequest, "at least one unsubscribe item is required")
		return
	}
	if len(req.Items) > 100 {
		writeError(w, http.StatusBadRequest, "bulk unsubscribe is limited to 100 items")
		return
	}

	results := make([]app.UnsubscribeResult, 0, len(req.Items))
	for _, item := range req.Items {
		result := s.unsubscribeOne(r, req.AccountHash, item)
		results = append(results, result)

		_ = s.store.RecordUnsubscribeAttempt(r.Context(), app.UnsubscribeAttemptInput{
			AccountHash:     req.AccountHash,
			SubscriptionKey: result.SubscriptionKey,
			MethodType:      result.MethodType,
			Target:          result.Target,
			Status:          result.Status,
			HTTPStatus:      result.HTTPStatus,
			ErrorMessage:    result.Error,
			AttemptedAt:     result.AttemptedAt,
		})
	}

	writeJSON(w, http.StatusOK, app.BulkUnsubscribeResponse{Results: results})
}

func (s *Server) unsubscribeOne(r *http.Request, accountHash string, item app.BulkUnsubscribeItem) app.UnsubscribeResult {
	attemptedAt := time.Now().UTC().Format(time.RFC3339)
	methodType := strings.TrimSpace(item.Method.Type)
	target := strings.TrimSpace(item.Method.URL)
	if target == "" && item.Method.Email != "" {
		target = "mailto:" + item.Method.Email
	}

	result := app.UnsubscribeResult{
		SubscriptionKey: item.SubscriptionKey,
		MethodType:      methodType,
		Target:          target,
		Status:          "failed",
		AttemptedAt:     attemptedAt,
	}

	if strings.TrimSpace(item.SubscriptionKey) == "" {
		result.Error = "subscription_key is required"
		return result
	}

	switch methodType {
	case "https_one_click":
		if !item.Method.OneClick {
			result.Error = "one-click confirmation header was not present"
			return result
		}
		status, err := s.postOneClick(r, target)
		result.HTTPStatus = status
		if err != nil {
			result.Error = err.Error()
			return result
		}
		result.Status = "success"
		return result
	case "mailto":
		result.Status = "manual_required"
		return result
	default:
		result.Error = "unsupported unsubscribe method"
		return result
	}
}

func (s *Server) postOneClick(r *http.Request, target string) (int, error) {
	parsed, err := url.Parse(target)
	if err != nil {
		return 0, fmt.Errorf("invalid unsubscribe URL")
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return 0, fmt.Errorf("unsubscribe URL must use https")
	}

	body := strings.NewReader("List-Unsubscribe=One-Click")
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, parsed.String(), body)
	if err != nil {
		return 0, fmt.Errorf("create unsubscribe request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "subbot/0.1")

	resp, err := s.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("unsubscribe request failed: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("unsubscribe endpoint returned HTTP %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	staticDir := s.staticDir
	if staticDir == "" {
		staticDir = "web/dist"
	}

	cleanPath := path.Clean("/" + r.URL.Path)
	if cleanPath == "/" {
		cleanPath = "/index.html"
	}
	target := filepath.Join(staticDir, filepath.FromSlash(strings.TrimPrefix(cleanPath, "/")))

	if info, err := os.Stat(target); err == nil && !info.IsDir() {
		http.ServeFile(w, r, target)
		return
	}

	indexPath := filepath.Join(staticDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		writeError(w, http.StatusNotFound, "frontend is not built; run npm run build in web/")
		return
	}
	http.ServeFile(w, r, indexPath)
}

func validateScan(req app.ScanRequest) error {
	if !accountHashPattern.MatchString(strings.TrimSpace(req.AccountHash)) {
		return errors.New("account_hash must be a SHA-256 hex string")
	}
	accountEmail := strings.TrimSpace(req.AccountEmail)
	parsedAccountEmail, err := mail.ParseAddress(accountEmail)
	if err != nil || parsedAccountEmail.Address != accountEmail {
		return errors.New("account_email must be a valid email address")
	}
	if req.Provider != "" && req.Provider != "gmail" {
		return errors.New("provider must be gmail")
	}
	if req.WindowDays < 0 || req.WindowDays > 3650 {
		return errors.New("window_days must be between 0 and 3650")
	}
	if req.MessageCount < 0 {
		return errors.New("message_count cannot be negative")
	}
	if len(req.Subscriptions) > 5000 {
		return errors.New("too many subscriptions in one scan")
	}
	for _, sub := range req.Subscriptions {
		if strings.TrimSpace(sub.Key) == "" {
			return errors.New("subscription key is required")
		}
		if strings.TrimSpace(sub.DisplayName) == "" {
			return errors.New("subscription display_name is required")
		}
		if sub.MessageCount < 0 {
			return errors.New("subscription message_count cannot be negative")
		}
	}
	return nil
}

func decodeJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxJSONBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isAllowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
