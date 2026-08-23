# @brycepelletier/agent-env-mcp

Reusable, host-side MCP controller for a hardened Linux software-engineering runtime.

## 0.3.1 trust split

The Compose runtime has two execution domains over the same working tree:

- `agent`: used by Software Engineer tools. The real `.git` directory is masked with a root-owned tmpfs mount.
- `git`: used only by `git_command`. It sees the real `.git` directory and has `network_mode: none`.

Remote Git/GitHub operations do not belong in this package; they are intended for the separate GitHub MCP trust domain.

## Tools

- `ensure_environment`
- `list_directory`
- `read_file`
- `search_workspace`
- `workspace_edit`
- `run_command`
- `git_command`

The MCP discovers the active VS Code workspace lazily through MCP Roots when a tool is first used. No `${workspaceFolder}` launch-time variable is required.

## Local development

```bash
npm run link
```

User-level VS Code MCP configuration while linked:

```json
"agent-env": {
  "type": "stdio",
  "command": "agent-env-mcp"
}
```

To remove the global development link:

```bash
npm run unlink
```

## Lifecycle

The host-side facade owns one deterministic Docker Compose project for the active
workspace. An MCP stdin EOF/close, SIGINT, SIGTERM, SIGHUP, or fatal process
error starts one idempotent shutdown sequence. Shutdown waits for any in-flight
environment preparation to settle, forces `docker compose down --remove-orphans`
for the owned project even after a partial startup, closes the MCP server, and
then exits. VS Code does not need to send a particular signal for containers to
be released.

The existing 15-minute idle timeout remains a secondary cleanup path. New tool
calls fail once shutdown begins.

## Testing and validation

Run the policy and lifecycle tests:

```bash
npm test
```

Run syntax checks, the test suite, and an npm package dry run together:

```bash
npm run validate
```

The tests cover protected workspace paths, child-environment credential
filtering, blocked executable classes, local-only Git restrictions, hardened Git
configuration, single-flight shutdown, partial-startup cleanup, and teardown
failure handling. Docker Compose rendering and image builds remain separate host
integration checks because they require a running Docker daemon.

## 0.3.1 acceptance checks

Before removing a project's old `.devcontainer`:

1. `ensure_environment` succeeds and reports `/agent-env/environment/<project>`.
2. `run_command` can build the project.
3. `run_command` cannot obtain the real Git branch/history even if it invokes Git indirectly through Python/Node.
4. `git_command ["status", "--short", "--branch"]` succeeds.
5. The Git service has no network access.

The current `.git` masking implementation assumes a standard checkout where `.git` is a directory. Git worktrees/submodules that use a `.git` file should be rejected or handled by a future mount strategy before treating this runtime as hardened for those repository forms.
