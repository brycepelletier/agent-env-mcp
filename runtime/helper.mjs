#!/usr/bin/env node

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT;
const RUNTIME_ROLE = process.env.AGENT_RUNTIME_ROLE;
const RUNTIME_MARKER = "/opt/agent-env/runtime-marker";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMAND_STREAM_BYTES = 64 * 1024;

const PROTECTED_SEGMENTS = new Set([".git", ".ssh", ".gnupg"]);

const BLOCKED_PROGRAMS = new Set([
  "bash",
  "sh",
  "dash",
  "zsh",
  "fish",
  "powershell",
  "powershell.exe",
  "pwsh",
  "cmd",
  "cmd.exe",
  "wsl",
  "wsl.exe",
  "docker",
  "docker.exe",
  "podman",
  "nerdctl",
  "nsenter",
  "mount",
  "umount",
  "sudo",
  "su",
  "ssh",
  "scp",
  "sftp",
  "env",
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "branch",
  "switch",
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "tag",
  "stash",
]);

function fail(message) {
  const error = new Error(message);
  error.isAgentEnvError = true;
  throw error;
}

function requireRole(expected) {
  if (RUNTIME_ROLE !== expected) {
    fail(`Operation requires the '${expected}' runtime role.`);
  }
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString("utf8");
    if (text.length > 2 * 1024 * 1024) {
      fail("Tool request exceeded the input-size limit.");
    }
  }

  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    fail("Tool request was not valid JSON.");
  }
}

function normalizedRelative(input = ".") {
  if (typeof input !== "string") fail("Path must be a string.");
  if (input.includes("\0")) fail("Path contains a NUL byte.");
  if (input.includes("\\")) fail("Use workspace-relative POSIX paths.");
  if (/^[A-Za-z]:/.test(input)) fail("Windows paths are not allowed.");
  if (path.posix.isAbsolute(input)) fail("Absolute paths are not allowed.");

  const normalized = path.posix.normalize(input || ".");
  if (normalized === ".." || normalized.startsWith("../")) {
    fail("Path escapes the authorized workspace.");
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    fail("Access to protected repository or credential metadata is denied.");
  }

  return normalized;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function workspaceRealRoot() {
  if (!WORKSPACE_ROOT) fail("AGENT_WORKSPACE_ROOT is not configured.");
  return fsp.realpath(WORKSPACE_ROOT);
}

async function resolveExisting(relativeInput = ".") {
  const relative = normalizedRelative(relativeInput);
  const root = await workspaceRealRoot();
  const lexical = path.resolve(root, relative);

  if (!isWithin(root, lexical)) fail("Path escapes the authorized workspace.");

  const real = await fsp.realpath(lexical);
  if (!isWithin(root, real)) {
    fail("Resolved path escapes the authorized workspace through a symlink.");
  }

  return { relative, root, path: real };
}

async function resolveCreateTarget(relativeInput) {
  const relative = normalizedRelative(relativeInput);
  if (relative === ".") fail("A file path is required.");

  const root = await workspaceRealRoot();
  const lexical = path.resolve(root, relative);
  if (!isWithin(root, lexical)) fail("Path escapes the authorized workspace.");

  const parent = path.dirname(lexical);
  const realParent = await fsp.realpath(parent);
  if (!isWithin(root, realParent)) {
    fail("Parent directory escapes the authorized workspace through a symlink.");
  }

  return {
    relative,
    root,
    path: path.join(realParent, path.basename(lexical)),
  };
}

function boundedText(bufferOrText, limit = MAX_COMMAND_STREAM_BYTES) {
  const buffer = Buffer.isBuffer(bufferOrText)
    ? bufferOrText
    : Buffer.from(String(bufferOrText ?? ""), "utf8");

  if (buffer.length <= limit) {
    return { text: buffer.toString("utf8"), truncated: false };
  }

  const headBytes = Math.min(8 * 1024, Math.floor(limit / 4));
  const tailBytes = limit - headBytes;

  return {
    text:
      buffer.subarray(0, headBytes).toString("utf8") +
      "\n... [output truncated by agent-env] ...\n" +
      buffer.subarray(buffer.length - tailBytes).toString("utf8"),
    truncated: true,
  };
}

function sanitizedChildEnvironment() {
  const result = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;

    const upper = key.toUpperCase();
    if (
      /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL|AUTH)(_|$)/.test(
        upper
      ) ||
      upper === "SSH_AUTH_SOCK" ||
      upper.startsWith("GITHUB_") ||
      upper.startsWith("GH_")
    ) {
      continue;
    }

    result[key] = value;
  }

  result.AGENT_WORKSPACE_ROOT = WORKSPACE_ROOT;
  result.AGENT_RUNTIME_ROLE = RUNTIME_ROLE;
  result.GIT_EDITOR = "true";
  result.GIT_SEQUENCE_EDITOR = "true";
  result.GIT_MERGE_AUTOEDIT = "no";
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = "/dev/null";
  return result;
}

function validateGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    fail("git_command requires a Git subcommand.");
  }

  const subcommand = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    fail(
      `Git subcommand '${subcommand}' is not allowed by the local-only Git policy.`
    );
  }

  if (args.some((arg) => ["--ext-diff", "--force", "-f"].includes(arg))) {
    fail("Force/external-execution Git options are blocked.");
  }

  if (
    args.some(
      (arg) => arg === "--exec" || arg === "-x" || arg.startsWith("--exec=")
    )
  ) {
    fail("Git options that execute arbitrary commands are blocked.");
  }

  if (
    subcommand === "branch" &&
    args.some((arg) => arg === "-D" || arg === "-d" || arg === "--delete")
  ) {
    fail("Branch deletion is blocked by the hardened Git policy.");
  }

  if (
    subcommand === "switch" &&
    args.some(
      (arg) =>
        arg === "-C" ||
        arg === "--force-create" ||
        arg === "--discard-changes"
    )
  ) {
    fail("Destructive branch switching is blocked.");
  }

  if (subcommand === "commit" && args.includes("--amend")) {
    fail("Commit amendment is blocked by the hardened Git policy.");
  }

  if (
    subcommand === "tag" &&
    args.some((arg) => arg === "-d" || arg === "--delete")
  ) {
    fail("Tag deletion is blocked by the hardened Git policy.");
  }

  if (
    subcommand === "stash" &&
    args.some((arg) => arg === "drop" || arg === "clear")
  ) {
    fail("Destructive stash operations are blocked.");
  }
}

function hardenedGitArgs(args) {
  validateGitArgs(args);

  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    ...args,
  ];
}

function validateProgram(program, { allowGit = false } = {}) {
  if (typeof program !== "string" || !program) fail("Program is required.");
  if (program.includes("\0")) fail("Program contains a NUL byte.");
  if (path.isAbsolute(program)) fail("Absolute executable paths are not allowed.");

  const base = path.basename(program).toLowerCase();

  if (BLOCKED_PROGRAMS.has(base)) {
    fail(`Program '${base}' is blocked by the agent runtime policy.`);
  }

  if (!allowGit && base === "git") {
    fail("Direct Git use is reserved for the git_command tool.");
  }

  if (allowGit && base !== "git") {
    fail("git_command can execute only Git.");
  }
}

async function runProgram({
  program,
  args = [],
  cwd = ".",
  timeout_seconds = 300,
  allowGit = false,
}) {
  validateProgram(program, { allowGit });

  const cwdResolved = await resolveExisting(cwd);
  const cwdStat = await fsp.stat(cwdResolved.path);
  if (!cwdStat.isDirectory()) fail("Command cwd must be a directory.");

  let executable = program;
  if (program.includes("/")) {
    const candidate = normalizedRelative(
      path.posix.join(cwdResolved.relative, program)
    );
    executable = (await resolveExisting(candidate)).path;
  }

  const timeoutMs = Math.max(1, Math.min(900, timeout_seconds)) * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: cwdResolved.path,
      env: sanitizedChildEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let finished = false;

    const capture = (chunks, chunk, isStdout) => {
      const current = isStdout ? stdoutBytes : stderrBytes;
      if (current >= MAX_COMMAND_STREAM_BYTES * 4) {
        if (isStdout) stdoutOverflow = true;
        else stderrOverflow = true;
        return;
      }

      chunks.push(chunk);
      if (isStdout) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
    };

    child.stdout.on("data", (chunk) => capture(stdoutChunks, chunk, true));
    child.stderr.on("data", (chunk) => capture(stderrChunks, chunk, false));
    child.on("error", reject);

    const hardKill = () => {
      if (!finished) child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(hardKill, 2000).unref();
    }, timeoutMs);

    child.on("close", (code, signal) => {
      finished = true;
      clearTimeout(timer);

      const stdout = boundedText(Buffer.concat(stdoutChunks));
      const stderr = boundedText(Buffer.concat(stderrChunks));

      resolve({
        exit_code: code ?? -1,
        signal: signal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated:
          stdout.truncated ||
          stderr.truncated ||
          stdoutOverflow ||
          stderrOverflow,
      });
    });
  });
}

async function verify() {
  if (process.platform !== "linux") fail("Agent runtime is not Linux.");

  const marker = await fsp.readFile(RUNTIME_MARKER, "utf8");
  if (marker.trim() !== "agent-env-runtime-v2") {
    fail("Agent runtime marker is invalid.");
  }

  if (RUNTIME_ROLE !== "engineer" && RUNTIME_ROLE !== "git") {
    fail("Agent runtime role is invalid.");
  }

  const user = os.userInfo().username;
  if (user !== "vscode") fail(`Unexpected runtime user '${user}'.`);

  const root = await workspaceRealRoot();
  if (!(await fsp.stat(root)).isDirectory()) {
    fail("Authorized workspace root is not a directory.");
  }

  const cwd = await fsp.realpath(process.cwd());
  if (!isWithin(root, cwd)) {
    fail("Runtime working directory is outside the authorized workspace.");
  }

  return {
    authorized: true,
    platform: "linux",
    container: true,
    role: RUNTIME_ROLE,
    user,
    project: path.basename(root),
    workspace: root,
  };
}

async function listDirectory({ path: requested = ".", max_depth = 2 }) {
  const resolved = await resolveExisting(requested);
  if (!(await fsp.stat(resolved.path)).isDirectory()) {
    fail("list_directory path must be a directory.");
  }

  const results = [];
  let truncated = false;

  async function walk(directory, relativeBase, depth) {
    if (results.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }

    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }

      if (PROTECTED_SEGMENTS.has(entry.name)) continue;

      const relativePath =
        relativeBase === "." || relativeBase === ""
          ? entry.name
          : path.posix.join(relativeBase, entry.name);

      if (entry.isSymbolicLink()) {
        results.push(`${relativePath}@`);
        continue;
      }

      if (entry.isDirectory()) {
        results.push(`${relativePath}/`);
        if (depth < max_depth) {
          await walk(path.join(directory, entry.name), relativePath, depth + 1);
        }
      } else {
        results.push(relativePath);
      }
    }
  }

  await walk(resolved.path, resolved.relative, 0);
  return { path: resolved.relative, entries: results, truncated };
}

async function readFile({ path: requested, start_line = 1, end_line }) {
  const resolved = await resolveExisting(requested);
  const stat = await fsp.stat(resolved.path);

  if (!stat.isFile()) fail("read_file path must be a regular file.");
  if (stat.size > MAX_FILE_BYTES) fail("File exceeds the 2 MiB read limit.");

  const buffer = await fsp.readFile(resolved.path);
  if (buffer.subarray(0, 8192).includes(0)) {
    fail("Binary files are not readable through read_file.");
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (start_line > lines.length) {
    fail(`start_line exceeds file length (${lines.length} lines).`);
  }

  const requestedEnd = end_line ?? start_line + MAX_READ_LINES - 1;
  const actualEnd = Math.min(
    lines.length,
    requestedEnd,
    start_line + MAX_READ_LINES - 1
  );

  const content = lines
    .slice(start_line - 1, actualEnd)
    .map((line, index) => `${start_line + index}: ${line}`)
    .join("\n");

  return {
    path: resolved.relative,
    start_line,
    end_line: actualEnd,
    total_lines: lines.length,
    truncated: actualEnd < requestedEnd || actualEnd < lines.length,
    content,
  };
}

async function runRawProgram(program, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: sanitizedChildEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const capture = (target, chunk, isStdout) => {
      if ((isStdout ? stdoutBytes : stderrBytes) < MAX_COMMAND_STREAM_BYTES * 4) {
        target.push(chunk);
      }
      if (isStdout) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk, true));
    child.stderr.on("data", (chunk) => capture(stderr, chunk, false));
    child.on("error", reject);

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = boundedText(Buffer.concat(stdout));
      const err = boundedText(Buffer.concat(stderr));

      resolve({
        exit_code: code ?? -1,
        signal: signal ?? null,
        stdout: out.text,
        stderr: err.text,
        truncated:
          out.truncated ||
          err.truncated ||
          stdoutBytes > MAX_COMMAND_STREAM_BYTES ||
          stderrBytes > MAX_COMMAND_STREAM_BYTES,
      });
    });
  });
}

async function searchWorkspace({
  query,
  path: requested = ".",
  glob,
  regex = false,
  max_results = 50,
}) {
  const resolved = await resolveExisting(requested);

  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--hidden",
    "--glob",
    "!.git/**",
    "--max-filesize",
    "2M",
  ];

  if (!regex) args.push("--fixed-strings");
  if (glob) args.push("--glob", glob);
  args.push("--", query, resolved.path);

  const result = await runRawProgram(
    "rg",
    args,
    await workspaceRealRoot(),
    60_000
  );

  if (result.exit_code !== 0 && result.exit_code !== 1) {
    fail(result.stderr || "ripgrep search failed.");
  }

  const allLines = result.stdout.split(/\r?\n/).filter(Boolean);
  const rootPrefix = WORKSPACE_ROOT.endsWith("/")
    ? WORKSPACE_ROOT
    : `${WORKSPACE_ROOT}/`;

  return {
    query,
    path: resolved.relative,
    matches: allLines.slice(0, max_results).map((line) =>
      line.startsWith(rootPrefix) ? line.slice(rootPrefix.length) : line
    ),
    truncated: result.truncated || allLines.length > max_results,
  };
}

async function workspaceEdit({ operation, path: requested, old_text, new_text }) {
  if (operation === "create") {
    if (new_text === undefined) fail("create requires new_text.");
    const target = await resolveCreateTarget(requested);

    try {
      await fsp.writeFile(target.path, new_text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("create refused because the target file already exists.");
      }
      throw error;
    }

    return { operation, path: target.relative, changed: true };
  }

  if (operation === "replace") {
    if (old_text === undefined || new_text === undefined) {
      fail("replace requires old_text and new_text.");
    }
    if (!old_text) fail("replace old_text must not be empty.");

    const target = await resolveExisting(requested);
    const stat = await fsp.stat(target.path);
    if (!stat.isFile()) fail("replace target must be a regular file.");
    if (stat.size > MAX_FILE_BYTES) fail("replace target exceeds 2 MiB.");

    const current = await fsp.readFile(target.path, "utf8");
    const occurrences = current.split(old_text).length - 1;
    if (occurrences !== 1) {
      fail(`replace requires exactly one old_text match; found ${occurrences}.`);
    }

    const updated = current.replace(old_text, new_text);
    const temp = path.join(
      path.dirname(target.path),
      `.${path.basename(target.path)}.agent-env-${process.pid}-${Date.now()}`
    );

    try {
      await fsp.writeFile(temp, updated, {
        encoding: "utf8",
        mode: stat.mode,
        flag: "wx",
      });
      await fsp.rename(temp, target.path);
    } finally {
      try {
        await fsp.unlink(temp);
      } catch {}
    }

    return { operation, path: target.relative, changed: true };
  }

  if (operation === "delete") {
    const target = await resolveExisting(requested);
    if (!(await fsp.stat(target.path)).isFile()) {
      fail("delete can remove only a regular file.");
    }

    await fsp.unlink(target.path);
    return { operation, path: target.relative, changed: true };
  }

  fail(`Unknown workspace_edit operation '${operation}'.`);
}

async function main() {
  const operation = process.argv[2];
  const payload = await readStdin();

  if (operation === "verify") {
    process.stdout.write(JSON.stringify({ ok: true, result: await verify() }));
    return;
  }

  await verify();

  let result;
  if (operation === "list_directory") {
    requireRole("engineer");
    result = await listDirectory(payload);
  } else if (operation === "read_file") {
    requireRole("engineer");
    result = await readFile(payload);
  } else if (operation === "search_workspace") {
    requireRole("engineer");
    result = await searchWorkspace(payload);
  } else if (operation === "workspace_edit") {
    requireRole("engineer");
    result = await workspaceEdit(payload);
  } else if (operation === "run_command") {
    requireRole("engineer");
    result = await runProgram({ ...payload, allowGit: false });
  } else if (operation === "git_command") {
    requireRole("git");
    result = await runProgram({
      ...payload,
      program: "git",
      args: hardenedGitArgs(payload.args ?? []),
      allowGit: true,
    });
  } else {
    fail(`Unknown helper operation '${operation}'.`);
  }

  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error?.isAgentEnvError
        ? error.message
        : "Agent runtime operation failed.",
    })
  );

  if (!error?.isAgentEnvError) console.error(error);
  process.exitCode = 1;
});
