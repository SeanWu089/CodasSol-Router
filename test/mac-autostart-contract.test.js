import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("macOS autostart uses durable Node executable and retries launchd registration", async () => {
  const installer = await readFile("scripts/mac/install-autostart.sh", "utf8");
  assert.match(installer, /node -p 'process\.execPath'/);
  assert.match(installer, /BOOTSTRAPPED=false/);
  assert.match(installer, /for _ in \{1\.\.8\}/);
  assert.match(installer, /launchctl bootstrap "gui\/\$UID_VALUE" "\$PLIST_PATH"/);
});
