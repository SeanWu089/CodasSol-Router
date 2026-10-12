// Local-only, read-only Windows end-to-end diagnostic (except transient
// DevSpace OAuth client registration). Never prints private credentials.
import path from "node:path";
import { pathToFileURL } from "node:url";

const profile = process.env.USERPROFILE;
const localData = process.env.LOCALAPPDATA;
if (!profile || !localData) throw new Error("Windows USERPROFILE/LOCALAPPDATA required");
const root = path.join(localData, "CodasSol", "NodeV02Standalone");
const { DevSpaceLocalOAuth } = await import(
  pathToFileURL(path.join(root, "app", "devspace-local-auth.js")).href
);
const client = new DevSpaceLocalOAuth({
  baseUrl: "http://127.0.0.1:7676",
  ownerTokenPath: path.join(profile, ".devspace", "auth.json")
});
const token = await client.accessToken();

let rpcId = 0;
async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: ++rpcId, method };
  if (params) body.params = params;
  const response = await fetch("http://127.0.0.1:17678/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  const payload = await response.text();
  let value = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") || /^\s*(event:|data:)/.test(payload)) {
    // Streamable HTTP MCP may send a tools/call response as an SSE message.
    // Ignore progress/notification events and take the matching JSON-RPC ID.
    for (const line of payload.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (event.id === body.id) value = event;
      } catch { /* comments or non-JSON progress are not RPC responses */ }
    }
  } else {
    try { value = JSON.parse(payload); } catch { /* reported below */ }
  }
  if (!response.ok || !value || value.error || value.result?.isError) {
    const text = (value?.result?.content || [])
      .map((item) => typeof item.text === "string" ? item.text : "")
      .join(" ")
      .slice(0, 500);
    const detail = text || JSON.stringify(value?.error || value?.result ||
      { contentType, snippet: payload.slice(0, 180) }).slice(0, 700);
    throw new Error(`MCP ${method} failed: HTTP ${response.status}; ${detail}`);
  }
  return value.result;
}

const listing = await rpc("tools/list");
const names = (listing.tools || []).map((tool) => tool.name);
console.log("TOOLS=" + names.join(","));
if (!names.includes("open_workspace") || !names.includes("exec_command")) {
  throw new Error("Expected DevSpace tools absent from Windows Router");
}

const opened = await rpc("tools/call", {
  name: "open_workspace",
  arguments: { path: path.join(profile, "Desktop") }
});
const workspaceId = opened?.structuredContent?.workspace_id;
if (!workspaceId) throw new Error("open_workspace did not return a workspace_id");
console.log("WORKSPACE_OPENED=true");

const ran = await rpc("tools/call", {
  name: "exec_command",
  arguments: { workspace_id: workspaceId, cmd: "hostname" }
});
const structured = ran?.structuredContent;
const evidence = JSON.stringify(structured ?? ran?.content ?? {});
if (!evidence.toLowerCase().includes((process.env.COMPUTERNAME || "").toLowerCase())) {
  throw new Error("exec_command did not return the expected Windows hostname");
}
if (structured && structured.exit_code !== undefined && structured.exit_code !== 0) {
  throw new Error("exec_command returned a nonzero exit code");
}
console.log("EXEC_VERIFIED=" + process.env.COMPUTERNAME);
console.log("PASS: Windows Router -> DevSpace -> open_workspace -> exec_command");
