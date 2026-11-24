// ), apps/server/src/provider/testFixtures/grok-text-mock-agent.mjs @ 13aa882c22.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "grok-text-session";
let currentModelId = "grok-mock-default";
const models = ["grok-mock-default", "grok-mock-alt"];
// The reasoning efforts each model's metadata offers, and the efforts set_model refuses.
const modelEfforts = JSON.parse(process.env.T3_GROK_MODEL_EFFORTS ?? "{}");
const refusedEfforts = (process.env.T3_GROK_REFUSED_EFFORTS ?? "").split(",").filter(Boolean);
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (process.env.T3_ACP_CWD_LOG_PATH) {
  NodeFS.writeFileSync(
    process.env.T3_ACP_CWD_LOG_PATH,
    JSON.stringify({ cwd: process.cwd(), entries: NodeFS.readdirSync(process.cwd()) }),
  );
}

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.T3_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
  }
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "grok", version: "mock" },
        agentCapabilities: {},
      };
      break;
    case "session/new":
      result = {
        sessionId,
        models: {
          currentModelId,
          availableModels: models.map((modelId) => ({
            modelId,
            name: modelId,
            ...(modelEfforts[modelId] === undefined
              ? {}
              : { _meta: { reasoningEfforts: modelEfforts[modelId].map((value) => ({ value })) } }),
          })),
        },
      };
      break;
    case "session/set_model":
      if (!models.includes(request.params.modelId)) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unknown Grok model" },
        });
        continue;
      }
      if (refusedEfforts.includes(request.params._meta?.reasoningEffort)) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unsupported reasoning effort for this model" },
        });
        continue;
      }
      currentModelId = request.params.modelId;
      result = {};
      break;
    case "session/prompt":
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.T3_ACP_PROMPT_RESPONSE_TEXT ?? "" },
          },
        },
      });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
