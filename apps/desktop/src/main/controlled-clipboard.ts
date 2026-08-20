import { parseClipboardText } from "@scopeguard/ipc-contracts";

export function writeControlledClipboard(
  event: unknown,
  value: unknown,
  dependencies: {
    assertTrustedSender: (event: unknown) => void;
    writeText: (text: string) => void;
  },
): void {
  dependencies.assertTrustedSender(event);
  dependencies.writeText(parseClipboardText(value));
}
