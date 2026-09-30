import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const [devspaceDir, configPath, rootsArg, agentConfigPath] = process.argv.slice(2);
if (!devspaceDir || !configPath || !rootsArg) {
  throw new Error(
    "Usage: configure-devspace-root.mjs <devspace-dir> <config-path> <root1|root2> [agent-config-path]"
  );
}

const requireFromDevSpace = createRequire(path.join(devspaceDir, "package.json"));
const { applyEdits, modify, parse } = requireFromDevSpace("jsonc-parser");

if (!existsSync(configPath)) {
  throw new Error(`DevSpace config does not exist: ${configPath}`);
}

const roots = rootsArg.split("|").map((value) => value.trim()).filter(Boolean);
if (!roots.length) throw new Error("At least one DevSpace allowed root is required.");

const source = readFileSync(configPath, "utf8");
const current = parse(source);
const existing = Array.isArray(current?.workspaces?.allowedRoots)
  ? current.workspaces.allowedRoots
  : [];
const normalized = (value) => String(value).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const unchanged = existing.length === roots.length &&
  existing.every((value, index) => normalized(value) === normalized(roots[index]));

if (!unchanged) {
  const updated = applyEdits(
    source,
    modify(source, ["workspaces", "allowedRoots"], roots, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
    })
  );
  writeFileSync(configPath, updated.endsWith("\n") ? updated : updated + "\n", "utf8");
  console.log("Updated DevSpace allowed roots:", roots.join(", "));
} else {
  console.log("DevSpace allowed roots already match CodasSol Agent roots.");
}

if (agentConfigPath) {
  if (!existsSync(agentConfigPath)) {
    throw new Error(`CodasSol Agent config does not exist: ${agentConfigPath}`);
  }
  const agentConfig = JSON.parse(readFileSync(agentConfigPath, "utf8"));
  if (!agentConfig.device || typeof agentConfig.device !== "object") {
    throw new Error("CodasSol Agent config has no device object.");
  }
  const agentRoots = Array.isArray(agentConfig.device.roots) ? agentConfig.device.roots : [];
  const agentUnchanged = agentRoots.length === roots.length &&
    agentRoots.every((value, index) => normalized(value) === normalized(roots[index]));
  if (!agentUnchanged) {
    agentConfig.device.roots = roots;
    const temporary = `${agentConfigPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(agentConfig, null, 2) + "\n", "utf8");
    renameSync(temporary, agentConfigPath);
    console.log("Updated CodasSol Agent advertised roots:", roots.join(", "));
  } else {
    console.log("CodasSol Agent advertised roots already match.");
  }
}
