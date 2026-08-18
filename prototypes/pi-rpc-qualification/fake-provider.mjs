import http from "node:http";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk({ id, delta = {}, finishReason = null, usage }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: "qualification-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function sendText(res, id, text, delayMs = 0) {
  writeSse(res, chunk({ id, delta: { role: "assistant", content: "" } }));
  const pieces = text.match(/.{1,12}/gs) ?? [text];
  for (const piece of pieces) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    writeSse(res, chunk({ id, delta: { content: piece } }));
  }
  writeSse(res, chunk({ id, finishReason: "stop" }));
  writeSse(
    res,
    chunk({
      id,
      usage: {
        prompt_tokens: 20,
        completion_tokens: Math.max(1, pieces.length),
        total_tokens: 20 + Math.max(1, pieces.length),
      },
    }),
  );
  res.end("data: [DONE]\n\n");
}

function sendToolCall(res, id, name, args, callId) {
  writeSse(res, chunk({ id, delta: { role: "assistant", content: "" } }));
  writeSse(
    res,
    chunk({
      id,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: { name, arguments: "" },
          },
        ],
      },
    }),
  );
  const encoded = JSON.stringify(args);
  for (let offset = 0; offset < encoded.length; offset += 16) {
    writeSse(
      res,
      chunk({
        id,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: encoded.slice(offset, offset + 16) },
            },
          ],
        },
      }),
    );
  }
  writeSse(res, chunk({ id, finishReason: "tool_calls" }));
  res.end("data: [DONE]\n\n");
}

export async function startFakeProvider({ expectedKey }) {
  const requests = [];
  let requestSequence = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const bodyChunks = [];
    for await (const bodyChunk of req) bodyChunks.push(bodyChunk);
    const body = JSON.parse(Buffer.concat(bodyChunks).toString("utf8"));
    const authorization = req.headers.authorization;
    const authOk = authorization === `Bearer ${expectedKey}`;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTexts = messages
      .filter((message) => message.role === "user")
      .map((message) => textOf(message.content));
    const lastUser = userTexts.at(-1) ?? "";
    const toolMessages = messages.filter((message) => message.role === "tool");
    const allText = messages
      .map((message) => textOf(message.content))
      .join("\n");
    requests.push({
      authOk,
      model: body.model,
      stream: body.stream === true,
      userTexts,
      roles: messages.map((message) => message.role),
      toolMessageCount: toolMessages.length,
      requestedToolNames: Array.isArray(body.tools)
        ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
        : [],
    });

    if (!authOk) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "qualification credential rejected" },
        }),
      );
      return;
    }
    if (lastUser.includes("[http-error]")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "qualification protocol failure" },
        }),
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const id = `qualification-${++requestSequence}`;

    if (allText.includes("SCOPEGUARD_COMPACT_SUMMARY")) {
      await sendText(res, id, "QUALIFICATION_COMPACTION_SUMMARY");
      return;
    }

    if (messages.at(-1)?.role === "tool") {
      await sendText(
        res,
        id,
        `tool-result-observed:${lastUser.includes("[tool-error]") ? "error" : "success"}`,
      );
      return;
    }

    if (lastUser.includes("[tool-success]")) {
      sendToolCall(
        res,
        id,
        "bash",
        {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('tool-ok')"`,
        },
        "call-tool-success",
      );
      return;
    }
    if (lastUser.includes("[tool-error]")) {
      sendToolCall(
        res,
        id,
        "read",
        { path: "definitely-missing.txt" },
        "call-tool-error",
      );
      return;
    }
    if (lastUser.includes("[interrupt-effect]")) {
      sendToolCall(
        res,
        id,
        "bash",
        {
          command: `${JSON.stringify(process.execPath)} -e "const fs=require('fs');fs.writeFileSync('effect-marker.txt','started');setTimeout(()=>fs.appendFileSync('effect-marker.txt','|done'),5000)"`,
        },
        "call-interrupt-effect",
      );
      return;
    }
    const approvalMatch = lastUser.match(/\[approval:([a-z-]+)\]/);
    if (approvalMatch) {
      const scenario = approvalMatch[1];
      const target = `approval-${scenario}.txt`;
      sendToolCall(
        res,
        id,
        "bash",
        {
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('${target}','executed')" # SCOPEGUARD_APPROVAL:${scenario}`,
        },
        `call-approval-${scenario}`,
      );
      return;
    }
    if (lastUser.includes("[slow-text]")) {
      await sendText(res, id, `slow-complete:${lastUser}`, 35);
      return;
    }
    if (lastUser.includes("[resume-check]")) {
      await sendText(
        res,
        id,
        userTexts.some((text) => text.includes("[persist-marker]"))
          ? "resume-ok"
          : "resume-missing-history",
      );
      return;
    }
    if (lastUser.includes("[long-context]")) {
      await sendText(res, id, `long-context:${"x".repeat(6_000)}`);
      return;
    }
    if (lastUser.includes("[after-compaction]")) {
      await sendText(
        res,
        id,
        allText.includes("QUALIFICATION_COMPACTION_SUMMARY")
          ? "after-compaction-ok"
          : "after-compaction-summary-missing",
      );
      return;
    }
    await sendText(res, id, `echo:${lastUser}`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    isListening: () => server.listening,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
