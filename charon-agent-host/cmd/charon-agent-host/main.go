// charon-agent-host — native Windows service host that supervises the
// NetManager proxy agent.
//
// MVP-0 scope: bridge between the SCM and the existing Python agent
// (launched as a managed child process). Later MVPs replace the
// Python child with native Go workers; the SCM-facing surface stays
// stable across those migrations.
package main

import (
	"os"

	"github.com/Coosef/netmanager/charon-agent-host/internal/cli"
)

func main() {
	code := cli.Dispatch(os.Args[1:], os.Stdout, os.Stderr)
	os.Exit(code)
}
