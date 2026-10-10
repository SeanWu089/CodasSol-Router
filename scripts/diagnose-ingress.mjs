#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { probeIngress, summarizeNgrokLog } from "../src/ingress/ingress-diagnostics.js";

async function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, item, index, list) => {
    if (item.startsWith("--") && list[index + 1] &&
        !list[index + 1].startsWith("--")) {
      pairs.push([item, list[index + 1]]);
    }
    return pairs;
  }, []));
  const publicUrl = args["--public-url"];
  if (!publicUrl) {
    throw new Error("Provide --public-url https://YOUR-FIXED-DOMAIN (no credentials)");
  }
  const result = await probeIngress({
    publicUrl,
    localRouterUrl: args["--router-url"],
    agentApiUrl: args["--agent-api"]
  });
  if (args["--agent-log"]) {
    // Read only the recent tail to avoid dumping huge/older secret-bearing logs.
    const content = await readFile(args["--agent-log"], "utf8");
    result.agentLog = summarizeNgrokLog(content, {
      windowMs: Number(args["--window-minutes"] || 60) * 60_000
    });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.fullyHealthy) process.exitCode = 2;
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write("Ingress diagnostics failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
