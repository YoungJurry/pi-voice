// Explicit opt-in integration probe. Uploads only the WAV supplied by the caller.
// Uses an ephemeral provider/identity directory; never reads user settings.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { jiti, root, fixtureSettings } from "./test-helpers.mjs";

const [flag, provider, filename] = process.argv.slice(2);
if (flag !== "--upload-test-audio" || !["doubaoime", "wetype"].includes(provider) || !filename) {
  console.error("Usage: node scripts/smoke-cloud.mjs --upload-test-audio <doubaoime|wetype> <16k-mono-pcm16.wav>");
  process.exit(2);
}
const wav = await readFile(filename);
assert.equal(wav.toString("ascii", 0, 4), "RIFF");
assert.equal(wav.toString("ascii", 8, 12), "WAVE");
let pcm;
let format;
for (let i = 12; i + 8 <= wav.length;) {
  const tag = wav.toString("ascii", i, i + 4);
  const size = wav.readUInt32LE(i + 4);
  const start = i + 8;
  assert.ok(start + size <= wav.length);
  if (tag === "fmt ") format = wav.subarray(start, start + size);
  if (tag === "data") pcm = wav.subarray(start, start + size);
  i = start + size + (size & 1);
}
assert.ok(format && pcm);
assert.equal(format.readUInt16LE(0), 1, "PCM WAV required");
assert.equal(format.readUInt16LE(2), 1, "mono required");
assert.equal(format.readUInt32LE(4), 16000, "16kHz required");
assert.equal(format.readUInt16LE(14), 16, "16-bit PCM required");
assert.ok(pcm.length <= 16000 * 2 * 120, "probe is limited to 120 seconds");
const directory = await mkdtemp(resolve(tmpdir(), "pi-voice-live-"));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_VOICE_PROVIDER_DIR = resolve(directory, "providers");
const { CloudTranscriptionService } = await jiti.import(resolve(root, "src/cloud-transcription.ts"));
const { installCloudProvider, checkCloudRuntime, cloudProviderCommand } = await jiti.import(resolve(root, "src/cloud-providers.ts"));
let firstPartial;
let partials = 0;
let submitted = false;
const service = new CloudTranscriptionService(cloudProviderCommand, () => {
  partials++;
  if (!submitted) firstPartial ??= performance.now();
});
try {
  await checkCloudRuntime();
  await installCloudProvider(provider);
  const start = performance.now();
  const take = service.reserveDictation({ ...fixtureSettings, backend: { type: provider } });
  await take.ready;
  const readyMs = Math.round(performance.now() - start);
  for (let offset = 0; offset < pcm.length; offset += 3840) {
    const data = pcm.subarray(offset, Math.min(offset + 3840, pcm.length));
    const samples = new Float32Array(data.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
    take.feed(samples);
    await sleep(samples.length / 16);
  }
  submitted = true;
  const finishStart = performance.now();
  const result = await take.submit(new Float32Array());
  const finishMs = Math.round(performance.now() - finishStart);
  assert.ok(firstPartial, "must receive a partial while audio is still being streamed");
  assert.ok(result.text.length, "must return a nonempty final transcript");
  console.log(JSON.stringify({ provider, seconds: pcm.length / 32000, readyMs,
    firstPartialMs: Math.round(firstPartial - start), partials, finishMs,
    finalCharacters: result.text.length, warning: result.warning,
    expectedChineseSample: result.text.includes("今天天气不错") && result.text.includes("公园散步"),
  }));
} finally {
  await service.shutdown();
  await rm(directory, { recursive: true, force: true });
}
