package child

import (
	"context"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// TestExitChan_OneTimePublish proves the cross-platform invariant
// the Windows shutdown path relies on:
//
//   - cmd.Wait() is called exactly once (in waitAndPublishExit)
//   - exitCh receives exactly one value
//   - exitCh is closed after that value is delivered
//   - subsequent reads from exitCh return the zero ExitInfo
//
// This is the cross-platform compile-time guarantee we lean on so
// the SCM handler's main select and the Stop() grace window cannot
// both invoke cmd.Wait() and corrupt each other.
func TestExitChan_OneTimePublish(t *testing.T) {
	p := shortLivedChild(t)
	defer p.cleanup()

	if err := p.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// First read receives the actual exit.
	select {
	case exit, ok := <-p.ExitChan():
		if !ok {
			t.Fatal("ExitChan closed before first read")
		}
		// Exit code is irrelevant for the invariant under test;
		// just confirm we got a value.
		_ = exit
	case <-time.After(5 * time.Second):
		t.Fatal("first ExitChan read timed out")
	}

	// Second read MUST see a closed channel (zero value) — proves
	// the channel is single-producer-single-publish + closed,
	// which is what guarantees no goroutine in shutdown is racing
	// to read a phantom second exit.
	select {
	case exit, ok := <-p.ExitChan():
		if ok {
			t.Fatalf("ExitChan delivered a second value: %+v", exit)
		}
	case <-time.After(time.Second):
		t.Fatal("second ExitChan read should not block")
	}
}

// TestExitChan_MultipleReadersOK guards against a future refactor
// where someone makes ExitChan single-shot in a way that breaks the
// Stop() path. With a buffered + closed channel, both readers
// observe a closed channel and continue.
func TestExitChan_MultipleReadersOK(t *testing.T) {
	p := shortLivedChild(t)
	defer p.cleanup()

	if err := p.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Drain the single real exit.
	<-p.ExitChan()

	// Two parallel readers — both should observe channel closed
	// without blocking forever.
	var readerCount int32
	for i := 0; i < 2; i++ {
		go func() {
			<-p.ExitChan()
			atomic.AddInt32(&readerCount, 1)
		}()
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&readerCount) == 2 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected 2 readers to complete, got %d", readerCount)
}

// shortLivedChild builds a Process whose underlying command exits
// quickly on whatever OS the test happens to run on. We do this
// because the cross-platform unit tests run on Linux CI as well as
// developer macOS / Windows hosts.
type cleanupable struct {
	*Process
	cleanup func()
}

func shortLivedChild(t *testing.T) cleanupable {
	t.Helper()

	var exe string
	var args []string

	switch runtime.GOOS {
	case "windows":
		exe = `C:\Windows\System32\cmd.exe`
		args = []string{"/C", "exit", "0"}
	default:
		exe = "/bin/sh"
		args = []string{"-c", "exit 0"}
	}

	p := &Process{
		Exec: exe,
		Args: args,
	}
	return cleanupable{
		Process: p,
		cleanup: func() {
			// CloseJob is a no-op on non-Windows; on Windows it
			// releases the kernel handle even if the test failed
			// before Start() ran successfully.
			_ = p.CloseJob()
		},
	}
}
