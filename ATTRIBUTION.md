# 第三方资源与许可

本仓库自己的代码采用 **MIT** 许可（见 [LICENSE](LICENSE)）。
下面是随仓库分发的第三方资源及其许可。

---

## 运行时依赖（`vendor/`）

### Salamander Grand Piano —— CC BY 3.0

- 文件：`vendor/piano/*.mp3`（30 个，A0–C8 每 3 个半音一个，约 1.9 MB）
- 用途：**默认音源**。真实钢琴采样，比合成器自然得多
- 作者：Alexander Holm
- 来源：https://github.com/sfzinstruments/SalamanderGrandPiano
- 许可：**Creative Commons Attribution 3.0**（署名即可商用）
- 本项目通过 Tone.js 官方示例的托管地址获取：
  https://tonejs.github.io/audio/salamander/

**署名声明（CC BY 要求）**：本项目使用 Salamander Grand Piano v3 音色采样，
由 Alexander Holm 录制，采用 Creative Commons Attribution 3.0 许可。
原始项目：https://github.com/sfzinstruments/SalamanderGrandPiano

> 想换成别的音源：替换 `vendor/piano/` 里的 mp3，并同步改 `index.html` 里的 `PIANO_SAMPLES`。
> 删掉整个 `vendor/piano/` 目录也可以 —— 程序会自动退回内置合成器音色，功能不受影响，
> 只是音色没那么真实（这条降级路径有自动化测试覆盖）。

### Tone.js —— MIT

- 版本：14.7.77
- 文件：`vendor/Tone.js`
- 用途：音频引擎（合成器、效果器、离线渲染）
- 主页：https://tonejs.github.io/
- 仓库：https://github.com/Tonejs/Tone.js

### @tonejs/midi —— MIT

- 版本：2.0.28
- 文件：`vendor/Midi.js`
- 用途：MIDI 文件解析与写入
- 仓库：https://github.com/Tonejs/Midi

### lamejs（LAME 的 JavaScript 移植版）—— LGPL

- 版本：1.2.1
- 文件：`vendor/lame.min.js`
- 用途：把渲染出的 PCM 编码成 MP3
- 上游 LAME 项目：https://lame.sourceforge.net/
- lamejs 仓库：https://github.com/zhuker/lamejs

**LGPL 合规说明**

LAME 采用 LGPL 许可，**允许商用**。LGPL 要求：

1. 以独立文件形式链接（本项目即如此：`vendor/lame.min.js` 未被修改）
2. 明确致谢并给出官网链接（即本文件）
3. 若修改了 LAME 本身，需以 LGPL 回馈修改

本项目**未修改** lamejs / LAME 源码，因此无需回馈代码。

> 如果你不想引入 LGPL 依赖，删掉 `vendor/lame.min.js` 以及 `index.html`、`editor.html`
> 里引入它的那一行 `<script>` 即可 —— 试听、导出 MIDI / JSON 都不受影响，只是没有 MP3 导出。

---

## 素材（`assets/`）

### demo.mid

- 文件：`assets/demo.mid`
- 用途：演奏台「载入内置示例」按钮的演示曲
- 来源：取自 [MusicMaker](https://github.com/sien75/MusicMaker) 项目的测试资源
  （`test/resources/test.mid`）
- 许可：MusicMaker 项目采用 **Apache License 2.0**，允许在保留声明的前提下再分发

这是该项目的测试用 MIDI 文件（曲名 "Type 0"，57 秒，2357 个音符），
仅作为功能演示使用。如果你想换成自己的曲子，直接替换这个文件即可。

---

## 开发依赖（`tools/`，不进部署包）

| 包 | 许可 | 用途 |
|---|---|---|
| `puppeteer-core` | Apache-2.0 | 驱动真实浏览器跑端到端测试 |
| `@tonejs/midi` | MIT | 测试脚本里读写 MIDI |
| `lamejs` | LGPL | 仅测试依赖 |

---

## 关于乐谱内容

**本仓库不包含任何受版权保护的歌曲乐谱、MIDI 或录音。**

`scores/` 目录留空，供你放置自己创作、或已获得授权的作品。
`tools/fixtures/` 里的测试乐谱均为本项目自制，无版权问题。

如果你用本工具扒了别人的作品，请仅用于个人学习练习，**不要公开分发**。
