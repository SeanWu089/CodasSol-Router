import os from "node:os";
import { RouterPrivateState, defaultStateDir } from "./private-state.js";

function lanAddresses() {
  const results = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) results.push(entry.address);
    }
  }
  return [...new Set(results)];
}

const command = process.argv[2] || "help";
const state = new RouterPrivateState({ stateDir: defaultStateDir() });

if (command === "init") {
  await state.init();
  console.log(`CodasSol Router private state is ready in ${defaultStateDir()}`);
} else if (command === "pairing-token") {
  await state.init();
  console.log(state.pairingToken);
} else if (command === "agents") {
  await state.init();
  const agents = state.listAgents();
  if (!agents.length) {
    console.log("No enrolled Agents.");
  } else {
    for (const agent of agents) {
      console.log(`${agent.id}\t${agent.platform}\t${agent.label}`);
    }
  }
} else if (command === "lan") {
  const addresses = lanAddresses();
  if (!addresses.length) {
    console.log("No non-loopback IPv4 address found.");
  } else {
    for (const address of addresses) {
      console.log(`http://${address}:17676`);
    }
  }
} else {
  console.log([
    "CodasSol Router CLI",
    "",
    "  npm run router:init",
    "  npm run router:pairing-token",
    "  npm run router:agents",
    "  npm run router:lan"
  ].join("\n"));
}

