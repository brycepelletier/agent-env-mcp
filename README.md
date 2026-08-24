# @brycepelletier/agent-env-mcp

Reusable host-side MCP controller for a hardened Linux software-engineering
runtime.

## 0.4.0 trust boundary

`agent-env-mcp` is software-engineering only. Its single `agent` service can
inspect, edit, build, test, lint, and debug the active workspace. The real
`.git` directory is physically masked by a root-owned tmpfs mount, and the
container receives no GitHub credentials or Docker socket.

```text
Software Engineer
       |
agent-env-mcp
       |
Linux engineering runtime
       |-- source tree visible
       |-- .git masked
       |-- no GitHub credentials
       `-- no Docker socket

GitHub Operator
       |
github-app-mcp
       `-- all Git and GitHub operations
```

Version 0.4.0 removes the former `git` service and public `git_command`. That is
an intentional breaking change: all local and remote Git operations belong to
`@brycepelletier/github-app-mcp` and the GitHub Operator trust domain.

## Tools

- `ensure_environment`
- `list_directory`
- `read_file`
- `search_workspace`
- `workspace_edit`
- `run_command`

Recursive workspace listing and search omit `.git`, `.ssh`, and `.gnupg`
directory nodes and their descendants at every depth. Direct read or edit
requests containing those path segments are rejected before filesystem access.
The `.git` mount remains physically masked from programs launched through
`run_command`; programs that deliberately access it may receive a permission
error without gaining repository metadata.

The MCP discovers the active VS Code workspace lazily through MCP Roots,
requires exactly one local `file:` root, and does not accept a model-supplied
host workspace path.

## Host prerequisites

- Node.js 20.10 or newer
- Docker with Linux-container support
- Exactly one local VS Code workspace root

## Docker behavior and lifecycle

The trusted host facade starts one deterministic Docker Compose project for the
active workspace. The only runtime service is `agent`; it runs as the unprivileged
`vscode` user with all Linux capabilities dropped and `no-new-privileges` set.
The workspace is bind-mounted, while its `.git` directory is over-mounted with
an inaccessible tmpfs. No Docker socket or credential path is mounted.

MCP stdin EOF/close, SIGINT, SIGTERM, SIGHUP, or a fatal process error starts an
idempotent shutdown. Shutdown waits for in-flight preparation, runs
`docker compose down --remove-orphans`, closes the MCP server, and exits. The
15-minute idle timeout is a secondary cleanup path. New calls fail once shutdown
begins.

## Local development and validation

From Git Bash:

```bash
npm run link
npm test
npm run validate
npm run unlink
```

`npm run validate` performs syntax checks, policy and lifecycle tests, and an
npm package dry run. Docker Compose rendering and image builds are separate host
integration checks because they require a running Docker daemon.

## VS Code configuration

Published-package configuration:

```json
{
  "servers": {
    "agent-env": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@brycepelletier/agent-env-mcp@0.4.1"]
    }
  }
}
```

While locally linked, replace `npx` and its arguments with:

```json
"command": "agent-env-mcp"
```

## Acceptance checks

Before relying on the boundary:

1. `ensure_environment` reports the expected project workspace.
2. `run_command` can build and test the project.
3. Direct `git` is rejected by policy.
4. Invoking the real Git binary indirectly through Python or Node reports that
   the workspace is not a Git repository because `.git` is physically hidden.
5. `.git`, `.ssh`, and `.gnupg` paths are inaccessible through workspace tools.
6. No GitHub credential variables, PEM, or Docker socket are visible.
7. The MCP tool inventory contains no `git_command` or GitHub API tools.
8. Closing the MCP connection removes its Compose containers.

The `.git` masking assumes a standard checkout where `.git` is a directory.
Git worktrees and submodules that use a `.git` file must be rejected or handled
by a future mount strategy before treating those repository forms as hardened.

## License

MIT. See `LICENSE`.
