// Package child manages the Python (or future Go-native) worker the
// host launches as its child process.
//
// Responsibilities split:
//   - process.go     — exec.Cmd setup, stdout/stderr capture (cross-platform)
//   - monitor.go     — restart backoff policy (pure logic, unit-testable)
//   - job_*.go       — Job Object handle (Windows-only)
//   - shutdown_*.go  — cooperative + force termination (Windows-only)
//
// SCM vs host crash-recovery responsibility split:
//   - SCM:    recovers host crashes via service Recovery Actions
//     (restart 10s/30s/60s — set at install time)
//   - host:   recovers child crashes via the backoff schedule below
//
// These are non-overlapping by construction; a host crash kills the
// child via Job Object KILL_ON_JOB_CLOSE, then SCM relaunches the host
// which performs an initial child start (no backoff because counters
// are in-memory).
package child

import (
	"math/rand"
	"time"
)

// RestartPolicy describes when the host should give up on a flapping
// child versus keep trying. The defaults match the user-approved spec:
// 1s → 5s → 15s → 30s → 60s → 60s ..., reset after 60s of healthy run.
type RestartPolicy struct {
	// Schedule lists the delay before each restart attempt. After all
	// scheduled entries are exhausted, the LAST entry is reused
	// indefinitely.
	Schedule []time.Duration

	// JitterFraction is the fraction of the scheduled delay that is
	// randomly added (e.g. 0.2 means up to +20%). Prevents synchronized
	// reconnect storms when the backend is the failing component.
	JitterFraction float64

	// HealthyRunDuration is the minimum uptime after which a child
	// process is considered "healthy" — at that point the attempt
	// counter resets so the next crash starts over at Schedule[0].
	HealthyRunDuration time.Duration
}

// DefaultRestartPolicy returns the MVP-0 spec backoff.
func DefaultRestartPolicy() RestartPolicy {
	return RestartPolicy{
		Schedule: []time.Duration{
			1 * time.Second,
			5 * time.Second,
			15 * time.Second,
			30 * time.Second,
			60 * time.Second,
		},
		JitterFraction:     0.2,
		HealthyRunDuration: 60 * time.Second,
	}
}

// BackoffState is the in-memory counter the monitor loop updates after
// each child exit. The zero value is ready to use.
type BackoffState struct {
	attempt int
}

// NextDelay returns the wait time before the next restart attempt
// given the child's most recent run duration.
//
// If the child ran longer than policy.HealthyRunDuration, the attempt
// counter resets to 0 (so a transient blip after weeks of uptime
// doesn't trigger the slow end of the schedule).
//
// The returned delay includes jitter (deterministically derived from
// rng so callers can pass a seeded *rand.Rand in tests; nil means use
// the default global source).
func (s *BackoffState) NextDelay(p RestartPolicy, lastRunDuration time.Duration, rng *rand.Rand) time.Duration {
	if lastRunDuration >= p.HealthyRunDuration {
		s.attempt = 0
	}
	idx := s.attempt
	if idx >= len(p.Schedule) {
		idx = len(p.Schedule) - 1
	}
	base := p.Schedule[idx]
	s.attempt++

	if p.JitterFraction <= 0 {
		return base
	}
	maxJitter := time.Duration(float64(base) * p.JitterFraction)
	if maxJitter <= 0 {
		return base
	}
	var n int64
	if rng != nil {
		n = rng.Int63n(int64(maxJitter))
	} else {
		n = rand.Int63n(int64(maxJitter))
	}
	return base + time.Duration(n)
}

// Reset zeros the attempt counter. Called after a successful clean
// shutdown (so a future re-start from SCM begins fresh).
func (s *BackoffState) Reset() {
	s.attempt = 0
}

// Attempt returns the current attempt index (0-based). Exposed for
// logging.
func (s *BackoffState) Attempt() int {
	return s.attempt
}
