package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/niftynei/subbot/internal/app"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

//go:embed schema_*.sql
var schemaFiles embed.FS

type Dialect string

const (
	DialectSQLite   Dialect = "sqlite"
	DialectPostgres Dialect = "postgres"
)

type Store struct {
	db      *sql.DB
	dialect Dialect
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

	s := &Store{db: db, dialect: DialectSQLite}
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

func OpenPostgres(databaseURL string) (*Store, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("database URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	s := &Store{db: db, dialect: DialectPostgres}
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
	if s.dialect != DialectSQLite {
		return nil
	}
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
	schemaName := "schema_sqlite.sql"
	if s.dialect == DialectPostgres {
		schemaName = "schema_postgres.sql"
	}
	body, err := schemaFiles.ReadFile(schemaName)
	if err != nil {
		return fmt.Errorf("read schema %s: %w", schemaName, err)
	}
	if _, err := s.db.ExecContext(ctx, string(body)); err != nil {
		return fmt.Errorf("apply schema %s: %w", schemaName, err)
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
	accountEmail := strings.TrimSpace(req.AccountEmail)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return app.ScanResult{}, fmt.Errorf("begin save scan: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	_, err = tx.ExecContext(ctx, s.rebind(`
		INSERT INTO accounts(account_hash, email, provider, first_seen_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(account_hash) DO UPDATE SET
			email = excluded.email,
			provider = excluded.provider,
			last_seen_at = excluded.last_seen_at
	`), req.AccountHash, accountEmail, provider, scannedAt, scannedAt)
	if err != nil {
		return app.ScanResult{}, fmt.Errorf("upsert account: %w", err)
	}

	var scanID int64
	if s.dialect == DialectPostgres {
		err = tx.QueryRowContext(ctx, `
			INSERT INTO scans(account_hash, provider, window_days, message_count, scanned_at)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id
		`, req.AccountHash, provider, req.WindowDays, req.MessageCount, scannedAt).Scan(&scanID)
		if err != nil {
			return app.ScanResult{}, fmt.Errorf("insert scan: %w", err)
		}
	} else {
		res, err := tx.ExecContext(ctx, `
			INSERT INTO scans(account_hash, provider, window_days, message_count, scanned_at)
			VALUES (?, ?, ?, ?, ?)
		`, req.AccountHash, provider, req.WindowDays, req.MessageCount, scannedAt)
		if err != nil {
			return app.ScanResult{}, fmt.Errorf("insert scan: %w", err)
		}
		scanID, err = res.LastInsertId()
		if err != nil {
			return app.ScanResult{}, fmt.Errorf("scan id: %w", err)
		}
	}

	insertSubscriptionSQL := s.rebind(`
		INSERT INTO subscriptions(
			scan_id, account_hash, subscription_key, display_name, sender_email, sender_domain, list_id,
			message_count, first_received_at, last_received_at, frequency_label, frequency_per_week,
			unsubscribe_methods_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	stmt, err := tx.PrepareContext(ctx, insertSubscriptionSQL)
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

	subscriptions, err := s.withLatestUnsubscribeAttempts(ctx, req.AccountHash, req.Subscriptions)
	if err != nil {
		return app.ScanResult{}, err
	}

	return app.ScanResult{
		ID:            scanID,
		AccountHash:   req.AccountHash,
		AccountEmail:  accountEmail,
		Provider:      provider,
		WindowDays:    req.WindowDays,
		MessageCount:  req.MessageCount,
		ScannedAt:     scannedAt,
		Subscriptions: subscriptions,
	}, nil
}

func (s *Store) LatestScan(ctx context.Context, accountHash string) (*app.ScanResult, error) {
	var scan app.ScanResult
	err := s.db.QueryRowContext(ctx, s.rebind(`
		SELECT scans.id, scans.account_hash, COALESCE(accounts.email, ''), scans.provider,
			scans.window_days, scans.message_count, scans.scanned_at
		FROM scans
		LEFT JOIN accounts ON accounts.account_hash = scans.account_hash
		WHERE scans.account_hash = ?
		ORDER BY scans.scanned_at DESC, scans.id DESC
		LIMIT 1
	`), accountHash).Scan(
		&scan.ID,
		&scan.AccountHash,
		&scan.AccountEmail,
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

	rows, err := s.db.QueryContext(ctx, s.rebind(`
		SELECT subscription_key, display_name, sender_email, sender_domain, list_id,
			message_count, first_received_at, last_received_at, frequency_label,
			frequency_per_week, unsubscribe_methods_json
		FROM subscriptions
		WHERE scan_id = ?
		ORDER BY message_count DESC, last_received_at DESC
	`), scan.ID)
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

	scan.Subscriptions, err = s.withLatestUnsubscribeAttempts(ctx, scan.AccountHash, scan.Subscriptions)
	if err != nil {
		return nil, err
	}

	return &scan, nil
}

func (s *Store) withLatestUnsubscribeAttempts(ctx context.Context, accountHash string, subscriptions []app.Subscription) ([]app.Subscription, error) {
	if len(subscriptions) == 0 {
		return subscriptions, nil
	}

	rows, err := s.db.QueryContext(ctx, s.rebind(`
		SELECT subscription_key, method_type, target, status, http_status, error_message, attempted_at
		FROM unsubscribe_attempts
		WHERE account_hash = ?
		ORDER BY subscription_key ASC, attempted_at DESC, id DESC
	`), accountHash)
	if err != nil {
		return nil, fmt.Errorf("load unsubscribe attempts: %w", err)
	}
	defer rows.Close()

	attempts := make(map[string]app.UnsubscribeAttempt)
	for rows.Next() {
		var key string
		var attempt app.UnsubscribeAttempt
		if err := rows.Scan(
			&key,
			&attempt.MethodType,
			&attempt.Target,
			&attempt.Status,
			&attempt.HTTPStatus,
			&attempt.Error,
			&attempt.AttemptedAt,
		); err != nil {
			return nil, fmt.Errorf("scan unsubscribe attempt: %w", err)
		}
		if _, exists := attempts[key]; !exists {
			attempts[key] = attempt
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate unsubscribe attempts: %w", err)
	}

	enriched := make([]app.Subscription, len(subscriptions))
	copy(enriched, subscriptions)
	for i := range enriched {
		attempt, ok := attempts[enriched[i].Key]
		if !ok {
			continue
		}
		enriched[i].UnsubscribeAttempt = &attempt
	}
	return enriched, nil
}

func (s *Store) RecordUnsubscribeAttempt(ctx context.Context, in app.UnsubscribeAttemptInput) error {
	if in.AttemptedAt == "" {
		in.AttemptedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := s.db.ExecContext(ctx, s.rebind(`
		INSERT INTO unsubscribe_attempts(
			account_hash, subscription_key, method_type, target, status, http_status, error_message, attempted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`), in.AccountHash, in.SubscriptionKey, in.MethodType, in.Target, in.Status, in.HTTPStatus, in.ErrorMessage, in.AttemptedAt)
	if err != nil {
		return fmt.Errorf("record unsubscribe attempt: %w", err)
	}
	return nil
}

func (s *Store) ListAccounts(ctx context.Context) ([]app.Account, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT email, provider, first_seen_at, last_seen_at
		FROM accounts
		ORDER BY last_seen_at DESC, email ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	defer rows.Close()

	var accounts []app.Account
	for rows.Next() {
		var account app.Account
		if err := rows.Scan(
			&account.Email,
			&account.Provider,
			&account.FirstSeenAt,
			&account.LastSeenAt,
		); err != nil {
			return nil, fmt.Errorf("scan account: %w", err)
		}
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate accounts: %w", err)
	}
	return accounts, nil
}

func (s *Store) rebind(query string) string {
	if s.dialect != DialectPostgres {
		return query
	}

	var out strings.Builder
	arg := 1
	for _, ch := range query {
		if ch == '?' {
			out.WriteByte('$')
			out.WriteString(fmt.Sprint(arg))
			arg++
			continue
		}
		out.WriteRune(ch)
	}
	return out.String()
}
