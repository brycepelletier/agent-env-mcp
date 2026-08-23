import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownCoordinator } from "../runtime/lifecycle.mjs";

test("shutdown is single-flight and tears down before server close", async () => {
  const events = [];
  const shutdown = createShutdownCoordinator({
    beginShutdown: () => events.push("begin"),
    waitForPreparation: async () => events.push("prepared"),
    releaseEnvironment: async () => events.push("down"),
    closeServer: async () => events.push("close"),
    exit: (code) => events.push(`exit:${code}`),
  });

  await Promise.all([shutdown(), shutdown(), shutdown()]);
  assert.deepEqual(events, ["begin", "prepared", "down", "close", "exit:0"]);
});

test("shutdown still tears down after preparation failure", async () => {
  const events = [];
  const shutdown = createShutdownCoordinator({
    beginShutdown: () => events.push("begin"),
    waitForPreparation: async () => { throw new Error("startup failed"); },
    releaseEnvironment: async () => events.push("down"),
    closeServer: async () => events.push("close"),
    exit: (code) => events.push(`exit:${code}`),
  });

  await shutdown();
  assert.deepEqual(events, ["begin", "down", "close", "exit:1"]);
});

test("shutdown attempts server close when Compose teardown fails", async () => {
  const events = [];
  const shutdown = createShutdownCoordinator({
    beginShutdown: () => events.push("begin"),
    waitForPreparation: async () => events.push("prepared"),
    releaseEnvironment: async () => { throw new Error("down failed"); },
    closeServer: async () => events.push("close"),
    exit: (code) => events.push(`exit:${code}`),
  });

  await shutdown();
  assert.deepEqual(events, ["begin", "prepared", "close", "exit:1"]);
});
