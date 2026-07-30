export type ServerSentEvent = {
  event: string | null;
  data: string;
  id: string | null;
};

export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingCarriageReturn = false;

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }

      const result = await reader.read();
      if (result.done) {
        buffer += normalizeLineEndings(decoder.decode(), () => pendingCarriageReturn, (value) => {
          pendingCarriageReturn = value;
        });
        if (pendingCarriageReturn) {
          buffer += "\n";
          pendingCarriageReturn = false;
        }
        break;
      }
      buffer += normalizeLineEndings(
        decoder.decode(result.value, { stream: true }),
        () => pendingCarriageReturn,
        (value) => {
          pendingCarriageReturn = value;
        },
      );

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEventBlock(block);
        if (parsed) {
          yield parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    const parsed = parseEventBlock(buffer.trimEnd());
    if (parsed) {
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeLineEndings(
  chunk: string,
  getPendingCarriageReturn: () => boolean,
  setPendingCarriageReturn: (value: boolean) => void,
): string {
  let normalized = "";
  let pendingCarriageReturn = getPendingCarriageReturn();

  for (const character of chunk) {
    if (pendingCarriageReturn) {
      normalized += "\n";
      pendingCarriageReturn = false;
      if (character === "\n") {
        continue;
      }
    }

    if (character === "\r") {
      pendingCarriageReturn = true;
    } else {
      normalized += character;
    }
  }

  setPendingCarriageReturn(pendingCarriageReturn);
  return normalized;
}

function parseEventBlock(block: string): ServerSentEvent | null {
  if (!block) {
    return null;
  }

  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return null;
  }
  return { event, id, data: data.join("\n") };
}
