package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (a *App) startGeneratedMediaCleaner(ctx context.Context, interval time.Duration) {
	if a == nil || a.config == nil {
		return
	}
	if interval <= 0 {
		interval = time.Hour
	}
	run := func() {
		deleted, err := a.cleanupGeneratedMedia(time.Now())
		if err != nil && ctx.Err() == nil && a.logger != nil {
			a.logger.Warning("scheduled generated media cleanup failed", "error", err)
		}
		if deleted > 0 && a.logger != nil {
			a.logger.Info("scheduled generated media cleanup completed", "deleted", deleted)
		}
	}
	a.backgroundWorkers.Add(1)
	go func() {
		defer a.backgroundWorkers.Done()
		run()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}

func (a *App) cleanupGeneratedMedia(now time.Time) (int, error) {
	retentionDays := a.config.ImageRetentionDays()
	if retentionDays < 1 {
		retentionDays = 1
	} else if retentionDays > 3650 {
		retentionDays = 3650
	}
	mediaCutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)
	referenceCutoff := now.Add(-referenceURLTTL)
	deleted := 0
	var cleanupErrors []error
	for _, target := range []struct {
		root   string
		cutoff time.Time
	}{
		{root: a.videoDir, cutoff: mediaCutoff},
		{root: a.audioDir, cutoff: mediaCutoff},
		{root: a.videoReferenceDir, cutoff: referenceCutoff},
	} {
		count, err := cleanupMediaDirectory(target.root, target.cutoff)
		deleted += count
		if err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return deleted, errors.Join(cleanupErrors...)
}

func cleanupMediaDirectory(root string, cutoff time.Time) (int, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, fmt.Errorf("read generated media directory %q: %w", root, err)
	}
	deleted := 0
	var cleanupErrors []error
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("inspect generated media %q: %w", entry.Name(), err))
			continue
		}
		if !info.Mode().IsRegular() || !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(root, entry.Name())); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("remove generated media %q: %w", entry.Name(), err))
			continue
		}
		deleted++
	}
	return deleted, errors.Join(cleanupErrors...)
}
