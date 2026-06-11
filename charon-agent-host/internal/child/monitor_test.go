package child

import (
	"math/rand"
	"testing"
	"time"
)

func TestBackoff_FollowsSchedule(t *testing.T) {
	p := RestartPolicy{
		Schedule:           []time.Duration{1 * time.Second, 5 * time.Second, 15 * time.Second},
		JitterFraction:     0, // deterministic
		HealthyRunDuration: 60 * time.Second,
	}
	var s BackoffState
	rng := rand.New(rand.NewSource(1))

	want := []time.Duration{1 * time.Second, 5 * time.Second, 15 * time.Second}
	for i, w := range want {
		got := s.NextDelay(p, 100*time.Millisecond, rng)
		if got != w {
			t.Errorf("attempt %d: got %v want %v", i, got, w)
		}
	}
}

func TestBackoff_CapsAtLastEntry(t *testing.T) {
	p := RestartPolicy{
		Schedule:           []time.Duration{1 * time.Second, 5 * time.Second, 15 * time.Second},
		JitterFraction:     0,
		HealthyRunDuration: 60 * time.Second,
	}
	var s BackoffState
	rng := rand.New(rand.NewSource(1))

	// burn through scheduled entries
	for i := 0; i < 3; i++ {
		s.NextDelay(p, 100*time.Millisecond, rng)
	}
	// next 10 should all cap at 15s
	for i := 0; i < 10; i++ {
		got := s.NextDelay(p, 100*time.Millisecond, rng)
		if got != 15*time.Second {
			t.Errorf("post-cap attempt %d: got %v, want 15s", i, got)
		}
	}
}

func TestBackoff_ResetsAfterHealthyRun(t *testing.T) {
	p := RestartPolicy{
		Schedule:           []time.Duration{1 * time.Second, 5 * time.Second, 15 * time.Second},
		JitterFraction:     0,
		HealthyRunDuration: 60 * time.Second,
	}
	var s BackoffState
	rng := rand.New(rand.NewSource(1))

	// advance to attempt 2
	s.NextDelay(p, 100*time.Millisecond, rng)
	s.NextDelay(p, 100*time.Millisecond, rng)

	// child ran healthy for 90s — next call should reset to Schedule[0]
	got := s.NextDelay(p, 90*time.Second, rng)
	if got != 1*time.Second {
		t.Errorf("after healthy run: got %v, want 1s (reset)", got)
	}
}

func TestBackoff_JitterStaysWithinBounds(t *testing.T) {
	p := RestartPolicy{
		Schedule:           []time.Duration{1 * time.Second},
		JitterFraction:     0.2,
		HealthyRunDuration: 60 * time.Second,
	}
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 1000; i++ {
		var s BackoffState
		got := s.NextDelay(p, 100*time.Millisecond, rng)
		if got < 1*time.Second || got > 1200*time.Millisecond {
			t.Fatalf("jitter out of bounds: %v", got)
		}
	}
}

func TestBackoff_AttemptCounterExposed(t *testing.T) {
	p := DefaultRestartPolicy()
	var s BackoffState
	if s.Attempt() != 0 {
		t.Errorf("initial attempt should be 0, got %d", s.Attempt())
	}
	s.NextDelay(p, 100*time.Millisecond, nil)
	if s.Attempt() != 1 {
		t.Errorf("after one NextDelay: got %d, want 1", s.Attempt())
	}
	s.Reset()
	if s.Attempt() != 0 {
		t.Errorf("after Reset: got %d, want 0", s.Attempt())
	}
}

func TestDefaultRestartPolicy_MatchesSpec(t *testing.T) {
	p := DefaultRestartPolicy()
	want := []time.Duration{
		1 * time.Second,
		5 * time.Second,
		15 * time.Second,
		30 * time.Second,
		60 * time.Second,
	}
	if len(p.Schedule) != len(want) {
		t.Fatalf("schedule len: got %d, want %d", len(p.Schedule), len(want))
	}
	for i, w := range want {
		if p.Schedule[i] != w {
			t.Errorf("schedule[%d]: got %v, want %v", i, p.Schedule[i], w)
		}
	}
	if p.HealthyRunDuration != 60*time.Second {
		t.Errorf("healthy run duration: got %v, want 60s", p.HealthyRunDuration)
	}
}
