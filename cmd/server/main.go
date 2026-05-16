package main

import (
	"log"
	"net/http"
	"os"
	"time"

	httpapi "github.com/niftynei/subbot/internal/http"
	"github.com/niftynei/subbot/internal/store"
)

func main() {
	addr := env("ADDR", ":8080")
	dbPath := env("DATABASE_PATH", "data/subbot.sqlite")
	staticDir := env("STATIC_DIR", "web/dist")

	st, err := store.Open(dbPath)
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

func env(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
