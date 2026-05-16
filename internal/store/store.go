package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/niftynei/subbot/internal/app"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if path == "" {
		path = "data/subbot.sqlite"
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.configure(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := s.Migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) configure() error {
	pragmas := []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
	}
	for _, pragma := range pragmas {
		if _, err := s.db.Exec(pragma); err != nil {
			return fmt.Errorf("configure sqlite %q: %w", pragma, err)
		}
	}
	return nil
}

func (s *Store) Migrate(ctx context.Context) error {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		body, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		if _, err := s.db.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("apply migration %s: %w", entry.Name(), err)
		}
	}
	return nil
}

func (s *Store) SaveScan(ctx context.Context, req app.ScanRequest) (app.ScanResult, error) {
	scannedAt := strings.TrimSpace(req.ScannedAt)
	if scannedAt == "" {
		scannedAt = time.Now().UTC().Format(time.RFC3339)
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = "gmail"
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return app.ScanResult{}, fmt.Errorf("begin save scan: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	res, err := tx.ExecContext(ctx, `
		INSERT INTO scans(account_hash, provider, window_days, message_count, scanned_at)
		VALUES (?, ?, ?, ?, ?)
	`, req.AccountHash, provider, req.WindowDays, req.MessageCount, scannedAt)
	if err != nil {
		return app.ScanResult{}, fmt.Errorf("insert scan: %w", err)
	}
	scanID, err := res.LastInsertId()
	if err != nil {
		return app.ScanResult{}, fmt.Errorf("scan id: %w", err)
	}

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO subscriptions(
			scan_id, account_hash, subscription_key, display_name, sender_email, sender_domain, list_id,
			message_count, first_received_at, last_received_at, frequency_label, frequency_per_week,
			unsubscribe_methods_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return app.ScanResult{}, fmt.Errorf("prepare insert subscriptions: %w", err)
	}
	defer stmt.Close()

	for _, sub := range req.Subscriptions {
		methodsJSON, err := json.Marshal(sub.UnsubscribeMethods)
		if err != nil {
			return app.ScanResult{}, fmt.Errorf("marshal unsubscribe methods for %s: %w", sub.Key, err)
		}
		if _, err = stmt.ExecContext(ctx,
			scanID,
			req.AccountHash,
			sub.Key,
			sub.DisplayName,
			sub.SenderEmail,
			sub.SenderDomain,
			sub.ListID,
			sub.MessageCount,
			sub.FirstReceivedAt,
			sub.LastReceivedAt,
			sub.FrequencyLabel,
			sub.FrequencyPerWeek,
			string(methodsJSON),
		); err != nil {
			return app.ScanResult{}, fmt.Errorf("insert subscription %s: %w", sub.Key, err)
		}
	}

	if err = tx.Commit(); err != nil {
		return app.ScanResult{}, fmt.Errorf("commit scan: %w", err)
	}

	return app.ScanResult{
		ID:            scanID,
		AccountHash:   req.AccountHash,
		Provider:      provider,
		WindowDays:    req.WindowDays,
		MessageCount:  req.MessageCount,
		ScannedAt:     scannedAt,
		Subscriptions: req.Subscriptions,
	}, nil
}

func (s *Store) LatestScan(ctx context.Context, accountHash string) (*app.ScanResult, error) {
	var scan app.ScanResult
	err := s.db.QueryRowContext(ctx, `
		SELECT id, account_hash, provider, window_days, message_count, scanned_at
		FROM scans
		WHERE account_hash = ?
		ORDER BY scanned_at DESC, id DESC
		LIMIT 1
	`, accountHash).Scan(
		&scan.ID,
		&scan.AccountHash,
		&scan.Provider,
		&scan.WindowDays,
		&scan.MessageCount,
		&scan.ScannedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load latest scan: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT subscription_key, display_name, sender_email, sender_domain, list_id,
			message_count, first_received_at, last_received_at, frequency_label,
			frequency_per_week, unsubscribe_methods_json
		FROM subscriptions
		WHERE scan_id = ?
		ORDER BY message_count DESC, last_received_at DESC
	`, scan.ID)
	if err != nil {
		return nil, fmt.Errorf("load subscriptions: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var sub app.Subscription
		var methodsJSON string
		if err := rows.Scan(
			&sub.Key,
			&sub.DisplayName,
			&sub.SenderEmail,
			&sub.SenderDomain,
			&sub.ListID,
			&sub.MessageCount,
			&sub.FirstReceivedAt,
			&sub.LastReceivedAt,
			&sub.FrequencyLabel,
			&sub.FrequencyPerWeek,
			&methodsJSON,
		); err != nil {
			return nil, fmt.Errorf("scan subscription: %w", err)
		}
		if err := json.Unmarshal([]byte(methodsJSON), &sub.UnsubscribeMethods); err != nil {
			return nil, fmt.Errorf("decode unsubscribe methods for %s: %w", sub.Key, err)
		}
		scan.Subscriptions = append(scan.Subscriptions, sub)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate subscriptions: %w", err)
	}

	return &scan, nil
}

func (s *Store) RecordUnsubscribeAttempt(ctx context.Context, in app.UnsubscribeAttemptInput) error {
	if in.AttemptedAt == "" {
		in.AttemptedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO unsubscribe_attempts(
			account_hash, subscription_key, method_type, target, status, http_status, error_message, attempted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, in.AccountHash, in.SubscriptionKey, in.MethodType, in.Target, in.Status, in.HTTPStatus, in.ErrorMessage, in.AttemptedAt)
	if err != nil {
		return fmt.Errorf("record unsubscribe attempt: %w", err)
	}
	return nil
}
