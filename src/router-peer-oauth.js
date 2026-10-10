import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DevSpaceLocalOAuth } from "./devspace-local-auth.js";

// Peer requests must authenticate to DevSpace using the receiving node's own
// locally stored OAuth credentials, never the sender's client bearer token.
export async function createRouterPeerOAuth(config, stateDir) {
  const file = path.join(stateDir, "peer-oauth.json");
  let oauthState = {};
  try {
    oauthState = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return new DevSpaceLocalOAuth({
    baseUrl: `http://${config.backendHost}:${config.backendPort}`,
    oauthState,
    saveOAuthState: async (updated) => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
      await rename(temp, file);
    }
  });
}
