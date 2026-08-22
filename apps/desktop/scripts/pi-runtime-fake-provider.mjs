import http from "node:http";

export async function startPiRuntimeFakeProvider(expectedKey, options = {}) {
  const requests = [];
  let sequence = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTexts = messages
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content));
    requests.push({
      authorized: request.headers.authorization === `Bearer ${expectedKey}`,
      userTexts,
      roles: messages.map((message) => message.role),
    });
    if (request.headers.authorization !== `Bearer ${expectedKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid Pilot credential" } }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const id = `desktop-pilot-${++sequence}`;
    const text = `observed:${userTexts.join("|")}`;
    const latestPrompt = userTexts.at(-1) ?? "";
    if (options.phase4WorkflowScript && messages.at(-1)?.role === "tool") {
      send(response, id, { role: "assistant", content: "" });
      send(response, id, { content: "Agent file operation completed and validated." });
      send(response, id, {}, "stop");
      response.end("data: [DONE]\n\n");
      return;
    }
    if (options.phase4WorkflowScript && latestPrompt.includes("[phase4-file-v1]")) {
      sendToolCall(response, id, "bash", {
        command: phase4WorkflowCommand(
          options.phase4WorkflowScript,
          "create",
          "source-v1.docx",
          "agent-result-v1.docx",
        ),
      });
      return;
    }
    if (options.phase4WorkflowScript && latestPrompt.includes("[phase4-file-v2]")) {
      sendToolCall(response, id, "bash", {
        command: phase4WorkflowCommand(
          options.phase4WorkflowScript,
          "revise",
          "source-v2.docx",
          "agent-result-v2.docx",
          "agent-result-v1.docx",
        ),
      });
      return;
    }
    if (latestPrompt.includes("[phase3-slow]")) {
      if (!await waitForResponse(response, 5_000)) return;
    } else if (latestPrompt.includes("[phase3-parallel]")) {
      if (!await waitForResponse(response, 700)) return;
    }
    send(response, id, { role: "assistant", content: "" });
    send(response, id, { content: text });
    send(response, id, {}, "stop");
    send(response, id, {}, null, {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendToolCall(response, id, name, args) {
  const callId = `phase4-tool-${Date.now()}`;
  send(response, id, { role: "assistant", content: "" });
  send(response, id, {
    tool_calls: [{
      index: 0,
      id: callId,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
  send(response, id, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}

function phase4WorkflowCommand(scriptPath, mode, sourceName, outputName, previousName) {
  if (typeof scriptPath !== "string" || !scriptPath) {
    throw new Error("Phase 4 fake Provider requires a workflow script path.");
  }
  return [
    "node",
    JSON.stringify(scriptPath),
    mode,
    `inputs/${sourceName}`,
    ...(previousName ? [`reports/${previousName}`] : []),
    `reports/${outputName}`,
  ].join(" ");
}

function waitForResponse(response, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      response.removeListener("close", closed);
      resolve(true);
    }, milliseconds);
    const closed = () => {
      clearTimeout(timer);
      resolve(false);
    };
    response.once("close", closed);
  });
}

function send(response, id, delta, finishReason = null, usage) {
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: "desktop-pilot-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
}
