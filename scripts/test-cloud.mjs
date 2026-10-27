import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fixtureSettings, jiti, root } from "./test-helpers.mjs";

// The bridge owns provider processes and deferred promises; a regression there
// shows up as an unhandled rejection long after the failing assertion.
const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const { CloudTranscriptionService } = await jiti.import(resolve(root, "src/cloud-transcription.ts"));
const mock = resolve(root, "scripts/fixtures/mock-provider.mjs");
const directory = await mkdtemp(resolve(tmpdir(), "pi-voice-cloud-"));
let reportId = 0;

function settingsFor(backend, overrides = {}) {
  return {
    ...fixtureSettings,
    ...overrides,
    backend: { type: backend },
    transcriptionLanguage: "zh",
    preferredLanguages: ["zh"],
    chineseOutput: "simplified",
  };
}

function providerFor(mode, extra = []) {
  const report = resolve(directory, `report-${++reportId}.json`);
  const args = [mock, `--mode=${mode}`, `--report=${report}`, ...extra];
  return { report, command: async () => ({ command: process.execPath, args }) };
}

function serviceFor(command, onPartial, options = {}) {
  return new CloudTranscriptionService(command, onPartial, {
    startupTimeoutMs: 3000,
    finishTimeoutMs: 3000,
    ...options,
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  assert.fail(message);
}

async function readReport(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function waitForReport(path) {
  let report;
  await waitFor(async () => (report = await readReport(path)) !== undefined, `missing mock report ${path}`);
  return report;
}

/** Keeps a rejection observed while the test waits for a side effect. */
function rejectionOf(promise) {
  return promise.then(
    () => assert.fail("expected a rejection"),
    (error) => error,
  );
}

// --- 1. Streaming audio, cumulative partials, one final, PCM conversion -----
{
  const { report, command } = providerFor("stream", ["--delay=80"]);
  const partials = [];
  let commandCalls = 0;
  const service = serviceFor(async (settings) => {
    commandCalls++;
    assert.equal(settings.backend.type, "doubaoime");
    return command();
  }, (text) => partials.push(text));

  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  assert.throws(() => service.reserveDictation(settingsFor("doubaoime")), /already active/);
  reservation.feed(new Float32Array([Number.NaN, 1.5, -1.5, 0.25]));
  reservation.feed(new Float32Array([0, -0.5]));
  // Submitted before session_started: finish must wait for the session, while
  // the audio already sent keeps streaming.
  const submitted = reservation.submit(new Float32Array(16_000).fill(0.9));
  const result = await submitted;
  assert.equal(result.text, "字字");
  assert.equal(result.warning, undefined);
  assert.deepEqual(partials, ["字", "字字"], "partials arrive while recording");
  assert.equal(commandCalls, 1, "never retries or falls back to another provider");

  const written = await waitForReport(report);
  assert.equal(written.finishReceived, true);
  assert.equal(written.streamingBeforeFinish, true, "audio must arrive before finish");
  assert.equal(written.audioMessages, 2, "submit must not resend the whole recording");
  assert.equal(written.audioBytes, 12, "only the streamed chunks reach the provider");
  assert.deepEqual(written.firstSamples, [0, 32767, -32768, 8192, 0, -16384],
    "NaN is silence and out-of-range samples clamp to PCM16");
  assert.equal(written.finals, 1);
  assert.equal(written.partials, 2);

  reservation.feed(new Float32Array([0.1]));
  await sleep(30);
  assert.equal((await readReport(report)).audioMessages, 2, "feed after submit is ignored");
  await service.shutdown();
}

// --- 2. Chinese conversion on the final (and partials stay untouched) ------
{
  const { command } = providerFor("stream");
  const partials = [];
  const service = serviceFor(command, (text) => partials.push(text));
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  const result = await reservation.submit(new Float32Array());
  // The mock's final is "字" in both scripts; conversion is applied to finals.
  assert.equal(result.text, "字");
  assert.deepEqual(partials, ["字"]);
  await service.shutdown();
}

// --- 3. Cancel while commandFor is still resolving -------------------------
{
  let resolveCommand;
  let commandRequested;
  const requested = new Promise((done) => { commandRequested = done; });
  const service = serviceFor(async () => {
    commandRequested();
    await new Promise((done) => { resolveCommand = done; });
    return { command: process.execPath, args: [mock, "--mode=stream"] };
  });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  const ready = rejectionOf(reservation.ready);
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  await requested;
  reservation.cancel();
  assert.match((await ready).message, /cancelled/i);
  assert.match((await submitted).message, /cancelled/i);
  resolveCommand();
  await sleep(80);
  await service.shutdown();
}

// --- 3b. Cancel synchronously before commandFor is even called ------------
{
  let calls = 0;
  const service = serviceFor(async () => {
    calls++;
    return { command: process.execPath, args: [mock, "--mode=stream"] };
  });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  const ready = rejectionOf(reservation.ready);
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  reservation.cancel();
  assert.match((await ready).message, /cancelled/i);
  assert.match((await submitted).message, /cancelled/i);
  await sleep(50);
  assert.equal(calls, 0, "a take cancelled before startup never launches a provider");
  await service.shutdown();
}

// --- 3c. Provider dying mid-recording (stdin EPIPE / early exit) -----------
{
  const { command } = providerFor("exit-after-start");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  for (let index = 0; index < 8; index++) {
    reservation.feed(new Float32Array(16_000).fill(0.2));
    await sleep(15);
  }
  assert.match((await rejectionOf(reservation.submit(new Float32Array()))).message,
    /exited before returning a final|stdin is closed|EPIPE|closed before/i);
  await service.shutdown();
}

// --- 4. Cancel during provider startup, then the lane is reusable ----------
{
  const { report, command } = providerFor("startup-timeout");
  const partials = [];
  const service = serviceFor(command, (text) => partials.push(text));
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  const ready = rejectionOf(reservation.ready);
  await sleep(120); // provider is running but has not announced a session
  reservation.cancel();
  assert.match((await ready).message, /cancelled/i);
  assert.deepEqual(partials, []);
  const stopped = await waitForReport(report);
  assert.equal(stopped.cancelled, false, "SIGTERM cleanup is reported");

  const next = providerFor("stream");
  const nextService = serviceFor(next.command, (text) => partials.push(text));
  const nextReservation = nextService.reserveDictation(settingsFor("doubaoime"));
  await nextReservation.ready;
  nextReservation.feed(new Float32Array([0.1]));
  assert.equal((await nextReservation.submit(new Float32Array())).text, "字");
  assert.deepEqual(partials, ["字"], "no partial may arrive after cancellation");
  await nextService.shutdown();
  await service.shutdown();
}

// --- 5. Cancel mid-stream and via AbortSignal ------------------------------
{
  const { report, command } = providerFor("stream");
  const partials = [];
  const service = serviceFor(command, (text) => partials.push(text));
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  await sleep(50); // let the audio reach the provider
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  reservation.cancel();
  assert.match((await submitted).message, /cancelled/i);
  const stopped = await waitForReport(report);
  assert.equal(stopped.cancelled, true);
  assert.deepEqual(partials, ["字"]);
  await service.shutdown();

  const { report: abortReport, command: abortCommand } = providerFor("stream");
  const abortService = serviceFor(abortCommand);
  const aborted = abortService.reserveDictation(settingsFor("doubaoime"));
  await aborted.ready;
  aborted.feed(new Float32Array([0.1]));
  const controller = new AbortController();
  const result = rejectionOf(aborted.submit(new Float32Array(), controller.signal));
  controller.abort(new Error("user cancelled"));
  assert.match((await result).message, /user cancelled/);
  await waitForReport(abortReport);
  await abortService.shutdown();
}

// --- 6. commandFor failure rejects the reservation -------------------------
{
  const service = serviceFor(async () => {
    throw new Error("provider command unavailable");
  });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  const ready = rejectionOf(reservation.ready);
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  assert.match((await ready).message, /command unavailable/);
  assert.match((await submitted).message, /command unavailable/);
  await service.shutdown();
}

// --- 7. spawn error --------------------------------------------------------
{
  const service = serviceFor(async () => ({
    command: resolve(directory, "definitely-not-a-provider"),
    args: [],
  }));
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  assert.match((await rejectionOf(reservation.ready)).message, /ENOENT|spawn/i);
  assert.match((await rejectionOf(reservation.submit(new Float32Array()))).message, /ENOENT|spawn/i);
  await service.shutdown();
}

// --- 8. Provider exits before session_started ------------------------------
{
  const { report, command } = providerFor("early-exit");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  const ready = rejectionOf(reservation.ready);
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  assert.match((await ready).message, /before the session started/);
  assert.match((await submitted).message, /before the session started/);
  assert.equal((await waitForReport(report)).spawned, true);
  await service.shutdown();
}

// --- 9. Provider error event ----------------------------------------------
{
  const { command } = providerFor("error-after-start");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  const result = rejectionOf(reservation.submit(new Float32Array()));
  assert.match((await result).message, /mock provider failure/);
  await service.shutdown();
}

// --- 10. A final before finish is never accepted ---------------------------
{
  const { report, command } = providerFor("final-before-finish");
  const partials = [];
  const service = serviceFor(command, (text) => partials.push(text));
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  const result = rejectionOf(reservation.submit(new Float32Array()));
  assert.match((await result).message, /before finish/);
  assert.deepEqual(partials, []);
  assert.equal((await waitForReport(report)).finals, 1);
  await service.shutdown();
}

// --- 11. Startup timeout ---------------------------------------------------
{
  const { report, command } = providerFor("startup-timeout");
  const service = serviceFor(command, undefined, { startupTimeoutMs: 150 });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  assert.match((await rejectionOf(reservation.ready)).message, /did not start within 150 ms/);
  assert.match((await rejectionOf(reservation.submit(new Float32Array()))).message, /did not start/);
  await waitForReport(report); // SIGTERM reached the provider
  await service.shutdown();
}

// --- 12. Finish timeout, and exit/closed without a final --------------------
{
  const { report, command } = providerFor("no-final");
  const service = serviceFor(command, undefined, { finishTimeoutMs: 150 });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  assert.match((await rejectionOf(reservation.submit(new Float32Array()))).message,
    /did not return a final transcript within 150 ms/);
  assert.equal((await waitForReport(report)).finishReceived, true);
  await service.shutdown();

  const { command: exitCommand } = providerFor("exit-without-final");
  const exitService = serviceFor(exitCommand);
  const exitReservation = exitService.reserveDictation(settingsFor("doubaoime"));
  await exitReservation.ready;
  exitReservation.feed(new Float32Array([0.1]));
  assert.match((await rejectionOf(exitReservation.submit(new Float32Array()))).message,
    /closed before returning a final|exited before returning a final/);
  await exitService.shutdown();
}

// --- 12b. A final on the last line without a trailing newline still counts --
{
  const { command } = providerFor("final-no-newline");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  assert.equal((await reservation.submit(new Float32Array())).text, "字");
  await service.shutdown();
}

// --- 13. WeType's truncated polished final falls back to the last partial --
{
  const { report, command } = providerFor("short-final");
  const partials = [];
  const service = serviceFor(command, (text) => partials.push(text));
  const reservation = service.reserveDictation(settingsFor("wetype"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  const result = await reservation.submit(new Float32Array());
  assert.equal(result.text, "这是一段完整的实时转写结果，包含很多句子，不应该被最终稿截断。");
  assert.match(result.warning ?? "", /最终稿明显短于实时结果/);
  assert.deepEqual(partials, ["字", result.text], "the live partials are shown unchanged");
  assert.equal((await waitForReport(report)).finals, 1);
  await service.shutdown();
}

// --- 14. Other backends keep their own final -------------------------------
{
  const { command } = providerFor("short-final");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  const result = await reservation.submit(new Float32Array());
  assert.equal(result.text, "这是一段完整。");
  assert.equal(result.warning, undefined);
  await service.shutdown();
}

// --- 15. Cancelling while a final is still being converted rejects ---------
{
  const { report, command } = providerFor("slow-convert");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("wetype"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  // The mock writes this marker the instant it emits its final, before the
  // bridge starts converting it; cancelling then must still win.
  const marker = report.replace(/\.json$/, ".final");
  await waitFor(async () => {
    try {
      await readFile(marker);
      return true;
    } catch {
      return false;
    }
  }, "mock final marker");
  reservation.cancel();
  assert.match((await submitted).message, /cancelled/i);
  await service.shutdown();
}

// --- 16. A throwing onPartial callback cannot break the take ---------------
{
  const { command } = providerFor("stream");
  const service = serviceFor(command, () => { throw new Error("ui failure"); });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  reservation.feed(new Float32Array([0.1]));
  assert.equal((await reservation.submit(new Float32Array())).text, "字");
  await service.shutdown();
}

// --- 17. Stdin backpressure is bounded ------------------------------------
{
  const { report, command } = providerFor("ignore-stdin");
  const service = serviceFor(command, undefined, { startupTimeoutMs: 1000, finishTimeoutMs: 1000 });
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  await reservation.ready;
  // A provider that never reads fills the OS pipe and then this bridge's
  // bounded queue; ~3.5 MB of audio is far past the 1 MB limit.
  for (let index = 0; index < 40; index++) {
    reservation.feed(new Float32Array(32_768).fill(0.1));
    if (index % 4 === 3) await sleep(5);
  }
  const result = rejectionOf(reservation.submit(new Float32Array()));
  assert.match((await result).message, /stdin limit|stopped reading/);
  await waitForReport(report);
  await service.shutdown();
}

// --- 18. shutdown rejects the active take and refuses new ones -------------
{
  const { command } = providerFor("startup-timeout");
  const service = serviceFor(command);
  const reservation = service.reserveDictation(settingsFor("doubaoime"));
  const ready = rejectionOf(reservation.ready);
  const submitted = rejectionOf(reservation.submit(new Float32Array()));
  const shutdown = service.shutdown();
  assert.match((await ready).message, /shutting down/);
  assert.match((await submitted).message, /shutting down/);
  await shutdown;
  assert.throws(() => service.reserveDictation(settingsFor("doubaoime")), /shutting down/);
}

await sleep(50);
assert.deepEqual(unhandled, [], "the service must not leave unhandled rejections");
await rm(directory, { recursive: true, force: true });
console.log("PASS: cloud JSONL bridge streams PCM, handles cancel/errors/timeouts, never submits early or after cancel, and falls back from WeType's truncated final");
