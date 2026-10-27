#!/usr/bin/env node
// Mock Vinput streaming ASR provider for scripts/test-cloud.mjs.
//
// Protocol: stdin JSONL {type:"audio",audio_base64,commit} / {type:"finish"} /
// {type:"cancel"}; stdout JSONL session_started / partial / final / error /
// closed. Modes reproduce provider failures the bridge must survive.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const options = { mode: "stream", report: "", delay: 0, partials: true };
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
  if (!match) continue;
  const [, name, value = "true"] = match;
  if (name === "mode") options.mode = value;
  else if (name === "report") options.report = value;
  else if (name === "delay") options.delay = Number(value);
  else if (name === "partials") options.partials = value !== "false";
}

const report = {
  mode: options.mode,
  spawned: true,
  audioMessages: 0,
  audioBytes: 0,
  firstSamples: [],
  streamingBeforeFinish: false,
  finishReceived: false,
  finals: 0,
  partials: 0,
  cancelled: false,
  error: undefined,
};

let text = "";
let finished = false;
let exiting = false;

function writeReport() {
  if (!options.report || exiting) return;
  exiting = true;
  try {
    writeFileSync(options.report, JSON.stringify(report));
  } catch {
    // The test reports a missing file if this fails.
  }
}

function emit(event) {
  if (report.cancelled) return;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function exit(code = 0) {
  writeReport();
  process.exit(code);
}

function partialForAudio() {
  // Cumulative interim hypotheses, like a real streaming provider.
  text += "字";
  report.partials++;
  if (options.partials) emit({ type: "partial", text });
}

function start() {
  if (options.mode === "early-exit") exit(2);
  if (options.mode === "startup-timeout") {
    // Never announce a session; stay alive until the bridge gives up.
    setInterval(() => undefined, 1000);
    return;
  }
  if (options.mode === "error-before-start") {
    emit({ type: "error", message: "mock provider failed before start" });
    return exit(1);
  }
  if (options.mode === "ignore-stdin") {
    // Never read stdin: the bridge's bounded queue must fail the take.
    emit({ type: "session_started", session_id: "mock" });
    setInterval(() => undefined, 1000);
    return;
  }

  const announce = () => {
    if (options.mode === "final-before-finish") {
      // A final for audio the user is still recording must never be submitted.
      // One write keeps it in the same stdout chunk as session_started, so the
      // bridge always sees the premature final before submit can send finish.
      report.finals++;
      const events = [
        { type: "session_started", session_id: "mock" },
        { type: "final", text: "premature" },
      ].map((event) => `${JSON.stringify(event)}\n`).join("");
      process.stdout.write(events, () => exit(0));
      return;
    }
    emit({ type: "session_started", session_id: "mock" });
    if (options.mode === "error-after-start") {
      emit({ type: "error", message: "mock provider failure" });
      return exit(1);
    }
    if (options.mode === "exit-after-start") {
      // Die while the bridge is still writing audio: stdin closes under it.
      setTimeout(() => exit(3), 50);
      return;
    }
    readStdin();
  };
  if (options.delay > 0) setTimeout(announce, options.delay);
  else announce();
}

function readStdin() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim() || report.cancelled) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      emit({ type: "error", message: "invalid JSON input" });
      return exit(1);
    }
    if (message.type === "cancel") {
      report.cancelled = true;
      writeReport();
      return exit(0);
    }
    if (message.type === "finish") {
      report.finishReceived = true;
      report.streamingBeforeFinish = report.audioMessages > 0;
      finished = true;
      if (options.mode === "exit-without-final") return exit(0);
      if (options.mode === "no-final") {
        // Keep the process alive until the bridge's finish timeout.
        setInterval(() => undefined, 1000);
        return;
      }
      if (options.mode === "slow-final") {
        setTimeout(emitFinal, options.delay || 500);
        return;
      }
      return emitFinal();
    }
    if (message.type !== "audio") {
      emit({ type: "error", message: `unknown input ${message.type}` });
      return exit(1);
    }
    const pcm = Buffer.from(message.audio_base64 ?? "", "base64");
    report.audioMessages++;
    report.audioBytes += pcm.byteLength;
    if (report.firstSamples.length < 6) {
      for (let offset = 0; offset + 1 < pcm.byteLength && report.firstSamples.length < 6; offset += 2) {
        report.firstSamples.push(pcm.readInt16LE(offset));
      }
    }
    partialForAudio();
  });
  lines.on("close", () => {
    if (!finished && !report.cancelled) {
      // EOF without finish is an abort, never a request to submit text.
      report.cancelled = true;
      writeReport();
      process.exit(0);
    }
  });
}

function emitFinal() {
  if (report.cancelled || report.finals > 0) return;
  if (options.mode === "short-final") {
    // WeType's polished final can lose sentences; the last partial is whole.
    const long = "这是一段完整的实时转写结果，包含很多句子，不应该被最终稿截断。";
    report.partials++;
    emit({ type: "partial", text: long });
    report.finals++;
    emit({ type: "final", text: "这是一段完整。" });
  } else if (options.mode === "slow-convert") {
    // A large final keeps the bridge's Chinese conversion busy; the marker
    // tells the test the final is on the wire so it can cancel meanwhile.
    report.finals++;
    writeFileSync(options.report.replace(/\.json$/, ".final"), "final");
    emit({ type: "final", text: "这".repeat(2_000_000) });
  } else if (options.mode === "final-no-newline") {
    report.finals++;
    process.stdout.write(JSON.stringify({ type: "final", text }));
  } else {
    report.finals++;
    emit({ type: "final", text });
  }
  if (options.mode !== "final-no-newline") emit({ type: "closed" });
  writeReport();
  process.exit(0);
}

process.on("SIGTERM", () => {
  writeReport();
  process.exit(143);
});
process.on("SIGINT", () => {
  writeReport();
  process.exit(130);
});

start();
