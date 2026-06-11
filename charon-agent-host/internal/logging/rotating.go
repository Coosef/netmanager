// Package logging provides the host's structured log writer + Windows
// Event Log integration.
//
// The rotating writer is pure cross-platform Go and unit-testable on
// any OS; the Event Log adapter is Windows-only behind a build tag and
// stubbed elsewhere so the host always compiles for hermetic CI.
package logging

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// RotatingWriter implements io.WriteCloser with size-based rotation.
//
// Rotation policy (MVP-0):
//   - Single active file: <dir>/<baseName>.<ext>
//   - Backup files numbered .1.<ext> .. .<MaxFiles>.<ext>
//   - When the active file exceeds MaxSize, .N.<ext> is dropped (or
//     deleted if N == MaxFiles), .(N-1).<ext> → .N.<ext>, ...,
//     <baseName>.<ext> → <baseName>.1.<ext>, and a fresh file is opened.
//
// This is deliberately simpler than lumberjack — we want zero external
// dependencies and the host's log volume is modest (a few MB/day).
type RotatingWriter struct {
	Dir      string
	BaseName string // e.g. "service-host"
	Ext      string // e.g. ".log"
	MaxSize  int64  // bytes per file (default 10 MiB)
	MaxFiles int    // backup file count (default 5)

	mu      sync.Mutex
	current *os.File
	curSize int64
}

const (
	defaultMaxSize  int64 = 10 * 1024 * 1024
	defaultMaxFiles int   = 5
)

// NewRotatingWriter returns a writer ready for use. The active file is
// opened lazily on the first Write so a fresh, empty install can boot
// without touching the disk.
func NewRotatingWriter(dir, baseName, ext string) *RotatingWriter {
	return &RotatingWriter{
		Dir:      dir,
		BaseName: baseName,
		Ext:      ext,
		MaxSize:  defaultMaxSize,
		MaxFiles: defaultMaxFiles,
	}
}

func (w *RotatingWriter) activePath() string {
	return filepath.Join(w.Dir, w.BaseName+w.Ext)
}

func (w *RotatingWriter) backupPath(n int) string {
	return filepath.Join(w.Dir, fmt.Sprintf("%s.%d%s", w.BaseName, n, w.Ext))
}

func (w *RotatingWriter) open() error {
	if w.MaxSize <= 0 {
		w.MaxSize = defaultMaxSize
	}
	if w.MaxFiles <= 0 {
		w.MaxFiles = defaultMaxFiles
	}
	if err := os.MkdirAll(w.Dir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(w.activePath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	w.current = f
	w.curSize = fi.Size()
	return nil
}

func (w *RotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.current == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if w.curSize+int64(len(p)) > w.MaxSize {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.current.Write(p)
	w.curSize += int64(n)
	return n, err
}

// rotate cycles the backup files and opens a fresh active file. Caller
// must hold w.mu.
func (w *RotatingWriter) rotate() error {
	if w.current != nil {
		_ = w.current.Close()
		w.current = nil
	}

	// Drop the oldest backup. Ignored if it doesn't exist.
	_ = os.Remove(w.backupPath(w.MaxFiles))

	// Shift .N → .(N+1), descending so we never overwrite.
	for i := w.MaxFiles - 1; i >= 1; i-- {
		_ = os.Rename(w.backupPath(i), w.backupPath(i+1))
	}

	// Active → .1
	_ = os.Rename(w.activePath(), w.backupPath(1))

	return w.open()
}

// Close flushes and closes the active file. Safe to call multiple times.
func (w *RotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.current == nil {
		return nil
	}
	err := w.current.Close()
	w.current = nil
	return err
}

// Ensure RotatingWriter satisfies io.WriteCloser at compile time.
var _ io.WriteCloser = (*RotatingWriter)(nil)
