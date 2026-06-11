package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotatingWriter_BasicWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	w := NewRotatingWriter(dir, "test", ".log")
	defer w.Close()

	msg := []byte("hello world\n")
	n, err := w.Write(msg)
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if n != len(msg) {
		t.Fatalf("short write: %d / %d", n, len(msg))
	}

	got, err := os.ReadFile(filepath.Join(dir, "test.log"))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "hello world\n" {
		t.Fatalf("content mismatch: %q", got)
	}
}

func TestRotatingWriter_RotatesAtMaxSize(t *testing.T) {
	dir := t.TempDir()
	w := NewRotatingWriter(dir, "rot", ".log")
	w.MaxSize = 32 // tiny for fast test
	w.MaxFiles = 3
	defer w.Close()

	// Write 5 lines of 16 bytes each → 80 bytes total → 2 rotations.
	for i := 0; i < 5; i++ {
		line := strings.Repeat("x", 15) + "\n"
		if _, err := w.Write([]byte(line)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	// Active log should be present and small (current run remainder).
	active, err := os.ReadFile(filepath.Join(dir, "rot.log"))
	if err != nil {
		t.Fatalf("active read: %v", err)
	}
	if len(active) > int(w.MaxSize) {
		t.Errorf("active log exceeded MaxSize: %d > %d", len(active), w.MaxSize)
	}

	// At least one backup should exist.
	backup1 := filepath.Join(dir, "rot.1.log")
	if _, err := os.Stat(backup1); err != nil {
		t.Fatalf("expected backup .1.log: %v", err)
	}
}

func TestRotatingWriter_DropsOldestBackup(t *testing.T) {
	dir := t.TempDir()
	w := NewRotatingWriter(dir, "drop", ".log")
	w.MaxSize = 16
	w.MaxFiles = 2
	defer w.Close()

	// Force many rotations.
	for i := 0; i < 10; i++ {
		w.Write([]byte("0123456789ABCDEF\n"))
	}

	// .3.log must NOT exist (MaxFiles = 2)
	if _, err := os.Stat(filepath.Join(dir, "drop.3.log")); err == nil {
		t.Errorf("drop.3.log should have been pruned (MaxFiles=2)")
	}
	// .1 and .2 should exist.
	for _, n := range []string{"drop.1.log", "drop.2.log"} {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("expected %s: %v", n, err)
		}
	}
}

func TestRotatingWriter_CloseIdempotent(t *testing.T) {
	dir := t.TempDir()
	w := NewRotatingWriter(dir, "close", ".log")
	w.Write([]byte("x"))
	if err := w.Close(); err != nil {
		t.Fatalf("close 1: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close 2: %v", err)
	}
}

func TestRotatingWriter_LazyOpen(t *testing.T) {
	// Constructor must not create files until first write — important
	// for `version` subcommand which never logs.
	dir := t.TempDir()
	_ = NewRotatingWriter(dir, "lazy", ".log")
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("expected empty dir, got %d entries", len(entries))
	}
}
