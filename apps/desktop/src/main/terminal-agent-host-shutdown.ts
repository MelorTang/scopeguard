export type TerminalAgentHostShutdownEvent =
  | "host-stop-started"
  | "host-stop-complete";

export async function stopAgentHostForTerminalShutdown(input: {
  stop(): Promise<void>;
  recordEvent(event: TerminalAgentHostShutdownEvent): void;
}): Promise<void> {
  input.recordEvent("host-stop-started");
  await input.stop();
  input.recordEvent("host-stop-complete");
}
