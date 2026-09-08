# Open-ClaudeCode（Web UI 版）

> 在 [Open-ClaudeCode](https://github.com/LING71671/Open-ClaudeCode)（完整开源的 Claude Code 重建项目）基础上，新增了一个**纯本地 Web UI 聊天界面**，并围绕它扩展了会话管理、对话 Fork、历史恢复等能力。

本 README 主要介绍 **Web UI 的启动方式、界面操作与新增功能**。原始项目的完整说明见 [README_origin.md](README_origin.md)，英文版见 [README.en.md](README.en.md)。

---

## ✨ 新增功能一览

- 🖥️ **Web UI 图形界面** — 无需 Electron，纯 Node.js 实现，浏览器访问即可聊天
- 💬 **会话管理** — 左侧「会话」列表、一键「＋ 新建会话」，会话记录自动持久化，服务重启后仍在
- 🕘 **历史记录恢复** — 点开会话即从本地 transcript 恢复完整聊天历史，并支持**多轮上下文续聊**（自动 `--resume`）
- 🔀 **选中追问 / 对话 Fork** — 选中 AI 回复中的任意一段文本，即可基于该片段 Fork 出一个**新会话**单独追问，原会话不受影响
- 🌳 **Fork 图谱** — git graph 风格的分支树，直观展示主会话与各 Fork 分支的派生关系，悬浮可预览引用片段
- 🗑️ **级联删除** — 删除主会话会连同其下所有 Fork 分支（含子 Fork）一起删除，并清理对应的本地历史文件
- 📂 **自由选择工作目录** — 内置目录选择器，可让 CLI 在任意项目目录下工作，每个会话都会固定住自己的目录
- ⚡ **实时流式渲染** — 思考过程、文本回复与工具调用在同一气泡内流式展示：思考可折叠、工具带旋转动效与 ✓ 完成标记
- 🛡️ **工具权限弹窗** — CLI 请求使用工具时在页面弹出「允许 / 拒绝」，无需切换到终端
- 🧠 **模型 / 思考 / 权限模式** — 顶部可直接选择模型（flash / pro）、思考强度与权限模式

---

## 🚀 快速开始

### 前置要求

- **Node.js 18+**（[下载](https://nodejs.org/)）
- **DeepSeek API Key**（在 [platform.deepseek.com](https://platform.deepseek.com/) 获取）
- 仓库自带的编译产物 `package/cli.js`（克隆后已存在，Web UI 依赖它执行命令）
- Windows 上还需安装 **Git for Windows**（CLI 依赖 git-bash 执行命令，服务会自动探测 bash.exe 路径）

> 说明：当前 Web UI 仅对接 **DeepSeek 的 Anthropic 兼容网关**（`https://api.deepseek.com/anthropic`），暂不支持官方 Anthropic 与其它代理。想在命令行使用其它接入方式的同学请参考 README_origin.md。

### 启动方式

**Windows（推荐）：双击 `start-webui.cmd`**

脚本会自动打开浏览器访问 `http://127.0.0.1:8787`，`Ctrl+C` 停止。

```bat
start-webui.cmd            :: 默认端口 8787
start-webui.cmd 8788       :: 指定端口（端口被占用时可用）
set NO_BROWSE=1            :: 不自动打开浏览器
set NO_PAUSE=1             :: 退出前不暂停（供脚本调用）
```

**跨平台：直接用 Node 启动**

```bash
node webui/server.js [--port 8787] [--cwd /path/to/project] [--settings settings.json] [--model deepseek-v4-pro]
```

服务仅监听 `127.0.0.1`（本机），启动后访问 <http://127.0.0.1:8787>。

### 第一次使用

1. 打开页面后，**先配置 DeepSeek API Key**：
   在顶部输入框填入 `sk-…` 并点击「保存 Key」。Key 只会保存在本机
   `~/.opc-webui/config.json`，不会写入仓库，服务重启后自动读取；
   输入框留空再点保存可清除。页面只会回显 Key 的后 4 位。
2. 在下方输入框提问，回车发送（`Shift+Enter` 换行）。
3. 当 CLI 请求使用工具（执行命令 / 读写文件等）时，页面会弹出授权框，点击「允许 / 拒绝」。

---

## 🖥️ 界面与操作说明

### 顶部工具栏

| 控件               | 说明                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------ |
| 权限               | 本次会话的权限模式：`acceptEdits`（默认，自动接受文件编辑）、`default`（逐项询问）、`plan`（只读计划）、`bypassPermissions`（全放行） |
| 目录               | 显示当前工作目录，点击「选择…」弹出**目录选择器**；显示「仓库根目录」表示使用服务默认目录                                            |
| DeepSeek API Key | 配置 / 清除 API Key，旁有点位提示是否已配置                                                                |
| 状态灯              | 空闲 / 运行中 / 重连中 / 出错等运行状态                                                                   |

> 权限、目录、模型、思考的修改会在**下一次发送**时生效。

### 发送区

- **模型**：`flash（快）` / `pro（更强）`（对应模型 `deepseek-v4-flash` / `deepseek-v4-pro`）
- **思考**：`自动`（adaptive，默认）/ `关闭`（disabled）/ `深度`（enabled）
- 输入框随内容自动增高；右侧「发送」「停止」按钮，运行中可随时停止当前任务

### 左侧栏：会话与 Fork 图谱

- **会话列表**：只展示**主会话**（main），标题、更新时间、运行中状态一目了然。
  - 点击「＋ 新建会话」开始一个全新对话
  - 点击会话标题切换并恢复历史；悬停可点「✕」删除
  - 会话正在运行时不能切换 / 新建 / 删除（需先「停止」）
- **FORK 图谱**：展示当前主会话下的**分支树**（含 Fork 与多层子 Fork）。
  - **选中某段文本「追问」后，派生出的 Fork 会以 `↳` 缩进挂在源会话下面**
  - 悬浮节点可预览引用片段 / 首条消息
  - **右键节点**弹出菜单：切换到该会话 / 删除该会话
- 侧栏与正文之间的分隔条可**左右拖动**调整宽度，宽度会被记住

### 🔀 核心新玩法：选中文本 → Fork 追问

1. 在 AI 的回复中**用鼠标选中一段文字**（拖选或双击，键盘 Shift+方向键选择也可）；
2. 选中处会弹出「对选中内容追问」浮层，显示所选片段与追问输入框；
3. 输入追问后回车——系统会基于源会话的完整上下文 **Fork 出一个新会话**（源会话保持不变），新分支带着你选中的引用进入回复。

适合边问边改思路的场景：对同一段答案的不同方向分别开新分支，互不干扰。

### 目录选择器

- 支持逐级浏览目录（含 Windows 磁盘盘符列表）、快速跳转「仓库根 / 主目录 / 当前选择」
- 也可以直接输入绝对路径回车跳转
- 每个会话都会**固定自己运行时的目录**，Fork / 续聊会自动回到该会话原始目录，不会用错上下文

### 数据存储位置

| 内容                    | 路径                                              |
| --------------------- | ----------------------------------------------- |
| 会话列表（标题、fork 关系等）     | `~/.opc-webui/conversations.json`               |
| DeepSeek API Key 配置   | `~/.opc-webui/config.json`                      |
| 每个会话的完整历史（transcript） | `~/.claude/projects/<工作目录编码>/<sessionId>.jsonl` |

以上数据都保存在用户主目录，删除会话时会**级联删除**其所有 Fork 分支对应的记录与历史文件。

---

## ⚙️ 工作原理（简述）

`webui/server.js` 为每条消息派生一次性的 CLI 会话：

```
node package/cli.js -p "<prompt>" --output-format stream-json \
     --include-partial-messages --verbose --permission-mode <mode> \
     [--model <model>] [--thinking <mode>] [--settings <file>] \
     [--resume <sessionId|jsonl路径>] [--fork-session]
```

- CLI 事件通过 **SSE**（`/api/events`）实时推送到浏览器渲染
- 续聊时自动 `--resume` 上次的 session 恢复上下文；Fork 时附带 `--fork-session` 派生全新会话
- 工具权限请求（`can_use_tool`）转发到页面，用户点选后写回 CLI 的 stdin
- 服务会**剥离 shell 环境里已有的 `ANTHROPIC_API_KEY / AUTH_TOKEN / MODEL`**，避免误用旧 Key，统一使用你在页面保存的 DeepSeek Key
- Web UI 为纯 Node.js 实现，**无需 `npm install`**，除自带的 `package/cli.js` 外无其它依赖

---

## ❓ 常见问题

| 问题                                     | 处理方式                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| 端口被占用                                  | 换个端口：`start-webui.cmd 8788`                                   |
| 提示 `package\cli.js not found`          | `start-webui.cmd` 必须放在仓库根目录（与 `webui\`、`package\` 同级）         |
| 发送报「尚未配置 DeepSeek API Key」             | 先在页面顶部保存自己的 API Key                                           |
| Windows 下 CLI 启动即报 "requires git-bash" | 安装 Git for Windows 并确保 PATH 中有 `git`，服务会自动查找 bash.exe 并传给 CLI |
| 提示会话「正在运行」无法操作                         | 点击「停止」结束当前任务后再切换 / 新建 / 删除                                    |
| 切换会话后没反应                               | 当前有任务在运行时会提示先停止，停止后再切换                                        |

---

## ⚠️ 已知限制

- 仅支持 DeepSeek Anthropic 兼容网关（Key、模型均由该网关提供）
- 每个浏览器标签页同一时间运行一个任务；其余会话须先停止当前任务再操作
- 服务绑定 `127.0.0.1`，仅供本机使用
