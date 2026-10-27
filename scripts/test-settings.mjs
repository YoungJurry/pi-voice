import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { jiti, root, fixtureSettings } from "./test-helpers.mjs";

const directory = await mkdtemp(resolve(tmpdir(), "pi-voice-settings-"));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_VOICE_PROVIDER_DIR = resolve(directory, "providers");
const settingsModule = await jiti.import(resolve(root, "src/settings.ts"));
const { validateSettings, settingsForCloud, readSettings, writeSettings } = settingsModule;
assert.deepEqual(validateSettings(fixtureSettings), fixtureSettings);
for (const provider of ["doubaoime", "wetype"]) {
  const fresh = settingsForCloud(provider);
  assert.equal(fresh.model.path, "");
  assert.equal(validateSettings(fresh).backend.type, provider);
  const switched = settingsForCloud(provider, fixtureSettings);
  assert.equal(switched.model.path, fixtureSettings.model.path);
  assert.equal(switched.shortcut, fixtureSettings.shortcut);
  assert.equal(switched.chineseOutput, fixtureSettings.chineseOutput);
  await writeSettings(switched);
  assert.deepEqual((await readSettings()).settings, switched);
}
assert.equal(validateSettings({ ...fixtureSettings, backend: { type: "unknown" } }), undefined);
assert.equal(validateSettings({ ...fixtureSettings, model: { ...fixtureSettings.model, path: "" } }), undefined);

const providers = await jiti.import(resolve(root, "src/cloud-providers.ts"));
assert.throws(() => providers.verifyProviderSource("wetype", Buffer.from("tampered script")), /校验失败/);
assert.equal(await providers.hasVerifiedProvider("wetype"), false);
await mkdir(process.env.PI_VOICE_PROVIDER_DIR, { recursive: true });
await writeFile(providers.cloudProviderPath("wetype"), "tampered");
assert.equal(await providers.hasVerifiedProvider("wetype"), false);
await assert.rejects(() => providers.cloudProviderCommand(settingsForCloud("wetype")), /校验失败/);

// Cancelled consent must not download scripts, save settings or change mode.
let confirmations = 0;
const selected = await providers.chooseSpeechBackend({
  mode: "tui", ui: {
    select: async () => providers.CLOUD_PROVIDERS.doubaoime.name,
    confirm: async () => { confirmations++; return false; },
    notify: () => assert.fail("cancel must be silent"),
  },
}, fixtureSettings);
assert.equal(selected, undefined);
assert.equal(confirmations, 1);
const local = await providers.chooseSpeechBackend({ mode: "tui", ui: {
  select: async (_title, choices) => choices[0],
  confirm: () => assert.fail("local must not need cloud consent"),
} }, settingsForCloud("wetype", fixtureSettings));
assert.equal(local.backend.type, "transcribe-cpp");
assert.equal(local.model.path, fixtureSettings.model.path);

// The persisted configuration contains no provider credentials or user secrets.
const saved = JSON.parse(await readFile(resolve(directory, "pi-voice.json"), "utf8"));
assert.equal(saved.backend.type, "wetype");
await rm(directory, { recursive: true, force: true });
console.log("PASS: legacy settings, cloud round trips, local restoration, script integrity, explicit consent");
