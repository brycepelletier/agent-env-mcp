#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(SERVER_ROOT, "runtime");
const COMPOSE_FILE = path.join(RUNTIME_DIR, "compose.yaml");

const AGENT_SERVICE = "agent";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONTROLLER_OUTPUT_BYTES = 1024 * 1024;

function requireHostWorkspace() {
  const configured = process.env.AGENT_HOST_WORKSPACE;
  if (!configured) {
    throw new Error(
      "AGENT_HOST_WORKSPACE is required. Configure it from VS Code as ${workspaceFolder}."
    );
  }

  const resolved = fs.realpathSync(path.resolve(configured));
  const stat = fs.statSync(resolved);

  if (!stat.isDirectory()) {
    throw new Error("AGENT_HOST_WORKSPACE must resolve to a directory.");
  }

  const parsed = path.parse(resolved);
  if (path.normalize(resolved) === path.normalize(parsed.root)) {
    throw new Error("Refusing to mount a filesystem root as the agent workspace.");
  }

  return resolved;
}

function projectSlugFromWorkspace(workspace) {
  const raw = path.basename(workspace);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  if (!slug) {
    throw new Error("Could not derive a safe project slug from the workspace.");
  }

  return slug;
}

const HOST_WORKSPACE = requireHostWorkspace();
const PROJECT_SLUG = projectSlugFromWorkspace(HOST_WORKSPACE);
const WORKSPACE_HASH = createHash("sha256")
  .update(HOST_WORKSPACE.toLowerCase())
  .digest("hex")
  .slice(0, 8);

const CONTAINER_WORKSPACE = `/agent-env/environment/${PROJECT_SLUG}`;
const COMPOSE_PROJECT = `agent-env-${PROJECT_SLUG}-${WORKSPACE_HASH}`;

const COMPOSE_ENV = {
  ...process.env,
  AGENT_HOST_WORKSPACE: HOST_WORKSPACE,
  AGENT_CONTAINER_WORKSPACE: CONTAINER_WORKSPACE,
};

let lastActivity = Date.now();
let activeCommands = 0;
let environmentStarted = false;
let shuttingDown = false;

function sanitizeControllerText(value) {
  if (!value) return "";
  return String(value)
    .split(HOST_WORKSPACE).join("[host-workspace]")
    .split(SERVER_ROOT).join("[agent-env-mcp]");
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

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Process timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function dockerCompose(args, options = {}) {
  return runProcess(
    "docker",
    [
      "compose",
      "-p",
      COMPOSE_PROJECT,
      "-f",
      COMPOSE_FILE,
      ...args,
    ],
    {
      ...options,
      env: COMPOSE_ENV,
    }
  );
}

async function helperRaw(operation, payload, timeoutMs = 60_000) {
  const result = await dockerCompose(
    [
      "exec",
      "-T",
      AGENT_SERVICE,
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
  } catch {
    throw new Error(
      `Invalid response from agent runtime: ${sanitizeControllerText(
        result.stderr || result.stdout
      )}`
    );
  }

  if (result.code !== 0 || parsed.ok === false) {
    throw new Error(
      parsed.error ||
        sanitizeControllerText(result.stderr) ||
        "Agent runtime operation failed."
    );
  }

  return parsed.result;
}

async function ensureEnvironment() {
  if (environmentStarted) {
    try {
      const verified = await helperRaw("verify", {}, 15_000);
      lastActivity = Date.now();
      return verified;
    } catch {
      environmentStarted = false;
    }
  }

  const up = await dockerCompose(["up", "-d"], { timeoutMs: 5 * 60_000 });

  if (up.code !== 0) {
    throw new Error(
      `Unable to start agent environment: ${sanitizeControllerText(up.stderr)}`
    );
  }

  environmentStarted = true;
  lastActivity = Date.now();

  try {
    return await helperRaw("verify", {}, 20_000);
  } catch (error) {
    environmentStarted = false;
    throw error;
  }
}

async function invokeHelper(operation, payload, timeoutMs = 60_000) {
  await ensureEnvironment();

  activeCommands++;
  lastActivity = Date.now();

  try {
    return await helperRaw(operation, payload, timeoutMs);
  } finally {
    activeCommands--;
    lastActivity = Date.now();
  }
}

async function releaseEnvironment() {
  if (!environmentStarted || activeCommands > 0) return;

  const down = await dockerCompose(["down", "--remove-orphans"], {
    timeoutMs: 2 * 60_000,
  });

  if (down.code !== 0) {
    throw new Error(
      `Unable to stop agent environment: ${sanitizeControllerText(down.stderr)}`
    );
  }

  environmentStarted = false;
}

setInterval(async () => {
  if (!environmentStarted || activeCommands > 0) return;
  if (Date.now() - lastActivity < IDLE_TIMEOUT_MS) return;

  try {
    await releaseEnvironment();
    console.error("agent-env: stopped idle environment after 15 minutes.");
  } catch (error) {
    console.error("agent-env: idle shutdown failed:", sanitizeControllerText(error));
  }
}, 60_000).unref();

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    if (activeCommands === 0) await releaseEnvironment();
  } catch (error) {
    console.error(
      `agent-env: shutdown after ${signal} could not release environment:`,
      sanitizeControllerText(error)
    );
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

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
  operation: z.enum(["create", "replace", "delete"]),
  path: z.string().min(1).max(4096),
  old_text: z.string().max(1024 * 1024).optional(),
  new_text: z.string().max(1024 * 1024).optional(),
});

const runCommandArgs = z.object({
  program: z.string().min(1).max(4096),
  args: z.array(z.string().max(16 * 1024)).max(128).optional().default([]),
  cwd: z.string().max(4096).optional().default("."),
  timeout_seconds: z.number().int().min(1).max(900).optional().default(300),
});

const gitCommandArgs = z.object({
  args: z.array(z.string().max(16 * 1024)).max(128).optional().default([]),
  cwd: z.string().max(4096).optional().default("."),
  timeout_seconds: z.number().int().min(1).max(900).optional().default(300),
});

const server = new Server(
  { name: "agent-env", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

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
      description: "Read a bounded line range from a workspace text file.",
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
      description: "Search text within the authorized project workspace.",
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
      description: "Create, exact-replace, or delete one workspace file.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["create", "replace", "delete"] },
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["operation", "path"],
        additionalProperties: false,
      },
    },
    {
      name: "run_command",
      description: "Run one non-shell program inside the authorized agent container.",
      inputSchema: {
        type: "object",
        properties: {
          program: { type: "string" },
          args: { type: "array", items: { type: "string" }, maxItems: 128 },
          cwd: { type: "string" },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 900 },
        },
        required: ["program"],
        additionalProperties: false,
      },
    },
    {
      name: "git_command",
      description: "Run Git inside the authorized agent container.",
      inputSchema: {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" }, maxItems: 128 },
          cwd: { type: "string" },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 900 },
        },
        additionalProperties: false,
      },
    },
  ],
}));

function textResult(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs = {} } = request.params;

  if (name === "ensure_environment") {
    return textResult(await ensureEnvironment());
  }

  if (name === "list_directory") {
    const args = listDirectoryArgs.parse(rawArgs);
    return textResult(await invokeHelper("list_directory", args, 30_000));
  }

  if (name === "read_file") {
    const args = readFileArgs.parse(rawArgs);
    return textResult(await invokeHelper("read_file", args, 30_000));
  }

  if (name === "search_workspace") {
    const args = searchWorkspaceArgs.parse(rawArgs);
    return textResult(await invokeHelper("search_workspace", args, 60_000));
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

    return textResult(await invokeHelper("workspace_edit", args, 60_000));
  }

  if (name === "run_command") {
    const args = runCommandArgs.parse(rawArgs);
    return textResult(
      await invokeHelper(
        "run_command",
        args,
        args.timeout_seconds * 1000 + 5_000
      )
    );
  }

  if (name === "git_command") {
    const args = gitCommandArgs.parse(rawArgs);
    return textResult(
      await invokeHelper(
        "git_command",
        args,
        args.timeout_seconds * 1000 + 5_000
      )
    );
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
