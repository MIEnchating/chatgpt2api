package service

import (
	"context"
	"testing"
	"time"
)

func TestImageTaskServiceLargeCreationRequestIsNotStarvedBySmallOnes(t *testing.T) {
	svc := newTestImageTaskService(t, nil, nil, nil, func() int { return 30 })
	t.Cleanup(func() { _ = svc.Close() })
	admin := Identity{ID: "admin", Name: "Admin", Role: AuthRoleAdmin}
	releases := make([]func(), 0, defaultGlobalImageTaskConcurrentUnits)
	for index := 0; index < defaultGlobalImageTaskConcurrentUnits; index++ {
		release, err := svc.AcquireCreationUnit(context.Background(), admin)
		if err != nil {
			t.Fatalf("AcquireCreationUnit(%d) error = %v", index, err)
		}
		releases = append(releases, release)
	}

	type acquireResult struct {
		release func()
		err     error
	}
	large := make(chan acquireResult, 1)
	small := make(chan acquireResult, 1)
	go func() {
		release, err := svc.AcquireCreationUnits(context.Background(), Identity{ID: "admin-large", Role: AuthRoleAdmin}, 5)
		large <- acquireResult{release: release, err: err}
	}()
	// Let the large request enqueue and record that it is blocked on the global budget.
	time.Sleep(150 * time.Millisecond)
	go func() {
		release, err := svc.AcquireCreationUnits(context.Background(), Identity{ID: "admin-small", Role: AuthRoleAdmin}, 1)
		small <- acquireResult{release: release, err: err}
	}()
	time.Sleep(150 * time.Millisecond)

	// One free unit would fit the small request, but the large request queued first must not be overtaken.
	releases[0]()
	select {
	case acquired := <-small:
		if acquired.release != nil {
			acquired.release()
		}
		t.Fatal("a small request overtook the queued large request")
	case <-time.After(200 * time.Millisecond):
	}

	for _, release := range releases[1:5] {
		release()
	}
	var largeRelease func()
	select {
	case acquired := <-large:
		if acquired.err != nil {
			t.Fatalf("large acquire error = %v", acquired.err)
		}
		largeRelease = acquired.release
	case <-time.After(2 * time.Second):
		t.Fatal("large request did not start after enough units were released")
	}
	// The large request now holds 5 units and the budget is full again, so free them for the small request.
	largeRelease()
	select {
	case acquired := <-small:
		if acquired.err != nil {
			t.Fatalf("small acquire error = %v", acquired.err)
		}
		acquired.release()
	case <-time.After(2 * time.Second):
		t.Fatal("small request did not start after the large request was served")
	}
	for _, release := range releases[5:] {
		release()
	}
}
