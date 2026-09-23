import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultAgentConfigPath() {
  return process.env.CODASSOL_AGENT_CONFIG ||
    path.join(os.homedir(), ".codassol", "agent.json");
}

export class AgentConfigStore {
  constructor(filePath = defaultAgentConfigPath()) {
    this.filePath = filePath;
    this.value = null;
  }

  async load() {
    const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    if (parsed?.version !== 1) {
      throw new Error("Unsupported CodasSol Agent config format");
    }
    this.value = parsed;
    return structuredClone(parsed);
  }

  async save(value) {
    const next = {
      version: 1,
      ...value
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
    this.value = next;
    return structuredClone(next);
  }
}

