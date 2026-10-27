import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const host = process.env.PI_HOST_PACKAGE || resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
export const jiti = createJiti(import.meta.url, { moduleCache: false });
export const fixtureSettings = {
  version: 1,
  backend: { type: "transcribe-cpp" },
  shortcut: "ctrl+alt+z",
  preferredLanguages: ["zh"],
  transcriptionLanguage: "zh",
  chineseOutput: "simplified",
  microphone: { type: "system-default" },
  voiceActivityDetection: true,
  longformChunking: true,
  model: { source: "catalog", id: "Fun-ASR-Nano-2512", path: "/test-only/nonexistent.gguf" },
};
