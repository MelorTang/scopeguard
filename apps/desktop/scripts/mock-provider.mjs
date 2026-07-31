import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.SCOPEGUARD_MOCK_PROVIDER_PORT ?? "47821", 10);
const expectedKey =
  process.env.SCOPEGUARD_MOCK_PROVIDER_KEY ?? "sg-fake-desktop-validation-key";

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    sendJson(response, 404, { error: { message: "Not found." } });
    return;
  }
  if (request.headers.authorization !== `Bearer ${expectedKey}`) {
    sendJson(response, 401, { error: { message: "Invalid test credential." } });
    return;
  }

  try {
    const body = JSON.parse(await readBody(request));
    if (body.stream !== true) {
      sendJson(response, 200, {
        choices: [
          {
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    await streamTurn(response, body);
  } catch (error) {
    sendJson(response, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`ScopeGuard mock provider listening on http://${host}:${port}/v1\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

async function streamTurn(response, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "tool") {
    await streamText(
      response,
      `Tool completed. Result preview: ${String(lastMessage.content).slice(0, 120)}`,
    );
    return;
  }

  const prompt = String(
    [...messages].reverse().find((message) => message?.role === "user")?.content ??
      "",
  );
  if (prompt.includes("[tool:read]")) {
    await streamToolCall(response, "read_file", { path: "package.json" });
    return;
  }
  if (prompt.includes("[tool:command]")) {
    await streamToolCall(response, "run_command", {
      command: "printf 'scopeguard-command-approved'",
      timeoutMs: 5_000,
    });
    return;
  }
  if (prompt.includes("[tool:write]")) {
    await streamToolCall(response, "write_file", {
      path: "scopeguard-write-smoke.txt",
      content: "ScopeGuard write_file smoke test.\n",
    });
    return;
  }
  if (prompt.includes("[tool:input]")) {
    await streamToolCall(response, "request_user_input", {
      question: "这份报告应覆盖哪个时间范围？",
    });
    return;
  }
  if (prompt.includes("[slow]")) {
    await delay(5_000);
  }

  await streamText(
    response,
    `Desktop Agent completed an isolated response for: ${prompt}`,
  );
}

async function streamText(response, text) {
  for (const chunk of text.match(/.{1,10}/g) ?? []) {
    writeEvent(response, {
      choices: [{ delta: { content: chunk }, finish_reason: null }],
    });
    await delay(65);
  }
  writeEvent(response, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 18 },
  });
  response.end("data: [DONE]\n\n");
}

async function streamToolCall(response, name, args) {
  const callId = `call_${Date.now()}`;
  writeEvent(response, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  await delay(80);
  writeEvent(response, {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
  });
  response.end("data: [DONE]\n\n");
}

function writeEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
