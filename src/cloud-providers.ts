import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { settingsPath } from "./settings-path.js";
import { settingsForCloud, type CloudProvider, type TranscribeSettings } from "./settings.js";

// These third-party scripts are NOT redistributed by this package. Downloading
// executable code and sending audio both require explicit user consent in the UI.
export const PROVIDER_REVISION = "5b39b073ac1b740aaba0bf104f47202bc9285da1";
export const CLOUD_PROVIDERS = {
  doubaoime: {
    name: "豆包输入法（免费流式，非官方）",
    host: "豆包输入法云端",
    sha256: "25aa69c4aaa2c495392a8172cf78fb45deaf4155c257183dc6c7bb18334aacdd",
  },
  wetype: {
    name: "微信输入法（免费流式，非官方）",
    host: "wetype.weixin.qq.com",
    sha256: "119a7f9a7cd0d6b942ec591c5ec9e03a196026cd4a1d3d15041f76d3396639eb",
  },
} as const;

const execFileAsync = promisify(execFile);
const MAX_PROVIDER_BYTES = 256 * 1024;

export function cloudProviderDirectory(): string {
  return process.env.PI_VOICE_PROVIDER_DIR || join(dirname(settingsPath()), "voice-providers");
}

export function cloudProviderPath(provider: CloudProvider): string {
  return join(cloudProviderDirectory(), `${provider}-${PROVIDER_REVISION.slice(0, 12)}.py`);
}

export function cloudProviderUrl(provider: CloudProvider): string {
  return `https://raw.githubusercontent.com/xifan2333/vinput-registry/${PROVIDER_REVISION}/resources/providers/${provider}/streaming/entry.py`;
}

export function verifyProviderSource(provider: CloudProvider, source: Uint8Array): void {
  const expected = CLOUD_PROVIDERS[provider].sha256;
  if (source.byteLength > MAX_PROVIDER_BYTES || createHash("sha256").update(source).digest("hex") !== expected) {
    throw new Error("第三方语音脚本校验失败，拒绝执行。请勿绕过校验。");
  }
}

export async function hasVerifiedProvider(provider: CloudProvider): Promise<boolean> {
  try {
    verifyProviderSource(provider, await readFile(cloudProviderPath(provider)));
    return true;
  } catch {
    return false;
  }
}

export async function checkCloudRuntime(): Promise<void> {
  try {
    await execFileAsync(process.env.PI_VOICE_PYTHON || "python3", ["-c", [
      "import ctypes, ctypes.util, sys",
      "assert sys.version_info >= (3, 10), 'Python 3.10 or newer is required'",
      "ctypes.CDLL(ctypes.util.find_library('opus') or 'libopus.so.0')",
      "ctypes.CDLL(ctypes.util.find_library('crypto') or 'libcrypto.so.3')",
    ].join("; ")], { timeout: 8_000, maxBuffer: 16 * 1024 });
  } catch {
    throw new Error(
      "在线语音需要 Python ≥3.10、libopus 和 OpenSSL libcrypto。请先安装这些依赖；" +
      "不会自动运行系统包管理器。可用 PI_VOICE_PYTHON 指定 Python。Linux 已验证；其他平台需自行验证这些依赖。",
    );
  }
}

export async function installCloudProvider(provider: CloudProvider): Promise<void> {
  if (await hasVerifiedProvider(provider)) return;
  const response = await fetch(cloudProviderUrl(provider), { signal: AbortSignal.timeout(25_000) });
  if (!response.ok || !response.body) throw new Error(`第三方脚本下载失败：HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_PROVIDER_BYTES) throw new Error("第三方脚本超出大小限制，拒绝安装。");
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks);
  verifyProviderSource(provider, source);
  const directory = cloudProviderDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = cloudProviderPath(provider);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function cloudProviderCommand(settings: TranscribeSettings): Promise<{
  command: string; args: string[]; env: Record<string, string>;
}> {
  const provider = settings.backend.type;
  if (provider === "transcribe-cpp") throw new Error("本地模式不使用云端脚本");
  // Verify every launch, not only the first download. Never silently fetch or
  // fall back to another endpoint while recording.
  verifyProviderSource(provider, await readFile(cloudProviderPath(provider)).catch(() => {
    throw new Error("尚未安装在线语音依赖，请打开 /voice-settings → Model 并确认安装。");
  }));
  return {
    command: process.env.PI_VOICE_PYTHON || "python3",
    args: ["-u", cloudProviderPath(provider)],
    env: {
      VINPUT_ASR_CREDENTIAL_PATH: join(cloudProviderDirectory(), `${provider}.identity.json`),
      VINPUT_ASR_TIMEOUT: "15",
      VINPUT_ASR_FINISH_GRACE_SECS: provider === "wetype" ? "5" : "9",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  };
}

/** Returns undefined on cancel/error; caller persists only a successful choice. */
export async function chooseSpeechBackend(
  ctx: ExtensionContext,
  previous?: TranscribeSettings,
): Promise<TranscribeSettings | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("语音后端选择需要交互式终端。", "error");
    return undefined;
  }
  const local = "本地模型（离线，不发送录音）";
  const choices = [local, CLOUD_PROVIDERS.doubaoime.name, CLOUD_PROVIDERS.wetype.name];
  const selected = await ctx.ui.select("选择语音识别后端", choices);
  if (!selected) return undefined;
  if (selected === local) {
    return { ...(previous ?? settingsForCloud("doubaoime")), backend: { type: "transcribe-cpp" } };
  }
  const provider: CloudProvider = selected === CLOUD_PROVIDERS.doubaoime.name ? "doubaoime" : "wetype";
  const definition = CLOUD_PROVIDERS[provider];
  const cached = await hasVerifiedProvider(provider);
  const confirmed = await ctx.ui.confirm(
    definition.name,
    `录音会实时发送到${definition.host}，并自动注册、缓存匿名设备身份。` +
    "无需用户 API Key，但这是非官方接口，没有永久免费或持续可用承诺。不要发送敏感录音。\n\n" +
    (cached ? "将执行已缓存、哈希校验通过的第三方 Python 脚本。" :
      "将从 xifan2333/vinput-registry 下载并执行第三方 Python 脚本（该仓库未声明许可证，本包不包含其代码）。") +
    `\n固定版本：${PROVIDER_REVISION}\n来源：${cloudProviderUrl(provider)}\n\n是否同意使用？`,
  );
  if (!confirmed) return undefined;
  try {
    await checkCloudRuntime();
    if (!cached) ctx.ui.notify("正在下载并校验语音提供商脚本…", "info");
    await installCloudProvider(provider);
    return settingsForCloud(provider, previous);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return undefined;
  }
}
