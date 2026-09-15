package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"chatgpt2api/internal/httpapi"
)

const (
	httpReadHeaderTimeout = 15 * time.Second
	httpReadTimeout       = 3 * time.Minute
	httpIdleTimeout       = 2 * time.Minute
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	app, err := httpapi.NewApp()
	if err != nil {
		return fmt.Errorf("init app: %w", err)
	}
	defer app.Close()

	logger := app.Logger()
	addr := configuredListenAddress()
	server := newHTTPServer(addr, app.Handler())
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	if os.Getenv("DESKTOP_RUNTIME") == "1" {
		go waitForDesktopParent(os.Stdin, stop)
	}

	logger.Info("starting server", "addr", addr)
	stoppedBySignal, err := waitForServerEvent(server, stop)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("listen failed: %w", err)
	}
	if !stoppedBySignal {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("server shutdown failed", "error", err)
	}
	return nil
}

func configuredListenAddress() string {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	return net.JoinHostPort(os.Getenv("LISTEN_HOST"), port)
}

// The desktop parent owns stdin; EOF initiates the same graceful shutdown as a signal.
func waitForDesktopParent(input io.Reader, stop chan<- os.Signal) {
	_, _ = io.Copy(io.Discard, input)
	select {
	case stop <- os.Interrupt:
	default:
	}
}

func waitForServerEvent(server *http.Server, stop <-chan os.Signal) (bool, error) {
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.ListenAndServe()
	}()
	select {
	case err := <-serveErr:
		return false, err
	case <-stop:
		return true, nil
	}
}

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: httpReadHeaderTimeout,
		ReadTimeout:       httpReadTimeout,
		IdleTimeout:       httpIdleTimeout,
	}
}
