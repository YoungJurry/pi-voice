import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  convertChineseOutput,
  isChineseLanguage,
  shouldConvertChinese,
} from "./chinese.js";
import { Deferred } from "./deferred.js";
import type { TranscribeSettings } from "./settings.js";
import type { DictationReservation, Transcript } from "./transcription-service.js";

/** The executable that speaks the Vinput JSONL protocol. */
export type CloudProviderCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type CloudTranscriptionOptions = {
  /** Time from reserving the take until the provider announces `session_started`. */
  startupTimeoutMs?: number;
  /** Time allowed for a final transcript after `finish` is sent. */
  finishTimeoutMs?: number;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_FINISH_TIMEOUT_MS = 20_000;
/**
 * Audio waiting for the provider's stdin. A provider that stops reading must
 * fail the take instead of growing this process without bound.
 */
const MAX_PENDING_STDIN_BYTES = 1024 * 1024;
/** A single JSONL event larger than this is treated as a protocol failure. */
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
/** Let a normally finished provider close its own pipes before signalling it. */
const NORMAL_STOP_GRACE_MS = 250;
/** SIGTERM, then SIGKILL if the process is still alive. */
const KILL_GRACE_MS = 1000;
/** Last-resort cleanup if a killed child never reports `close`. */
const FORCE_STOP_MS = 1000;

type QueuedWrite = { data: Buffer; bytes: number };

function cancellationError(reason?: unknown): Error {
  return reason instanceof Error ? reason : new Error("Cloud transcription cancelled");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : cancellationError();
}

/** PCM16LE, mono 16 kHz. NaN and infinities are silence; everything is clamped. */
function encodePcm16(chunk: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(chunk.length * 2);
  for (let index = 0; index < chunk.length; index++) {
    let sample = chunk[index]!;
    if (!Number.isFinite(sample)) sample = 0;
    sample = Math.max(-1, Math.min(1, sample));
    pcm.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), index * 2);
  }
  return pcm;
}

/**
 * One provider process and one dictation take. The service owns at most one of
 * these at a time; the class owns its timers, listeners and stdin queue.
 */
class CloudTake {
  private readonly ready = new Deferred<void>();
  private readonly result = new Deferred<Transcript>();
  private readonly stopped = new Deferred<void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private started = false;
  private submitted = false;
  /** A finish message has actually been queued for stdin. */
  private finishSent = false;
  private cancelled = false;
  private finalReceived = false;
  private terminal = false;
  private failure: unknown;
  private cancelReason: Error | undefined;
  private released = false;
  private stopStarted = false;
  private stopFinished = false;
  private childExited = false;
  private stdoutBuffer = "";
  /** The newest interim transcript, for providers whose final loses text. */
  private latestPartial = "";
  private queue: QueuedWrite[] = [];
  private pendingBytes = 0;
  private draining = false;
  private removeAbortListener: (() => void) | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private finishTimer: ReturnType<typeof setTimeout> | undefined;
  private terminateTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private forceStopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly settings: TranscribeSettings,
    private readonly commandFor: (
      settings: TranscribeSettings,
    ) => Promise<CloudProviderCommand>,
    private readonly onPartial: ((text: string) => void) | undefined,
    private readonly startupTimeoutMs: number,
    private readonly finishTimeoutMs: number,
    private readonly waitForPrevious: () => Promise<void>,
    private readonly onRelease: (take: CloudTake) => void,
  ) {
    // Startup and cancellation can happen before a caller attaches handlers.
    void this.ready.promise.catch(() => undefined);
    void this.result.promise.catch(() => undefined);
    void this.stopped.promise.catch(() => undefined);
    void this.start().catch((error: unknown) => this.fail(error));
  }

  get readyPromise(): Promise<void> {
    return this.ready.promise;
  }

  get resultPromise(): Promise<Transcript> {
    return this.result.promise;
  }

  get stoppedPromise(): Promise<void> {
    return this.stopped.promise;
  }

  private async start(): Promise<void> {
    // A cancelled take may still have a process winding down. Never overlap
    // provider processes; the startup timeout starts only once this one can
    // actually connect.
    await this.waitForPrevious();
    if (this.terminal || this.cancelled) return;

    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.fail(new Error(
        `Speech provider did not start within ${this.startupTimeoutMs} ms`,
      ));
    }, this.startupTimeoutMs);

    let provider: CloudProviderCommand;
    try {
      provider = await this.commandFor(this.settings);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.terminal || this.cancelled) return;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(provider.command, provider.args, {
        env: { ...process.env, ...provider.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    this.child = child;
    this.attach(child);
    // Audio queued while commandFor was resolving is now written in order.
    this.pump();
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    child.on("error", this.onChildError);
    child.on("close", this.onChildClose);
    child.stdin.on("error", this.onChildStdinError);
    child.stdin.on("drain", this.onDrain);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", this.onStdout);
    child.stdout.on("error", this.onStdoutError);
    // Provider diagnostics are intentionally discarded: no audio or text may
    // enter Pi Voice's log.
    child.stderr.on("error", this.onStderrError);
    child.stderr.resume();
  }

  feed(chunk: Float32Array): void {
    // Audio queued before submit keeps its order; nothing may follow finish.
    if (
      this.cancelled ||
      this.terminal ||
      this.submitted ||
      this.finishSent ||
      this.finalReceived ||
      chunk.length === 0
    ) {
      return;
    }
    let data: Buffer;
    try {
      data = Buffer.from(`${JSON.stringify({
        type: "audio",
        audio_base64: encodePcm16(chunk).toString("base64"),
        commit: false,
      })}\n`);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.enqueue(data);
  }

  submit(pcm: Float32Array, signal?: AbortSignal): Promise<Transcript> {
    // The take's audio has already streamed. submit only asks for the final
    // transcript; the whole clip is never uploaded a second time.
    void pcm;
    if (this.submitted) {
      return Promise.reject(new Error("The dictation reservation is no longer active"));
    }
    if (this.cancelled) {
      return Promise.reject(this.cancelReason ?? cancellationError());
    }
    if (this.terminal) {
      return Promise.reject(this.failure ?? new Error("Cloud transcription failed"));
    }
    this.submitted = true;

    if (signal) {
      const onAbort = (): void => this.cancel(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      this.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }

    const finishWhenReady = async (): Promise<Transcript> => {
      try {
        await this.ready.promise;
        if (this.cancelled) throw this.cancelReason ?? cancellationError();
        if (this.terminal && !this.finalReceived) {
          throw this.failure ?? new Error("Cloud transcription failed");
        }
        if (this.finalReceived) return await this.result.promise;
        this.sendFinish();
        return await this.result.promise;
      } finally {
        this.removeAbortListener?.();
        this.removeAbortListener = undefined;
      }
    };
    return finishWhenReady();
  }

  cancel(reason: Error = cancellationError()): void {
    if (this.result.settled) {
      // The transcript (or its error) was already delivered; just clean up.
      this.stopChild(false);
      return;
    }
    if (this.cancelled) return;

    // A final whose Chinese conversion is still pending is not a result yet:
    // cancellation wins, and the pending conversion must not resolve later.
    this.cancelled = true;
    this.terminal = true;
    this.cancelReason = reason;
    this.failure ??= reason;
    this.latestPartial = "";
    this.clearTimers();
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.ready.reject(reason);
    this.result.reject(reason);
    this.release();
    this.writeCancel();
    this.stopChild(true);
  }

  private enqueue(data: Buffer): void {
    if (this.cancelled || this.terminal) return;
    if (this.pendingBytes + data.byteLength > MAX_PENDING_STDIN_BYTES) {
      this.fail(new Error(
        `Speech provider stopped reading audio (${MAX_PENDING_STDIN_BYTES} byte stdin limit reached)`,
      ));
      return;
    }
    this.queue.push({ data, bytes: data.byteLength });
    this.pendingBytes += data.byteLength;
    this.pump();
  }

  private sendFinish(): void {
    if (this.cancelled || this.terminal || !this.child) {
      if (!this.cancelled && !this.terminal) {
        this.fail(new Error("Speech provider is not running"));
      }
      return;
    }
    const data = Buffer.from('{"type":"finish"}\n');
    this.enqueue(data);
    if (this.cancelled || this.terminal) return;
    // Only now may a final be accepted: a provider that answers before it has
    // been asked to finish would be guessing at an unfinished recording.
    this.finishSent = true;
    this.finishTimer = setTimeout(() => {
      this.finishTimer = undefined;
      this.fail(new Error(
        `Speech provider did not return a final transcript within ${this.finishTimeoutMs} ms`,
      ));
    }, this.finishTimeoutMs);
  }

  private writeCancel(): void {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable || this.stopFinished) return;
    try {
      stdin.write('{"type":"cancel"}\n', () => undefined);
    } catch {
      // The process is already going away; SIGTERM below is enough.
    }
  }

  private pump(): void {
    if (this.draining || this.stopStarted || this.stopFinished) return;
    const stdin = this.child?.stdin;
    if (!stdin) return;
    if (!stdin.writable) {
      if (this.queue.length > 0) {
        this.onStdinError(new Error("Speech provider stdin is closed"));
      }
      return;
    }

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      let writable: boolean;
      try {
        writable = stdin.write(item.data, (error?: Error | null) => {
          this.pendingBytes = Math.max(0, this.pendingBytes - item.bytes);
          if (error) this.onStdinError(error);
        });
      } catch (error) {
        this.pendingBytes = Math.max(0, this.pendingBytes - item.bytes);
        this.onStdinError(error);
        return;
      }
      if (!writable) {
        this.draining = true;
        return;
      }
    }
  }

  private readonly onDrain = (): void => {
    this.draining = false;
    this.pump();
  };

  private onStdinError(error: unknown): void {
    if (this.cancelled || this.terminal || this.finalReceived) return;
    // After finish the provider may close its stdin while it finalizes; the
    // final, the exit and the finish timeout decide the outcome from here.
    if (this.finishSent) return;
    this.fail(error instanceof Error ? error : new Error(String(error)));
  }

  private readonly onStdout = (chunk: string): void => {
    if (this.cancelled || this.terminal) return;
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (this.cancelled || this.terminal) return;
      this.handleLine(line);
    }
    // Only an unterminated line can grow without bound.
    if (this.stdoutBuffer.length > MAX_PROTOCOL_LINE_BYTES) {
      this.fail(new Error("Speech provider sent an oversized protocol message"));
    }
  };

  private readonly onStdoutError = (error: Error): void => {
    if (this.cancelled || this.terminal || this.finalReceived) return;
    this.fail(error);
  };

  private readonly onStderrError = (): void => {
    // Diagnostics are discarded; a broken stderr must not crash the take.
  };

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.fail(new Error("Speech provider sent invalid JSON"));
      return;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      this.fail(new Error("Speech provider sent a non-object protocol message"));
      return;
    }

    const message = event as Record<string, unknown>;
    switch (message.type) {
      case "session_started":
        if (this.cancelled || this.terminal || this.started) return;
        this.started = true;
        this.clearStartupTimer();
        this.ready.resolve();
        return;

      case "partial":
        if (this.cancelled || this.terminal || this.finalReceived || !this.started) return;
        if (typeof message.text === "string" && message.text.length > 0) {
          this.latestPartial = message.text;
          try {
            this.onPartial?.(message.text);
          } catch {
            // Presentation errors must not affect transcription.
          }
        }
        return;

      case "final":
        if (this.cancelled || this.terminal || this.finalReceived) return;
        if (!this.started || !this.finishSent) {
          // A final is only a response to our finish. Accepting one earlier
          // could submit text for a recording the user is still making.
          this.fail(new Error("Speech provider returned a final transcript before finish"));
          return;
        }
        this.finalReceived = true;
        this.clearFinishTimer();
        this.complete(typeof message.text === "string" ? message.text : "");
        return;

      case "error": {
        const detail = typeof message.message === "string" && message.message
          ? message.message
          : "Speech provider error";
        this.fail(new Error(detail));
        return;
      }

      case "closed":
        this.onProviderClosed();
        return;

      default:
        // Forward-compatible: providers may add informational events.
        return;
    }
  }

  private complete(rawText: string): void {
    const finalText = rawText.trim();
    // WeType's polished final can be truncated to one sentence while the last
    // partial still holds the whole utterance. Never drop recognized words
    // silently: keep the longer live transcript and say so.
    const partialText = this.latestPartial.trim();
    const truncated = this.settings.backend.type === "wetype" &&
      partialText.length > 0 &&
      finalText.length < partialText.length * 0.8 &&
      partialText.length - finalText.length > 8;
    const text = truncated ? partialText : finalText;
    const warning = truncated
      ? "微信输入法返回的最终稿明显短于实时结果，已保留实时转写以避免截断。"
      : undefined;

    void this.finishTranscript(text).then(
      (converted) => {
        if (this.result.settled) return;
        this.result.resolve(warning ? { text: converted, warning } : { text: converted });
        this.release();
        this.stopChild(false);
      },
      (error: unknown) => {
        if (this.result.settled) return;
        this.fail(error, true);
      },
    );
  }

  private async finishTranscript(text: string): Promise<string> {
    if (!text) return text;
    const language = this.settings.transcriptionLanguage || "zh";
    const chineseEnabled = isChineseLanguage(language) ||
      this.settings.preferredLanguages?.some(isChineseLanguage) === true;
    if (!shouldConvertChinese(text, { chineseEnabled, language })) return text;
    return convertChineseOutput(text, this.settings.chineseOutput);
  }

  private onProviderClosed(): void {
    if (this.cancelled || this.terminal) return;
    if (this.finalReceived) {
      this.stopChild(false);
      return;
    }
    if (!this.started) {
      this.fail(new Error("Speech provider closed before the session started"));
    } else if (!this.submitted) {
      this.fail(new Error("Speech provider closed before finish"));
    } else {
      this.fail(new Error("Speech provider closed before returning a final transcript"));
    }
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.childExited = true;
    if (!this.cancelled && !this.terminal && !this.finalReceived) {
      // A provider may end its last line without a trailing newline.
      if (this.stdoutBuffer.trim()) {
        const leftover = this.stdoutBuffer;
        this.stdoutBuffer = "";
        this.handleLine(leftover);
      }
      if (!this.terminal && !this.finalReceived) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        this.fail(new Error(this.started
          ? `Speech provider exited before returning a final transcript (${detail})`
          : `Speech provider exited before the session started (${detail})`));
      }
    }
    this.finishStop();
  }

  private fail(error: unknown, force = false): void {
    if (this.finalReceived && !force) return;
    if (this.terminal && !force) return;
    this.terminal = true;
    this.failure ??= error;
    this.clearTimers();
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.ready.reject(error);
    this.result.reject(error);
    this.release();
    this.stopChild(true);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this);
  }

  private stopChild(signal: boolean): void {
    if (this.stopStarted) return;
    this.stopStarted = true;
    this.clearTimers();
    const child = this.child;
    if (!child || this.childExited || this.stopFinished) {
      this.finishStop();
      return;
    }

    try {
      if (child.stdin.writable) child.stdin.end();
    } catch {
      // The pipe may already be gone.
    }

    if (signal) {
      this.terminate();
    } else {
      this.terminateTimer = setTimeout(() => {
        this.terminateTimer = undefined;
        this.terminate();
      }, NORMAL_STOP_GRACE_MS);
    }
  }

  private terminate(): void {
    if (this.stopFinished || this.childExited) return;
    const child = this.child;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (this.stopFinished || this.childExited) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      this.forceStopTimer = setTimeout(() => {
        this.forceStopTimer = undefined;
        this.finishStop();
      }, FORCE_STOP_MS);
    }, KILL_GRACE_MS);
  }

  private clearTimers(): void {
    this.clearStartupTimer();
    this.clearFinishTimer();
    if (this.terminateTimer) {
      clearTimeout(this.terminateTimer);
      this.terminateTimer = undefined;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    if (this.forceStopTimer) {
      clearTimeout(this.forceStopTimer);
      this.forceStopTimer = undefined;
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
  }

  private clearFinishTimer(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = undefined;
    }
  }

  private finishStop(): void {
    if (this.stopFinished) return;
    this.stopFinished = true;
    this.clearTimers();
    const child = this.child;
    if (child) {
      child.removeListener("error", this.onChildError);
      child.removeListener("close", this.onChildClose);
      child.stdin.removeListener("error", this.onChildStdinError);
      child.stdin.removeListener("drain", this.onDrain);
      child.stdout.removeListener("data", this.onStdout);
      child.stdout.removeListener("error", this.onStdoutError);
      child.stderr.removeListener("error", this.onStderrError);
      // Late EPIPE/teardown errors on a dying child must never become
      // uncaught exceptions; these no-ops hold no reference to the take.
      child.on("error", () => undefined);
      child.stdin.on("error", () => undefined);
      child.stdout.on("error", () => undefined);
      child.stderr.on("error", () => undefined);
      try {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // Already closed.
      }
    }
    this.child = undefined;
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.stopped.resolve();
  }

  private readonly onChildError = (error: Error): void => this.fail(error);
  private readonly onChildClose = (code: number | null, signal: NodeJS.Signals | null): void =>
    this.onClose(code, signal);
  private readonly onChildStdinError = (error: Error): void => this.onStdinError(error);
}

/**
 * Streaming dictation through a Vinput-compatible provider subprocess.
 * Audio is written as it arrives; `submit` sends only `finish`. One take owns
 * the provider lane at a time.
 */
export class CloudTranscriptionService {
  private active: CloudTake | undefined;
  private readonly retiring = new Set<Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly startupTimeoutMs: number;
  private readonly finishTimeoutMs: number;

  constructor(
    private readonly commandFor: (
      settings: TranscribeSettings,
    ) => Promise<CloudProviderCommand>,
    private readonly onPartial?: (text: string) => void,
    options: CloudTranscriptionOptions = {},
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.finishTimeoutMs = options.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;
  }

  reserveDictation(settings: TranscribeSettings): DictationReservation {
    if (this.shuttingDown) throw new Error("Pi Voice is shutting down");
    if (this.active) throw new Error("A dictation reservation is already active");

    const take = new CloudTake(
      settings,
      this.commandFor,
      this.onPartial,
      this.startupTimeoutMs,
      this.finishTimeoutMs,
      () => this.waitForRetiring(),
      (released) => this.release(released),
    );
    this.active = take;

    return {
      ready: take.readyPromise,
      feed: (chunk) => take.feed(chunk),
      submit: (pcm, signal) => take.submit(pcm, signal),
      cancel: () => take.cancel(),
    };
  }

  private async waitForRetiring(): Promise<void> {
    while (this.retiring.size > 0) {
      await Promise.allSettled([...this.retiring]);
    }
  }

  private release(take: CloudTake): void {
    if (this.active === take) this.active = undefined;
    const stopped = take.stoppedPromise.then(
      () => undefined,
      () => undefined,
    );
    this.retiring.add(stopped);
    void stopped.finally(() => this.retiring.delete(stopped));
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return (this.shutdownPromise ??= this.performShutdown());
  }

  private async performShutdown(): Promise<void> {
    const error = new Error("Pi Voice is shutting down");
    const active = this.active;
    this.active = undefined;
    active?.cancel(error);
    // A release during shutdown may add its stopped promise to the set.
    while (this.retiring.size > 0) {
      await Promise.allSettled([...this.retiring]);
    }
  }
}
