package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	httpapi "github.com/niftynei/subbot/internal/http"
	"github.com/niftynei/subbot/internal/store"
)

func main() {
	addr := serverAddr()
	dbPath := env("DATABASE_PATH", "data/subbot.sqlite")
	databaseURL := os.Getenv("DATABASE_URL")
	staticDir := env("STATIC_DIR", "web/dist")

	st, err := openStore(databaseURL, dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(st, staticDir),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("subbot listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server failed: %v", err)
	}
}

func openStore(databaseURL, dbPath string) (*store.Store, error) {
	if databaseURL != "" {
		return store.OpenPostgres(databaseURL)
	}
	return store.Open(dbPath)
}

func serverAddr() string {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if strings.HasPrefix(port, ":") {
		return port
	}
	return ":" + port
}

func env(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
