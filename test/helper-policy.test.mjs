import assert from "node:assert/strict";
import test from "node:test";
import {
  commandStartError,
  createReadResult,
  normalizedRelative,
  readContentSlice,
  runtimeErrorMessage,
  sanitizedChildEnvironment,
  searchArguments,
  validateProgram,
} from "../runtime/helper.mjs";

test("file reads return verbatim content without synthetic line numbers", () => {
  const text = "alpha\r\nbeta\r\n3: source text that already has a prefix\r\n";
  assert.equal(
    readContentSlice(text, 1, 3),
    text
  );
  assert.equal(readContentSlice(text, 2, 2), "beta\r\n");
  assert.equal(text.replace(readContentSlice(text, 2, 2), "updated\r\n"),
    "alpha\r\nupdated\r\n3: source text that already has a prefix\r\n");
  assert.deepEqual(createReadResult("example.txt", false, text), {
    path: "example.txt",
    truncated: false,
    content: text,
  });
});

test("runtime failures retain actionable sanitized details", () => {
  assert.equal(
    commandStartError({ code: "ENOENT" }, "python3").message,
    "Executable 'python3' was not found in the runtime PATH."
  );
  assert.equal(
    commandStartError({ code: "EACCES" }, "scripts/check").message,
    "Permission denied while starting executable 'scripts/check'."
  );
  assert.match(
    runtimeErrorMessage(new Error("dependency loader failed")),
    /Agent runtime operation failed \(Error\): dependency loader failed/
  );
});

test("workspace paths reject traversal and protected metadata", () => {
  assert.equal(normalizedRelative("src/main.cpp"), "src/main.cpp");
  for (const value of ["../outside", "/etc/passwd", "C:\\secret", ".git/config", ".ssh/id_rsa", ".gnupg/key"]) {
    assert.throws(() => normalizedRelative(value));
  }
});

test("workspace search excludes protected directory nodes and descendants", () => {
  const args = searchArguments(
    { query: "needle", glob: "**", regex: false },
    "/workspace"
  );
  const expected = [
    "!**/.git",
    "!**/.git/**",
    "!**/.ssh",
    "!**/.ssh/**",
    "!**/.gnupg",
    "!**/.gnupg/**",
  ];

  for (const glob of expected) {
    const index = args.indexOf(glob);
    assert.notEqual(index, -1, glob);
    assert.ok(index > args.indexOf("**"), `${glob} must follow the caller glob`);
  }
  assert.equal(args.includes("--line-number"), false);
  assert.equal(args.includes("--column"), false);
  assert.deepEqual(args.slice(-3), ["--", "needle", "/workspace"]);
});

test("child environment strips credentials and hardens Git", () => {
  const result = sanitizedChildEnvironment({
    PATH: "/usr/bin",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    API_SECRET: "secret",
    SSH_AUTH_SOCK: "/tmp/agent",
  });
  assert.equal(result.PATH, "/usr/bin");
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "API_SECRET", "SSH_AUTH_SOCK"]) {
    assert.equal(Object.hasOwn(result, key), false);
  }
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.GIT_CONFIG_GLOBAL, "/dev/null");
});

test("engineering commands block Git, shells, Docker, and absolute executables", () => {
  assert.doesNotThrow(() => validateProgram("pio"));
  for (const program of ["git", "bash", "sh", "docker", "ssh", "/usr/bin/pio"]) {
    assert.throws(() => validateProgram(program));
  }
});

test("agent-env exposes no Git tool or Git runtime service", async () => {
  const index = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../index.mjs", import.meta.url), "utf8")
  );
  const compose = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../runtime/compose.yaml", import.meta.url), "utf8")
  );
  assert.equal(index.includes('name: "git_command"'), false);
  assert.equal(compose.includes("\n  git:"), false);
});
