// Process-level fault handlers for the server entry. Bun exits on an unhandled
// rejection by default, so one stray rejected promise (a DB blip under a
// fire-and-forget read) would end every live turn and stream at once.
//
// - An unhandled rejection is logged loudly and the process keeps serving. A
//   rejected promise leaves no half-run synchronous code behind; its owner has
//   already lost the result, and every durable path recovers from Postgres.
// - An uncaught exception is logged loudly and the process then exits. A
//   synchronous throw that escaped to the top may have left in-memory state
//   (the actor registry, cancellers, locks) half-updated, and running on with it
//   can wedge runs silently; a restart is safe because boot recovery rebuilds
//   from Postgres.

export function installProcessFaultHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandled promise rejection; still serving:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[process] uncaught exception; exiting so boot recovery restores a clean state:", error);
    process.exit(1);
  });
}
