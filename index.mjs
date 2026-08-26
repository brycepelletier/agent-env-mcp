#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "./package.json" with { type: "json" };
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createShutdownCoordinator } from "./runtime/lifecycle.mjs";

const VERSION = packageJson.version;
const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(SERVER_ROOT, "runtime");
const COMPOSE_FILE = path.join(RUNTIME_DIR, "compose.yaml");

const AGENT_SERVICE = "agent";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONTROLLER_OUTPUT_BYTES = 1024 * 1024;

const server = new Server(
  { name: "agent-env", version: VERSION },
  { capabilities: { tools: {} } }
);

let runtime = null;
let lastActivity = Date.now();
let activeCommands = 0;
let environmentStarted = false;
let shuttingDown = false;
let preparePromise = null;

function projectSlugFromWorkspace(workspace) {
  const raw = path.basename(workspace);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 48);

  if (!slug) {
    throw new Error("Could not derive a safe project slug from the workspace.");
  }

  return slug;
}

function comparableHostPath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function createRuntime(hostWorkspace) {
  const projectSlug = projectSlugFromWorkspace(hostWorkspace);
  const workspaceHash = createHash("sha256")
    .update(comparableHostPath(hostWorkspace))
    .digest("hex")
    .slice(0, 8);

  return {
    hostWorkspace,
    projectSlug,
    containerWorkspace: `/agent-env/environment/${projectSlug}`,
    composeProject: `agent-env-${projectSlug}-${workspaceHash}`,
  };
}

function sameRuntime(a, b) {
  return Boolean(
    a &&
      b &&
      comparableHostPath(a.hostWorkspace) === comparableHostPath(b.hostWorkspace)
  );
}

async function discoverWorkspaceRoot() {
  let result;

  try {
    result = await server.listRoots();
  } catch (error) {
    throw new Error(
      "VS Code did not provide an MCP workspace root. Open exactly one local project folder and retry.",
      { cause: error }
    );
  }

  const roots = result?.roots ?? [];

  if (roots.length === 0) {
    throw new Error(
      "No workspace folder is open. Open a project folder before using agent-env."
    );
  }

  if (roots.length !== 1) {
    throw new Error(
      `agent-env currently requires exactly one workspace root; received ${roots.length}.`
    );
  }

  let rootUrl;
  try {
    rootUrl = new URL(roots[0].uri);
  } catch (error) {
    throw new Error("VS Code returned an invalid workspace-root URI.", {
      cause: error,
    });
  }

  if (rootUrl.protocol !== "file:") {
    throw new Error(
      `Unsupported workspace-root protocol '${rootUrl.protocol}'. agent-env currently supports local file workspaces only.`
    );
  }

  const hostPath = fileURLToPath(rootUrl);
  const resolved = fs.realpathSync.native(path.resolve(hostPath));
  const stat = fs.statSync(resolved);

  if (!stat.isDirectory()) {
    throw new Error("The VS Code workspace root is not a directory.");
  }

  const parsed = path.parse(resolved);
  if (path.normalize(resolved) === path.normalize(parsed.root)) {
    throw new Error(
      "Refusing to mount an entire filesystem root as the agent workspace."
    );
  }

  return resolved;
}

function sanitizeControllerText(value, selectedRuntime = runtime) {
  if (!value) return "";

  let result = String(value).split(SERVER_ROOT).join("[agent-env-mcp]");

  if (selectedRuntime?.hostWorkspace) {
    result = result
      .split(selectedRuntime.hostWorkspace)
      .join("[host-workspace]");
  }

  return result;
}

function runProcess(
  command,
  args,
  {
    input = "",
    timeoutMs = 60_000,
    env = process.env,
    maxOutputBytes = MAX_CONTROLLER_OUTPUT_BYTES,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const append = (current, chunk, streamName) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxOutputBytes) {
        child.kill();
        finish(
          reject,
          new Error(`${streamName} exceeded the controller output limit.`)
        );
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, "stderr");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      finish(resolve, {
        code: code ?? -1,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });

    timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Process timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.stdin.end(input || undefined);
  });
}

async function dockerCompose(selectedRuntime, args, options = {}) {
  if (!selectedRuntime) {
    throw new Error("No authorized project runtime is bound.");
  }

  return runProcess(
    "docker",
    [
      "compose",
      "-p",
      selectedRuntime.composeProject,
      "-f",
      COMPOSE_FILE,
      ...args,
    ],
    {
      ...options,
      env: {
        ...process.env,
        AGENT_HOST_WORKSPACE: selectedRuntime.hostWorkspace,
        AGENT_CONTAINER_WORKSPACE: selectedRuntime.containerWorkspace,
      },
    }
  );
}

async function bindCurrentRuntime() {
  const hostWorkspace = await discoverWorkspaceRoot();
  const candidate = createRuntime(hostWorkspace);

  if (sameRuntime(runtime, candidate)) return runtime;

  if (activeCommands > 0) {
    throw new Error(
      "The VS Code workspace changed while agent-env operations are active."
    );
  }

  if (runtime && environmentStarted) {
    await releaseEnvironment(runtime);
  }

  runtime = candidate;
  return runtime;
}

async function helperRaw(
  selectedRuntime,
  service,
  operation,
  payload,
  timeoutMs = 60_000
) {
  if (service !== AGENT_SERVICE) {
    throw new Error("Invalid agent-env runtime service.");
  }

  const result = await dockerCompose(
    selectedRuntime,
    [
      "exec",
      "-T",
      service,
      "node",
      "/opt/agent-env/helper.mjs",
      operation,
    ],
    {
      input: JSON.stringify(payload ?? {}),
      timeoutMs: timeoutMs + 10_000,
    }
  );

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `Invalid response from agent runtime: ${sanitizeControllerText(
        result.stderr || result.stdout,
        selectedRuntime
      )}`,
      { cause: error }
    );
  }

  if (result.code !== 0 || parsed.ok === false) {
    throw new Error(
      parsed.error ||
        sanitizeControllerText(result.stderr, selectedRuntime) ||
        "Agent runtime operation failed."
    );
  }

  return parsed.result;
}

async function verifyServices(selectedRuntime) {
  const engineer = await helperRaw(
    selectedRuntime,
    AGENT_SERVICE,
    "verify",
    {},
    15_000
  );

  if (engineer.role !== "engineer") {
    throw new Error("Agent runtime service roles were not verified correctly.");
  }

  return engineer;
}

async function prepareEnvironmentInner() {
  lastActivity = Date.now();
  const selectedRuntime = await bindCurrentRuntime();

  if (environmentStarted) {
    try {
      const verification = await verifyServices(selectedRuntime);
      lastActivity = Date.now();
      return { runtime: selectedRuntime, verification };
    } catch {
      environmentStarted = false;
    }
  }

  const up = await dockerCompose(
    selectedRuntime,
    ["up", "-d", "--build", "--remove-orphans"],
    { timeoutMs: 5 * 60_000 }
  );

  if (up.code !== 0) {
    throw new Error(
      `Unable to start agent environment: ${sanitizeControllerText(
        up.stderr,
        selectedRuntime
      )}`
    );
  }

  environmentStarted = true;
  lastActivity = Date.now();

  try {
    const verification = await verifyServices(selectedRuntime);
    return { runtime: selectedRuntime, verification };
  } catch (error) {
    environmentStarted = false;
    throw error;
  }
}

async function prepareEnvironment() {
  if (shuttingDown) {
    throw new Error("agent-env is shutting down.");
  }
  if (!preparePromise) {
    preparePromise = prepareEnvironmentInner().finally(() => {
      preparePromise = null;
    });
  }
  return preparePromise;
}

async function ensureEnvironment() {
  return (await prepareEnvironment()).verification;
}

async function invokeHelper(
  service,
  operation,
  payload,
  timeoutMs = 60_000
) {
  const prepared = await prepareEnvironment();
  activeCommands++;
  lastActivity = Date.now();

  try {
    return await helperRaw(
      prepared.runtime,
      service,
      operation,
      payload,
      timeoutMs
    );
  } finally {
    activeCommands--;
    lastActivity = Date.now();
  }
}

async function releaseEnvironment(selectedRuntime = runtime, { force = false } = {}) {
  if (!selectedRuntime) return;
  if (!force && (!environmentStarted || activeCommands > 0)) return;

  const down = await dockerCompose(
    selectedRuntime,
    ["down", "--remove-orphans"],
    { timeoutMs: 2 * 60_000 }
  );

  if (down.code !== 0) {
    throw new Error(
      `Unable to stop agent environment: ${sanitizeControllerText(
        down.stderr,
        selectedRuntime
      )}`
    );
  }

  environmentStarted = false;
}

setInterval(async () => {
  if (shuttingDown) return;
  if (!environmentStarted || activeCommands > 0 || preparePromise) return;
  if (Date.now() - lastActivity < IDLE_TIMEOUT_MS) return;

  try {
    await releaseEnvironment();
    console.error("agent-env: stopped idle environment after 15 minutes.");
  } catch (error) {
    console.error(
      "agent-env: idle shutdown failed:",
      sanitizeControllerText(error)
    );
  }
}, 60_000).unref();

const shutdown = createShutdownCoordinator({
  beginShutdown: () => {
    shuttingDown = true;
  },
  waitForPreparation: async () => {
    try {
      await preparePromise;
    } catch {
      // Forced Compose teardown below also covers partial startup failures.
    }
  },
  releaseEnvironment: () => releaseEnvironment(runtime, { force: true }),
  closeServer: () => server.close(),
  exit: (exitCode) => process.exit(exitCode),
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());
process.stdin.once("error", () => void shutdown(1));
process.stdout.once("error", () => void shutdown(1));
process.on("uncaughtException", () => void shutdown(1));
process.on("unhandledRejection", () => void shutdown(1));

const listDirectoryArgs = z.object({
  path: z.string().max(4096).optional().default("."),
  max_depth: z.number().int().min(0).max(4).optional().default(2),
});

const readFileArgs = z.object({
  path: z.string().min(1).max(4096),
  start_line: z.number().int().min(1).optional().default(1),
  end_line: z.number().int().min(1).optional(),
});

const searchWorkspaceArgs = z.object({
  query: z.string().min(1).max(4096),
  path: z.string().max(4096).optional().default("."),
  glob: z.string().max(1024).optional(),
  regex: z.boolean().optional().default(false),
  max_results: z.number().int().min(1).max(100).optional().default(50),
});

const workspaceEditArgs = z.object({
  operation: z.enum(["create", "replace", "overwrite", "delete"]),
  path: z.string().min(1).max(4096),
  old_text: z.string().max(1024 * 1024).optional(),
  new_text: z.string().max(1024 * 1024).optional(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

const runCommandArgs = z.object({
  program: z.string().min(1).max(4096),
  args: z.array(z.string().max(16 * 1024)).max(128).optional().default([]),
  cwd: z.string().max(4096).optional().default("."),
  timeout_seconds: z.number().int().min(1).max(900).optional().default(300),
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ensure_environment",
      description: "Start and verify the authorized Linux agent environment.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_directory",
      description: "List files under the authorized project workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_depth: { type: "integer", minimum: 0, maximum: 4 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description:
        "Read verbatim content from a bounded range of a workspace text file. Returned content never contains synthetic line-number prefixes. The response sha256 identifies the complete file and must be passed as expected_sha256 for a guarded whole-file overwrite.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "search_workspace",
      description:
        "Search text within the authorized project workspace. Matches include paths and verbatim matching text without synthetic line or column numbers.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          regex: { type: "boolean" },
          max_results: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "workspace_edit",
      description:
        "Create, edit, or delete one workspace file. Use replace only for a small exact old_text snippet. For a complete-file rewrite, use overwrite with new_text and the expected_sha256 returned by read_file; do not echo the old file as old_text.",
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["create", "replace", "overwrite", "delete"],
          },
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          expected_sha256: {
            type: "string",
            pattern: "^[a-fA-F0-9]{64}$",
            description:
              "Required for overwrite. Copy the sha256 returned by read_file so stale writes are rejected.",
          },
        },
        required: ["operation", "path"],
        additionalProperties: false,
      },
    },
    {
      name: "run_command",
      description:
        "Run one non-shell program in the engineering container. cwd and executable paths must be relative to the authorized workspace root returned by ensure_environment; use cwd '.' for the project root. The real .git metadata is masked.",
      inputSchema: {
        type: "object",
        properties: {
          program: { type: "string" },
          args: { type: "array", items: { type: "string" }, maxItems: 128 },
          cwd: {
            type: "string",
            description:
              "Workspace-root-relative directory. Use '.' for the project root or a relative subdirectory such as 'scripts'; absolute paths are rejected.",
          },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 900 },
        },
        required: ["program"],
        additionalProperties: false,
      },
    },
  ],
}));

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs = {} } = request.params;

  if (name === "ensure_environment") {
    return textResult(await ensureEnvironment());
  }

  if (name === "list_directory") {
    const args = listDirectoryArgs.parse(rawArgs);
    return textResult(
      await invokeHelper(AGENT_SERVICE, "list_directory", args, 30_000)
    );
  }

  if (name === "read_file") {
    const args = readFileArgs.parse(rawArgs);
    return textResult(
      await invokeHelper(AGENT_SERVICE, "read_file", args, 30_000)
    );
  }

  if (name === "search_workspace") {
    const args = searchWorkspaceArgs.parse(rawArgs);
    return textResult(
      await invokeHelper(AGENT_SERVICE, "search_workspace", args, 60_000)
    );
  }

  if (name === "workspace_edit") {
    const args = workspaceEditArgs.parse(rawArgs);

    if (args.operation === "create" && args.new_text === undefined) {
      throw new Error("create requires new_text.");
    }
    if (
      args.operation === "replace" &&
      (args.old_text === undefined || args.new_text === undefined)
    ) {
      throw new Error("replace requires old_text and new_text.");
    }
    if (
      args.operation === "overwrite" &&
      (args.new_text === undefined || args.expected_sha256 === undefined)
    ) {
      throw new Error("overwrite requires new_text and expected_sha256.");
    }

    return textResult(
      await invokeHelper(AGENT_SERVICE, "workspace_edit", args, 60_000)
    );
  }

  if (name === "run_command") {
    const args = runCommandArgs.parse(rawArgs);
    return textResult(
      await invokeHelper(
        AGENT_SERVICE,
        "run_command",
        args,
        args.timeout_seconds * 1000 + 5_000
      )
    );
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
