import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { root, host, jiti, fixtureSettings } from "./test-helpers.mjs";

const agentDir = await mkdtemp(resolve(tmpdir(), "pi-voice-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await writeFile(resolve(agentDir, "pi-voice.json"), JSON.stringify(fixtureSettings));
const { loadExtensions } = await import(pathToFileURL(resolve(host, "dist/core/extensions/loader.js")));
const loaded = await loadExtensions([resolve(root, "index.ts")], root);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.equal(extension.tools.size, 0, "must never register agent tools");
assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
assert.deepEqual([...extension.commands.keys()].sort(), [
  "transcribe", "voice", ...(process.env.PI_VOICE_DEBUG === "1" ? ["voice-onboarding"] : []), "voice-settings",
].sort());
assert.equal(extension.shortcuts.size, 1);
const settings = fixtureSettings;
assert.ok(extension.shortcuts.has(settings.shortcut));
for (const name of await readdir(resolve(root, "src"))) {
  if (!name.endsWith(".ts")) continue;
  const source = await readFile(resolve(root, "src", name), "utf8");
  assert.doesNotMatch(source, /\bregisterTool\s*\(|\bpromptGuidelines\s*:|\bpromptSnippet\s*:|\btranscribe_file\b/, name);
  assert.doesNotMatch(source, /\b(?:pi|this\.pi)\.(?:sendMessage|sendUserMessage|appendEntry|setActiveTools)\s*\(/, name);
}

const { DictationController } = await jiti.import(resolve(root, "src/dictation-controller.ts"));
let sinks;
let stops = 0;
let submissions = 0;
let cancellations = 0;
const fed = [];
const audio = new Float32Array(16000).fill(0.125);
const service = {
  reserveDictation(configured) {
    assert.equal(configured, settings);
    return {
      ready: Promise.resolve(),
      feed(chunk) { fed.push(chunk); },
      async submit(pcm) {
        submissions++;
        assert.deepEqual(pcm, audio);
        return { text: "你好，语音输入测试。" };
      },
      cancel() { cancellations++; },
    };
  },
};
const controller = new DictationController(service, {
  async openCapture(_microphone, callbacks) {
    sinks = callbacks;
    return { async stop() { stops++; return { pcm: audio }; } };
  },
});
await controller.start(settings);
assert.equal(controller.state.phase, "listening");
sinks.onAudio(audio);
assert.ok(fed.length > 0, "audio must be fed during recording");
const result = await controller.stop();
assert.equal(result.text, "你好，语音输入测试。");
assert.equal(controller.state.phase, "result");
assert.equal(submissions, 1);
await controller.start(settings);
sinks.onAudio(audio);
await controller.cancel();
assert.equal(submissions, 1, "discarded recording must never be submitted");
assert.equal(cancellations, 1);
assert.equal(stops, 2);
await controller.dispose();
await rm(agentDir, { recursive: true, force: true });
console.log("PASS: zero tools, no model hooks, commands/shortcut retained, dictation start/stream-feed/stop/cancel preserved");
