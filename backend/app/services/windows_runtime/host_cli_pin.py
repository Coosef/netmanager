"""Go host CLI source-projection pin (architecture plan correction #54 + #64).

Schema v2 covers the four files whose contents define the runtime CLI
contract that the installer relies on. CI re-derives the projection in
`host_cli_contract.py` from these source files at the pinned commit
and fails on drift.

The commit is the merge SHA of PR #76 ("feat(agent-host): add native Go
Windows service host MVP-0"). The four files have been verified to
exist at that commit; the integration test
`test_host_cli_contract_pin.py` re-asserts.
"""
from __future__ import annotations

HOST_CLI_CONTRACT_REPOSITORY: str = "Coosef/netmanager"
HOST_CLI_CONTRACT_COMMIT: str = "e9becfe42252ad0f7bdc0ce38c9826f1b73e7437"
HOST_CLI_CONTRACT_FILE: str = "charon-agent-host/internal/cli/subcommands.go"
HOST_CLI_FLAGS_FILE: str = "charon-agent-host/internal/cli/flags.go"
HOST_CONFIG_FILE: str = "charon-agent-host/internal/config/config.go"
HOST_CLI_MANAGER_FILE: str = "charon-agent-host/internal/service/manager_windows.go"
HOST_CLI_CONTRACT_SCHEMA_VERSION: int = 2

HOST_CLI_PIN_FILES: tuple[str, ...] = (
    HOST_CLI_CONTRACT_FILE,
    HOST_CLI_FLAGS_FILE,
    HOST_CONFIG_FILE,
    HOST_CLI_MANAGER_FILE,
)
