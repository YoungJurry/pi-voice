import type { InputDevice, Permission, Recording } from "@handy-computer/recorder";
import { CAPTURE_CHUNK_SAMPLES, CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import type { Capture, CaptureSinks } from "./dictation-controller.js";
import { logLevel, writeLog } from "./log.js";
import { importWithoutReportNetwork } from "./native-import.js";
import type { MicrophoneSetting } from "./settings.js";

export type { InputDevice, Permission };

let recorderModule: Promise<typeof import("@handy-computer/recorder")> | undefined;

function loadRecorder(): Promise<typeof import("@handy-computer/recorder")> {
  return (recorderModule ??= importWithoutReportNetwork(() => import("@handy-computer/recorder"))
    .then((recorder) => {
      // Preserve native timestamps: log callbacks can arrive after a blocked loop.
      const level = logLevel();
      if (level) {
        recorder.setLogHandler(
          (record) => writeLog(record.level === "trace" ? "debug" : record.level, "recorder", record.message, record.timeMs),
          { level: level === "debug" ? "debug" : "info" },
        );
      }
      return recorder;
    }));
}

export class MicrophoneUnavailableError extends Error {
  constructor(name: string) {
    super(`Selected microphone is unavailable: ${name}. Open /voice-settings and choose another microphone.`);
    this.name = "MicrophoneUnavailableError";
  }
}

/** Input devices to offer, without PulseAudio monitors of outputs. */
export async function getAvailableMicrophones(): Promise<InputDevice[]> {
  const { listInputDevices } = await loadRecorder();
  return (await listInputDevices()).filter((device) => !device.isMonitor);
}

/** Loads the recorder safely, then reads permission without prompting. */
export async function microphonePermission(): Promise<Permission> {
  return (await loadRecorder()).permissionStatus();
}

export function findMicrophone(
  devices: readonly InputDevice[],
  selected: { name: string; occurrence: number },
): InputDevice | undefined {
  return devices.find((device) => device.name === selected.name && device.occurrence === selected.occurrence);
}

function interruption(recording: Recording): Error | undefined {
  const { endReason } = recording;
  if (endReason.kind === "recorderFailed") {
    // Access revoked mid-recording (or refused at the first prompt): what
    // was captured is silence, so fail the take and let the user fix it.
    if (endReason.error.code === "PermissionDenied") throw endReason.error;
    return endReason.error;
  }
  if (endReason.kind === "sinkPanicked") return new Error(endReason.message);
  return undefined;
}

/** Opens the microphone and starts recording 16 kHz mono into `sinks`. */
export async function openMicrophone(microphone: MicrophoneSetting, sinks: CaptureSinks): Promise<Capture> {
  const { listInputDevices, Recorder } = await loadRecorder();
  let device: InputDevice | undefined;
  if (microphone.type === "device") {
    device = findMicrophone(await listInputDevices(), microphone);
    if (!device) throw new MicrophoneUnavailableError(microphone.name);
  }

  const recorder = await Recorder.open({
    device: device?.id,
    sampleRate: CAPTURE_SAMPLE_RATE,
    channels: "mono",
    framesPerChunk: CAPTURE_CHUNK_SAMPLES,
    onChunk: ({ samples }) => sinks.onAudio(samples),
    onFailure: (error) => sinks.onFailure(error),
  });
  try {
    const { format } = recorder.info;
    if (format.sampleRate !== CAPTURE_SAMPLE_RATE || format.channels !== 1) {
      throw new Error(`Recorder delivers ${format.sampleRate} Hz × ${format.channels}; expected ${CAPTURE_SAMPLE_RATE} Hz mono`);
    }
    recorder.start();
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }

  return {
    async stop() {
      try {
        const recording = await recorder.stop();
        return {
          pcm: recording.samples,
          interruption: interruption(recording),
          droppedFrames: recording.droppedFrames,
        };
      } finally {
        // The recording is already in hand; a close that times out only
        // means the platform holds the device until Pi exits.
        await recorder.close().catch(() => undefined);
      }
    },
  };
}
