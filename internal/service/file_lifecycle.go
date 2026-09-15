package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/storage"
	"github.com/google/uuid"
)

const fileLifecycleDocument = "file_lifecycle/state.json"
const fileOrphanGrace = 24 * time.Hour
const fileReferenceLeaseDuration = 24 * time.Hour
const canvasHistoryReferenceLeaseDuration = 24 * time.Hour

var embeddedStorageContentURL = regexp.MustCompile(`/api/files/([a-zA-Z0-9._~%\-]+)/content(?:[?#\s"'<>)]|$)`)
var embeddedStorageKey = regexp.MustCompile(`(?:^|[\s"'(:,])server:([a-zA-Z0-9._~\-]+)(?:[\s"',})]|$)`)
var embeddedPublicURL = regexp.MustCompile(`https?://[^\s"'<>\\]+`)

// FileReferenceProtector closes the gap between reading references and saving a
// new reference. Claims precede domain writes and share a CAS with deletion.
type FileReferenceProtector interface{ ProtectStorageReferences(any) (func(), error) }

func protectStorageReferences(protector FileReferenceProtector, value any) (func(), error) {
	if protector == nil {
		return func() {}, nil
	}
	return protector.ProtectStorageReferences(value)
}

type fileOrphan struct {
	FirstSeen   time.Time `json:"first_seen"`
	NextAttempt time.Time `json:"next_attempt"`
	Attempts    int       `json:"attempts"`
}
type fileReferenceLease struct {
	ObjectIDs []string  `json:"object_ids"`
	ExpiresAt time.Time `json:"expires_at"`
}
type fileLifecycleState struct {
	Orphans  map[string]fileOrphan         `json:"orphans"`
	Leases   map[string]fileReferenceLease `json:"leases"`
	Deleting map[string]bool               `json:"deleting"`
}

type FileLifecycleService struct {
	mu        sync.Mutex
	sweepMu   sync.Mutex
	store     storage.JSONDocumentBackend
	inventory storage.FileLifecycleBackend
	objects   storage.StorageObjectBackend
	now       func() time.Time
}

func NewFileLifecycleService(backend storage.Backend) (*FileLifecycleService, error) {
	store, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		return nil, errors.New("file lifecycle document backend is required")
	}
	inventory, ok := backend.(storage.FileLifecycleBackend)
	if !ok {
		return nil, errors.New("file lifecycle inventory backend is required")
	}
	objects, ok := backend.(storage.StorageObjectBackend)
	if !ok {
		return nil, errors.New("file lifecycle object backend is required")
	}
	return &FileLifecycleService{store: store, inventory: inventory, objects: objects, now: time.Now}, nil
}

func (s *FileLifecycleService) loadLocked() (fileLifecycleState, error) {
	raw, err := s.store.LoadJSONDocument(fileLifecycleDocument)
	if err != nil {
		return fileLifecycleState{}, err
	}
	result := fileLifecycleState{}
	if raw != nil {
		data, err := json.Marshal(raw)
		if err != nil {
			return result, err
		}
		if err := json.Unmarshal(data, &result); err != nil {
			return result, err
		}
	}
	if result.Orphans == nil {
		result.Orphans = map[string]fileOrphan{}
	}
	if result.Leases == nil {
		result.Leases = map[string]fileReferenceLease{}
	}
	if result.Deleting == nil {
		result.Deleting = map[string]bool{}
	}
	for key, lease := range result.Leases {
		if !s.now().Before(lease.ExpiresAt) {
			delete(result.Leases, key)
		}
	}
	return result, nil
}

func (s *FileLifecycleService) mutate(update func(*fileLifecycleState) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < 8; attempt++ {
		state, err := s.loadLocked()
		if err != nil {
			return err
		}
		if err := update(&state); err != nil {
			return err
		}
		if err := s.store.SaveJSONDocument(fileLifecycleDocument, state); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) {
				continue
			}
			return err
		}
		return nil
	}
	return storage.ErrConcurrentRowUpdate
}

func (s *FileLifecycleService) ProtectStorageReferences(value any) (func(), error) {
	ids, err := s.referenceIDs(context.Background(), value)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return func() {}, nil
	}
	leaseID := uuid.NewString()
	err = s.mutate(func(state *fileLifecycleState) error {
		for _, id := range ids {
			if state.Deleting[id] {
				return fmt.Errorf("%w: storage object is being deleted", ErrStorageObjectInUse)
			}
			object, err := s.objects.LoadStorageObject(id)
			if errors.Is(err, storage.ErrStorageObjectNotFound) {
				continue
			}
			if err != nil {
				return fmt.Errorf("load referenced storage object: %w", err)
			}
			for deletingID := range state.Deleting {
				deleting, err := s.objects.LoadStorageObject(deletingID)
				if errors.Is(err, storage.ErrStorageObjectNotFound) {
					continue
				}
				if err != nil {
					return err
				}
				if sameStoragePhysicalObject(object, deleting) {
					return ErrStorageObjectInUse
				}
			}
		}
		state.Leases[leaseID] = fileReferenceLease{ObjectIDs: ids, ExpiresAt: s.now().Add(fileReferenceLeaseDuration)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = s.mutate(func(state *fileLifecycleState) error { delete(state.Leases, leaseID); return nil })
		})
	}, nil
}

// Reserve rechecks all persisted domains. Concurrent reference claims change
// this document's CAS, forcing another scan before a deletion can be fenced.
func (s *FileLifecycleService) ReserveStorageObjectDeletion(_ string, objectID string) error {
	return s.mutate(func(state *fileLifecycleState) error {
		refs, err := s.references(context.Background())
		if err != nil {
			return err
		}
		addFileLeaseReferences(refs, *state)
		if refs[objectID] {
			return ErrStorageObjectInUse
		}
		object, err := s.objects.LoadStorageObject(objectID)
		if err != nil && !errors.Is(err, storage.ErrStorageObjectNotFound) {
			return err
		}
		if err == nil && !object.Direct {
			for id := range refs {
				other, err := s.objects.LoadStorageObject(id)
				if errors.Is(err, storage.ErrStorageObjectNotFound) {
					continue
				}
				if err != nil {
					return err
				}
				if sameStoragePhysicalObject(object, other) {
					return ErrStorageObjectInUse
				}
			}
		}
		state.Deleting[objectID] = true
		return nil
	})
}
func (s *FileLifecycleService) CompleteStorageObjectDeletion(_ string, objectID string) error {
	return s.mutate(func(state *fileLifecycleState) error { delete(state.Deleting, objectID); return nil })
}

func addFileLeaseReferences(refs map[string]bool, state fileLifecycleState) {
	for _, lease := range state.Leases {
		for _, id := range lease.ObjectIDs {
			refs[id] = true
		}
	}
}

func (s *FileLifecycleService) references(ctx context.Context) (map[string]bool, error) {
	refs := map[string]bool{}
	publicURLs := map[string]bool{}
	visit := func(value any) error {
		ids, err := fileReferenceIDs(value, s.now())
		if err != nil {
			return err
		}
		for _, id := range ids {
			refs[id] = true
		}
		for _, value := range fileReferencePublicURLs(value, s.now()) {
			publicURLs[value] = true
		}
		return nil
	}
	if err := s.inventory.VisitJSONDocuments(ctx, func(name string, value any) error {
		if name == fileLifecycleDocument {
			return nil
		}
		return visit(value)
	}); err != nil {
		return nil, err
	}
	if err := s.inventory.VisitImageConversationDocuments(ctx, visit); err != nil {
		return nil, err
	}
	urls := make([]string, 0, len(publicURLs))
	for value := range publicURLs {
		urls = append(urls, value)
	}
	ids, err := s.inventory.StorageObjectIDsForPublicURLs(ctx, urls)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		refs[id] = true
	}
	return refs, nil
}

func (s *FileLifecycleService) referenceIDs(ctx context.Context, value any) ([]string, error) {
	ids, err := fileReferenceIDs(value, s.now())
	if err != nil {
		return nil, err
	}
	publicIDs, err := s.inventory.StorageObjectIDsForPublicURLs(ctx, fileReferencePublicURLs(value, s.now()))
	if err != nil {
		return nil, err
	}
	return append(ids, publicIDs...), nil
}

func fileReferencePublicURLs(value any, now time.Time) []string {
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var normalized any
	if json.Unmarshal(data, &normalized) != nil {
		return nil
	}
	urls := map[string]bool{}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case string:
			for _, match := range embeddedPublicURL.FindAllString(value, -1) {
				for candidate := match; candidate != ""; candidate = candidate[:len(candidate)-1] {
					parsed, err := url.Parse(candidate)
					if err == nil && parsed.Host != "" {
						parsed.Fragment = ""
						urls[parsed.String()] = true
						parsed.RawQuery = ""
						urls[parsed.String()] = true
					}
					if !strings.ContainsAny(candidate[len(candidate)-1:], "),.;]}") {
						break
					}
				}
			}
		case []any:
			for _, item := range value {
				visit(item)
			}
		case map[string]any:
			for key, item := range value {
				if key == "retained_storage_object_urls" {
					until, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(value["retained_storage_objects_until"]))
					if !now.Before(until) {
						continue
					}
				}
				visit(item)
			}
		}
	}
	visit(normalized)
	result := make([]string, 0, len(urls))
	for value := range urls {
		result = append(result, value)
	}
	return result
}

func fileReferenceIDs(value any, now time.Time) ([]string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	var visit func(any)
	visit = func(candidate any) {
		switch typed := candidate.(type) {
		case string:
			if id := canvasStorageObjectIDFromReference(typed); id != "" {
				ids[id] = true
			}
			for _, pattern := range []*regexp.Regexp{embeddedStorageContentURL, embeddedStorageKey} {
				for _, match := range pattern.FindAllStringSubmatch(typed, -1) {
					id, err := url.PathUnescape(match[1])
					if err == nil && id != "" {
						ids[id] = true
					}
				}
			}
		case []any:
			for _, item := range typed {
				visit(item)
			}
		case map[string]any:
			for key, item := range typed {
				if key == "retained_storage_object_urls" {
					until, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(typed["retained_storage_objects_until"]))
					if !now.Before(until) {
						continue
					}
				}
				if key == "retained_storage_object_ids" {
					until, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(typed["retained_storage_objects_until"]))
					if now.Before(until) {
						if values, ok := item.([]any); ok {
							for _, id := range values {
								if text, ok := id.(string); ok && text != "" {
									ids[text] = true
								}
							}
						}
					}
					continue
				}
				visit(item)
			}
		}
	}
	visit(normalized)
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

// Sweep persists an orphan observation before attempting provider I/O. A full
// day without references is required, and failures retain durable retry state.
func (s *FileLifecycleService) Sweep(ctx context.Context, assets *MyAssetService) error {
	if assets == nil {
		return errors.New("file lifecycle asset coordinator is required")
	}
	if !s.sweepMu.TryLock() {
		return nil
	}
	defer s.sweepMu.Unlock()
	objects := map[string]model.StorageObject{}
	after := ""
	for {
		page, err := s.inventory.ListStorageObjects(ctx, after, 1000)
		if err != nil {
			return err
		}
		for _, object := range page {
			objects[object.ID] = object
			after = object.ID
		}
		if len(page) < 1000 {
			break
		}
	}
	refs, err := s.references(ctx)
	if err != nil {
		return err
	}
	now := s.now()
	var due []string
	err = s.mutate(func(state *fileLifecycleState) error {
		addFileLeaseReferences(refs, *state)
		due = nil
		for id := range state.Orphans {
			if _, exists := objects[id]; !exists || refs[id] {
				delete(state.Orphans, id)
			}
		}
		for id, object := range objects {
			if refs[id] || object.CreatedBy == "" {
				continue
			}
			created, err := time.Parse(time.RFC3339Nano, object.CreatedAt)
			if err != nil {
				continue
			}
			orphan, exists := state.Orphans[id]
			if !exists {
				orphan = fileOrphan{FirstSeen: now, NextAttempt: now.Add(fileOrphanGrace)}
			}
			if now.Before(created.Add(fileOrphanGrace)) && orphan.NextAttempt.Before(created.Add(fileOrphanGrace)) {
				orphan.NextAttempt = created.Add(fileOrphanGrace)
			}
			state.Orphans[id] = orphan
			if !now.Before(orphan.NextAttempt) {
				due = append(due, id)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(due)
	if len(due) > 32 {
		due = due[:32]
	}
	var failures []error
	for _, id := range due {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		object := objects[id]
		var deleteErr error
		if object.Direct {
			deleteErr = assets.DeleteDirectRecord(ctx, object.CreatedBy, id)
		} else {
			deleteErr = assets.DeleteStorageObject(ctx, object.CreatedBy, false, id, nil)
		}
		err := s.mutate(func(state *fileLifecycleState) error {
			if deleteErr == nil || errors.Is(deleteErr, ErrStorageObjectInUse) {
				delete(state.Orphans, id)
				return nil
			}
			orphan := state.Orphans[id]
			orphan.Attempts++
			delay := time.Minute * time.Duration(1<<min(orphan.Attempts, 10))
			orphan.NextAttempt = s.now().Add(delay)
			state.Orphans[id] = orphan
			return nil
		})
		if deleteErr != nil && !errors.Is(deleteErr, ErrStorageObjectInUse) {
			failures = append(failures, deleteErr)
		}
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func sameStoragePhysicalObject(a, b model.StorageObject) bool {
	return a.ObjectKey != "" && a.ProviderID == b.ProviderID && a.Bucket == b.Bucket && a.ObjectKey == b.ObjectKey
}
