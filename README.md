# agent-env-mcp

A host-side MCP controller that owns a reusable Linux development runtime and exposes a narrow, project-scoped workspace/tool boundary to coding agents.

## Trust boundary

- The MCP process runs on the host because it must control Docker.
- The model is never given a host filesystem tool or arbitrary host command tool.
- VS Code passes the currently-open workspace once at MCP startup through `AGENT_HOST_WORKSPACE`.
- That workspace is bind-mounted into an agent-owned runtime at `/agent-env/environment/<project-slug>`.
- File reads, searches, edits, local Git, builds, tests, and other command execution happen inside the Linux `agent` container.
- The runtime has no Docker socket and no GitHub credential mount.
- Compose and Dockerfile are owned by this repository, not by the application repository.

## Exposed tools

- `ensure_environment`
- `list_directory`
- `read_file`
- `search_workspace`
- `workspace_edit`
- `run_command`
- `git_command`

`run_command` uses structured `program` + `args` execution with no shell and refuses direct Git. `git_command` is intended for the GitHub Operator, disables repository hooks/signing, and permits only a local Git subcommand allowlist; network Git operations are intentionally excluded.

## Install

```powershell
cd D:\mcp\agent-env-mcp
npm install
```

Add the server to VS Code user MCP configuration using `mcp.json.example`.

The important setting is:

```json
"env": {
  "AGENT_HOST_WORKSPACE": "${workspaceFolder}"
}
```

The model cannot select a different host workspace after the MCP server starts.

## Verification

After restarting the MCP server:

1. `ensure_environment`
2. `list_directory` with `path: "."`
3. `read_file` on a known project file
4. `search_workspace` for a known symbol/text
5. `run_command` with `program: "pwd"`
6. `git_command` with `args: ["status", "--short"]`

Expected boundary failures:

- `read_file("../../anything")`
- an absolute path
- a Windows path
- direct `.git` reads
- `run_command` with `bash`
- `run_command` with `docker`
- `run_command` with `git`

## Migration

After the new runtime is proven:

1. Remove the project-owned `.devcontainer`.
2. Remove generic VS Code `execute`, `read`, `edit`, and `search` from Software Engineer.
3. For a strict container-only read boundary, also remove VS Code C/C++ semantic tools that inspect source outside `agent-env`.
4. Give GitHub Operator `agent-env/git_command` for local Git.
5. Keep remote GitHub operations in the GitHub MCP.

## Runtime baseline

The included Dockerfile uses Node 24 LTS, C/C++ build tools, Python, PlatformIO 6.1.19, Git, and ripgrep. Runtime profiles can be split out later without changing the trust model.
