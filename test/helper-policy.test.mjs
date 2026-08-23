import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizedRelative,
  sanitizedChildEnvironment,
  validateProgram,
} from "../runtime/helper.mjs";

test("workspace paths reject traversal and protected metadata", () => {
  assert.equal(normalizedRelative("src/main.cpp"), "src/main.cpp");
  for (const value of ["../outside", "/etc/passwd", "C:\\secret", ".git/config", ".ssh/id_rsa", ".gnupg/key"]) {
    assert.throws(() => normalizedRelative(value));
  }
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
