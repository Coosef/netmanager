# charon-agent-host — Build orchestration
#
# Cross-compile for Windows from Linux/macOS CI. CGO disabled (pure Go,
# no Windows SDK dependency). UPX intentionally NOT used (EDR/SmartScreen
# false-positive risk).

VERSION  ?= v2.0.0-mvp0
BUILD    ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILDDATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS = -s -w \
          -X 'github.com/Coosef/netmanager/charon-agent-host/internal/version.Version=$(VERSION)' \
          -X 'github.com/Coosef/netmanager/charon-agent-host/internal/version.Build=$(BUILD)' \
          -X 'github.com/Coosef/netmanager/charon-agent-host/internal/version.BuildDate=$(BUILDDATE)'

OUT_DIR = bin
BIN_NAME = charon-agent-host
WIN_AMD64 = $(OUT_DIR)/$(BIN_NAME)-windows-amd64.exe


.PHONY: all
all: build-windows-amd64


.PHONY: build-windows-amd64
build-windows-amd64:
	mkdir -p $(OUT_DIR)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
	  go build -trimpath -ldflags "$(LDFLAGS)" -o $(WIN_AMD64) ./cmd/charon-agent-host
	@echo "Built: $(WIN_AMD64)"
	@sha256sum $(WIN_AMD64) 2>/dev/null || shasum -a 256 $(WIN_AMD64)


.PHONY: test
test:
	go test ./internal/... ./cmd/...


.PHONY: test-integration
# Windows-only; run on a Windows-2022 GitHub Actions runner.
test-integration:
	go test -tags=integration ./test/integration/...


.PHONY: vet
vet:
	go vet ./...


.PHONY: fmt
fmt:
	gofmt -w -s .


.PHONY: clean
clean:
	rm -rf $(OUT_DIR)


.PHONY: release-hash
release-hash: build-windows-amd64
	@cd $(OUT_DIR) && shasum -a 256 $(BIN_NAME)-windows-amd64.exe > $(BIN_NAME)-windows-amd64.exe.sha256
	@cat $(OUT_DIR)/$(BIN_NAME)-windows-amd64.exe.sha256
