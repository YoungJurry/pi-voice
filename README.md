# Pi Voice（纯用户语音输入版）

基于 [Earendil Works Pi Voice 0.2.0](https://github.com/earendil-works/pi-voice) 的最小功能定制，保留原 MIT 许可证。

只做两件事：

1. **不注册任何模型工具**：移除 `transcribe_file` 及其提示词说明。没有新增系统提示、模型上下文钩子或自动提交消息。
2. 在现有 **`/voice-settings` → Model** 中增加 **豆包输入法 / 微信输入法流式识别**。原本的本地模型仍然可用。

快捷键、录音操作、模型下载及其他本地设置保持原有行为。云端模式新增录音期间的临时识别文字预览，最终文字仍只粘贴到编辑器，由你决定是否发送。

## 安装与切换

在终端运行（不要同时启用官方版和本版）：

```bash
pi remove npm:@earendil-works/pi-voice
pi install git:github.com/YoungJurry/pi-voice
```

如果之前使用项目级 `-l` 安装，卸载时也在该项目目录加 `-l`。

重新启动 Pi。原来的 `~/.pi/agent/pi-voice.json`、本地模型和快捷键会继续使用，不必重新下载模型。

旧会话可能保留历史工具说明；要完全排除旧上下文，请重启后开新会话。仅修改磁盘文件不会让已经运行的会话立即卸载旧工具。

## 使用

- `Ctrl+Alt+Z` 或 `/voice`：开始／停止录音。
- 录音时 `Space`：停止并转写；`Escape`：丢弃／取消。
- `/voice-settings` → **Model**：选择本地模型、豆包输入法流式或微信输入法流式。
- `/transcribe` 仍是原来的设置命令别名，不是模型工具。

云端音频在录音期间以约 120 ms 一批发送，实时返回累计临时文本；预览按可用宽度自动换行，调整终端宽度时重新排版，不会用省略号截断或只保留末尾 2000 字符。停止后只发送结束消息，不会把整段录音再次上传。失败时报告错误，不会悄悄切换服务或重新上传。微信定稿明显短于临时文本时，保留更完整的临时文本并提示，避免已知的长录音截断问题。

首次选择在线模式会说明隐私及第三方代码来源，并要求确认；取消则不下载、不启用。

## 在线模式依赖与边界

当前验证环境：**Linux、Node.js 26、Pi 1.4.0、Python ≥3.10**。Pi 包声明的 Node.js 最低版本为 22；其他平台尚未端到端验证。

在线识别还需要系统提供：

- `python3`（可用 `PI_VOICE_PYTHON` 指定解释器）；
- `libopus`；
- OpenSSL `libcrypto`（微信协议需要）。

不会自动运行系统包管理器。Debian/Ubuntu 一般需要 `python3`、`libopus0`、`libssl3`（具体 OpenSSL 包名以发行版为准）。豆包脚本依赖 POSIX 的 `fcntl`，原生 Windows 未支持／验证；可考虑 WSL。

### “免费”是什么意思？

这里接入的是 **Vinput 使用的非官方输入法客户端接口**，不是火山引擎或腾讯云付费 ASR API。当前不要求用户 API Key 或账号，脚本会自动注册匿名设备身份。

**没有永久免费、额度或持续可用保证。** 服务端可能限流、改协议或停止服务，使用前请了解并遵守服务方条款。音频会上传至豆包／微信云端，不要发送敏感录音。微信脚本直接建立 TLS 连接，不读取 HTTP(S) 代理环境变量。

豆包和微信目前都做过真实联网测试：公开中文样例在录音期间返回 partial，停止后返回 final；这不是对所有口音、网络、时长或准确率的保证，也不能替代你实际麦克风的试用。

## 第三方脚本来源

协议适配使用 [xifan2333/vinput-registry](https://github.com/xifan2333/vinput-registry) 提供的 JSONL 程序。该仓库未声明许可证，**本仓库不复制、不包含、不重新分发其 Python 源码**。

用户确认后，从上游下载以下固定版本，并在安装及每次执行前校验 SHA-256：

- commit：`5b39b073ac1b740aaba0bf104f47202bc9285da1`
- [豆包输入法脚本](https://github.com/xifan2333/vinput-registry/blob/5b39b073ac1b740aaba0bf104f47202bc9285da1/resources/providers/doubaoime/streaming/entry.py)
  - SHA-256：`25aa69c4aaa2c495392a8172cf78fb45deaf4155c257183dc6c7bb18334aacdd`
- [微信输入法脚本](https://github.com/xifan2333/vinput-registry/blob/5b39b073ac1b740aaba0bf104f47202bc9285da1/resources/providers/wetype/streaming/entry.py)
  - SHA-256：`119a7f9a7cd0d6b942ec591c5ec9e03a196026cd4a1d3d15041f76d3396639eb`

缓存及匿名设备身份位于 `~/.pi/agent/voice-providers/`（自定义 agentDir 时随之变化）。设备身份文件由脚本以 `0600` 权限保存，不要分享或提交到 Git。不会在启动 Pi 时自动联网，只有用户选择安装、使用在线录音时才会联网。删除此目录可清除脚本和设备身份。

## Linux 首次录音卡顿修复

录音依赖在 Linux 上检测 glibc/musl 时会生成 Node 诊断报告，默认对已有连接进行同步反向 DNS 查询。在 TUN/Fake-IP 或反向 DNS 超时的网络中，这可能使整个 Pi 界面冻结数十秒。

本版在加载录音依赖期间临时设置 `process.report.excludeNetwork = true`，完成或失败后恢复原值；并发加载结束前保持保护。不改变代理、DNS 配置、语音后端或 Pi 的正常联网，也不需要额外设置 `NODE_OPTIONS`。录音、设置页和首次引导共用安全加载入口。

## 开发与测试

```bash
npm install --ignore-scripts
npm test
```

自动测试使用模拟提供商，不上传录音、不访问用户设置，覆盖零工具注册、原录音控制、流式数据、取消、超时、错误、设置兼容、脚本完整性，以及实时预览的中文／Unicode 长文本换行、窗口缩放和连续更新。原生模块加载回归测试覆盖已有 TCP 连接下的 DNS 查询保护、并发加载、失败恢复和按需加载，不依赖公网或采集麦克风。

显式联网测试（**会上传所指定的音频**，只用公开测试样例）：

```bash
node scripts/smoke-cloud.mjs --upload-test-audio doubaoime /path/to/public-test.wav
node scripts/smoke-cloud.mjs --upload-test-audio wetype /path/to/public-test.wav
```

输入须为 16 kHz、单声道、PCM16 WAV。脚本与身份缓存放在临时目录，测试后清理。不采集麦克风。
