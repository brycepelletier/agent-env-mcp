export function createShutdownCoordinator({
  beginShutdown,
  waitForPreparation,
  releaseEnvironment,
  closeServer,
  exit,
}) {
  let shutdownPromise;

  return function shutdown(exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;

    beginShutdown();
    shutdownPromise = (async () => {
      let finalExitCode = exitCode;

      try {
        await waitForPreparation();
      } catch {
        finalExitCode = 1;
      }

      try {
        await releaseEnvironment();
      } catch {
        finalExitCode = 1;
      }

      try {
        await closeServer();
      } catch {
        finalExitCode = 1;
      }

      exit(finalExitCode);
    })();

    return shutdownPromise;
  };
}
