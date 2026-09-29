# kobalab-bot — 在 Akagi 上运行电脳麻将 AI 的桥接 Bot

一个 [Akagi](https://github.com/shinkuan/Akagi) 的 mjai Bot，背后驱动的是
[`@kobalab/majiang-ai`](https://github.com/kobalab/majiang-ai) —— 電脳麻将
（小林圣的三人/四人麻将练习应用）的思考ルーチン，**原库不做任何修改**。

这两个项目没法直接拼在一起，所以本仓库的本质是一个**桥接器（bridge）**：

| | Akagi | majiang-ai |
| --- | --- | --- |
| 形态 | Tauri/Rust 桌面应用 | Node.js 库 |
| Bot 接口 | 一个**子进程**，在 stdin/stdout 上说 JSON 行 | 进程内的 `Majiang.Player` 子类，靠**回调**应答 |
| 协议 | **mjai**（`dahai`、`tsumo`、`reach`…） | **majiang-core** 消息（`dapai`、`zimo`、`lizhi`…） |
| 驱动方式 | 一批请求 → 一个动作 | 引擎推送事件，玩家在回调里作答 |
| Akagi 寻找的入口 | `bot.py` | JavaScript |

```
Akagi (Rust)                                    mjai_bot/kobalab/
   │  启动 venv-python bot.py <seat>             ┌────────────────────────┐
   ├────────────────────────────────────────────►│ bot.py   （薄垫片）      │
   │   stdin : 每行一个 JSON 数组（事件批次）      │  subprocess.Popen       │
   │   stdout: 每行恰好一个 JSON 动作              │   ↓ stdin    ↑ stdout   │
   │   stderr: 日志 + @@AKAGI_NOTIFY@@ 通知        └───┬────────────────────┘
   │                                                  │ node bridge/main.js
   └──────────────────────────────────────────────────┤  mjai ⇄ majiang 双向翻译
                                                      └─ require('@kobalab/majiang-ai')
```

---

## 一、实现原理

### 1.1 核心机制：三层桥接

```
Akagi                    bot.py (Python 垫片)            bridge/ (Node)                 majiang-ai
  │  JSON 行批次  ──────────►  逐行透传  ──────────►  main.js JSONL 主循环              │
  │                            │                       ├─ tiles.js      牌记法互译        │
  │                            │                       ├─ to_majiang.js mjai→majiang 模型 │──► Majiang.Player
  │                            │                       ├─ from_majiang.js 决策→mjai 动作  │◄── 回调决策
  │                            │                       └─ show.js      候选→HUD 卡片      │
  │  ◄──────────  每批恰好一个动作  ◄────────────────────┘                                 │
  └─ 注意：majiang-ai 全程原样使用，本仓库不修改上游库的任何一行
```

一次决策的完整链路：

1. **入口**：Akagi 按 `manifest.toml` 启动 `python bot.py <座位号>`，`bot.py` 只做三件事——找到 Node（见 [2.6](#26-在-akagi-里安装并激活)）、拉起 `node bridge/main.js <座位号>` 子进程、双向泵送 stdin/stdout（每行即时 flush）。所有诊断走 stderr，stdout 上只有协议 JSON。
2. **翻译进来**：`to_majiang.js` 把每条 mjai 事件翻译成 majiang-core 消息，喂给一个内部维护的 `Player` 模型。模型里**四家**的手牌都在——我方是真实手牌，其他三家是"占位手牌"，对手的手牌与摸牌按库自己的约定屏蔽为 `'?'`/`'_'`。
3. **决策**：majiang-ai 在模型上跑 `select_dapai` / `select_fulou` / `select_lizhi` 等评估，通过回调返回选择。
4. **翻译出去**：`from_majiang.js` 把决策转成 mjai 动作，先过**合法性闸门**（见 1.2 第 6 条），再由 `show.js` 生成 Akagi HUD 卡片塞进 `meta.show`。
5. **输出**：`main.js` 保证**每批恰好回一个动作**——没有决策就回 `{"type":"none"}`；桥内任何异常都被捕获成 `none` + 一条 stderr 日志，绝不死进程（Akagi 会杀掉不应答的 bot）。

### 1.2 十个关键设计（每一条都对应一个真实踩过的坑）

以下全部是与上游库对照实验得出的结论，并在代码中用到它的位置有注释。它们看起来不该这么长——因为做错任何一条的失败模式都是**静默**的：决策丢失、HUD 数字错、或模型悄悄和牌桌不同步。

1. **座位坐标系。** majiang-core 用同一套下标表达两种含义（`Player` 的 getter 按门风 `_menfeng` 索引模型，`Board` 按事件的 `l` 读写），而 mjai 给的是绝对座位。桥接器把 `kaiju.qijia` 设为本局基础庄家、把我方手牌存在**门风**下标上，用 `(actor - qijia - jushu) % 4` 平移每个事件的 actor。特别注意：**`jushu` 是"本轮内第几局"（0–3），整场的局数由 `zhuangfeng` 承载**——把全场手数喂进去，南二局起 `(id+8-qijia-jushu)%4` 变负，`SuanPai.qipai` 索引到 `undefined` 抛错，之后 bot 全程只会答 `none`。

2. **牌墙计数双口径。** `SuanPai._n_zimo` 是所有"牌还剩几张"估计的**全局缩放因子**，而 AI 的合法性检查读的是 `Board.shan.paishu`。桥接器精确追踪牌墙并在**每次决策时同时重申两者**。口径与库一致：每次摸牌扣 1（对手被屏蔽的摸牌也算，AI 对它们只减计数器，恰好正确）；杠扣 1，且**在岭上摸牌那一步扣**（`Majiang.Shan` 的 `gangzimo` 平移的就是 `zimo` 弹出的同一个数组）；杠的新宝牌指示牌**不单独扣**——若在宣告时扣，杠与岭上摸之间两个计数会差 1，而决策可能正落在这个区间里。

3. **自家弃牌即时应用。** 引擎不一定可靠地把"你自己的弃牌"告诉你，所以桥接器在 AI 返回选择的**那一刻**就把它应用进模型，而不是等一个可能永远不来的回声。且必须走 `Player.dapai` 而不是直接改模型——正是这次调用维护着 AI 要读回的状态：立直标记（连带 1000 点与立直棒）、`_diyizimo`（卡住会让"九种九牌"中途再次出现）、`_neng_rong`（**临时振听唯一会被清除的地方**，跳过它会让一次漏荣和变成整局永久振听）。

4. **永不应答自己的弃牌。** Akagi 会把我方弃牌回显给所有四家；再喂给 AI 会把弃牌应用第二遍——牌已经不在手里，`Shoupai.dapai` 抛错，后续事件全部被拒，bot 只能答 `none`（这就是当年"鸣牌之后 bot 卡住"的真身）。回声现在被吸收而不是再应用；自家的吃碰回来时同理。

5. **不鸣也是一次决策。** majiang-ai 非常保守，**大多数鸣牌窗口以不鸣告终**，而它不记录自己否决的鸣牌——被拒绝的鸣牌一度毫无输出。现在驱动器用 AI 自己的评估器（仅用一次性克隆）重新推导对比，HUD 给出"鸣牌判断"卡解释沉默（见 1.3）。

6. **每个应答都过合法性闸门。** 动作只有在模型允许时才发出，否则一律 `{"type":"none"}`。mjai 流本身不带合法动作集，桥接器用与 AI **同一套库谓词**（`MajiangDriver.lastLegal`）从自己的模型推导出一个**类型级**合法集：手中途荒牌、牌墙不允许的立直、没有面子的吃碰、振听状态下的荣和……类型不对就不发。具体选哪张牌是 AI 的事（它就是从这些列表里挑的）；沉默可以恢复，把牌局状态搞乱不能。

7. **立直是一个动作。** mjai 把立直拼成"宣告 + 宣告所打的牌"两个动作，但 Akagi 每批只读一个动作、把宣告牌记在 `Reach.pai` 上（官方文档承认的非规范扩展），自动出牌会卡死在不带弃牌的 `reach` 上。塞进 `meta` 的内容会被无视——Akagi 的 `meta` 是自由格式 HUD 数据，后端从不解释它。

8. **被屏蔽的摸牌也必须喂进模型。** 模型持有全部四家的手牌。被屏蔽的三家用 `Board.qipai` 填了 13 张**空白**，而该座位**每一条**事件都在消耗它：`Shoupai.decrease` 对"手里没有的牌"吃一张空白——出牌扣 1、吃碰各扣 2、暗杠扣 4，只有摸牌补回一张。所以对手的 `tsumo`（牌是 `"?"`，看似"没有东西可应用"）恰恰是**维持占位手牌不空**的唯一事件。跳过它：该座位第 13 次出牌时占位见底、`decrease` 抛错；又因为 `Board.dapai` **先扣空白、再记河牌**，抛错会把这条河牌一起带走，之后对这张牌的吃碰也跟着失败。桥接器因此对**四家**的摸牌都走 `Player.zimo`，对手用 `'_'`（库自己的"看不见的牌"记号）。

9. **面子串里红五/被叫牌是位置性的。** `He.fulou` 从面子串恢复"被叫的那张牌"的方式是"**标记紧跟的那一位**"，再与打牌者的河牌比对——对它来说 `p5` 与 `p0` 是两张不同的牌。所以副露必须写成 **手里的张在前、被叫那张最后、标记落在它身上**（库自己的写法：手里有红五时碰普通五写 `s50` + `5` + `=`，碰红五写 `s55` + `0` + `=`）。任何其他拼法都会把标记落在"错的那个五"上，碰被静默丢弃。

10. **玩家可以覆盖 bot 的选择。** 手动游玩时 bot 的回答只是**建议**：真正离开手牌的是玩家打的那张，它以回声的形式回来，可能和桥接器已经应用的选择**不同**。这个差异是信息不是噪声——吞掉它（曾经的实现）会在模型里留一张幻影牌，此后每一轮候选都建立在你没有的手牌上，直到 AI 恰好打掉幻影才"自愈"（这就是"候选牌与实际手牌不一致"的根源）。现在回声会被**对账**：bot 选的牌放回模型手牌，玩家实际打的那张走正常弃牌路径取出（河牌、振听记账随真实弃牌走），那次没发生的弃牌再从河牌、危险表和立直标记里撤销。

### 1.3 HUD 覆盖层

只有发生真实决策时才出卡片，分两种：

**AI 鸣了** —— 按评分排序的鸣牌候选，选中的在最上：

```
鸣牌候选（选 2m）
  碰 2m      868   听牌
  不鸣 (Pass) 826   向听 1
```

**AI 没鸣** —— 给出"鸣牌判断"卡，因为沉默本身有误导性：

```
鸣牌判断（不鸣，对方打 3s）
  不鸣 (Pass)  2066   向听 1
  碰 3s           0   听牌 · 听牌前进 1 · 差 -2066     ← 红色
```

标题写的是**对方打**，不是"打"——鸣牌窗口里提到的牌是**对家的弃牌**（你被鸣的那张），而弃牌卡的标题才是自己将打出的牌。两者曾共用"打 X"，结果"手里根本没有 3s 的碰被拒"看起来就像"建议你打 3s"。每行的数字用 AI 自己的 `eval_shoupai` 与 `get_paishu()` 计算，与决策同一货币；某个被拒的鸣牌若其实更优，会标绿色而不是红色，让罕见的错过可见。

普通的摸切回合、以及完全无鸣牌可能的对手弃牌，都不会出卡片。

### 1.4 验证体系

两层，全部可离线运行：

```sh
# 第一层：逐层单测（纯 Node，无测试框架依赖）
node test/test_tiles.js        # 记法、红五、面子拼写、序列化
node test/test_decisions.js    # 决策 → mjai 动作，含 Akagi 的 schema
node test/test_translator.js   # 事件流 → majiang、牌墙记账、杠
node test/test_bridge.js       # 批次进、单动作出
npm test                       # 四套全跑

# 第二层：整局对账（与引擎牌面逐消息比对）
npm run harness                # = node probe/harness.js --games 2 --rounds south
node probe/harness.js --games 6                     # 每座位 6 局种子对局
node probe/harness.js --games 2 --rounds east --seed 97
node probe/harness.js --games 12 --override         # 模拟玩家手动覆盖出牌
```

harness 用 `Majiang.Game` 打真实对局，把桥接器注入为其中一个座位的玩家，喂给它**被屏蔽的** mjai 视图（对手手牌与摸牌换成 `"?"`），每条消息之后把桥接器的模型与**引擎自己的棋盘**比对——暗牌、副露、活牌墙数。当前量级：单测 **487 断言**；卡片一致性探针 16 局 / 8913 次决策 / 2676 张卡片，候选与手牌不一致 **0**、事件被拒 **0**；整局扫查 **116 局 / 1298 手 / 122,127 条消息零偏差**（东南战 + 东风战），另有带手动覆盖的 12 局 / 107 手 / 10,700 条消息零偏差。

让这个比对值得相信的两点（都是吃过亏学来的）：参照物必须来自**引擎**（桥接器和自己比是空洞的真）；比对必须知道两者在哪一步"合理地差一拍"（引擎先落盘再通知，我方的回应要等返回后才落盘）。

### 1.5 已知限制

- **仅四人麻将。** `manifest.toml` 声明 `supported_modes = ["4p"]`，Akagi 的三麻开关会被禁用；`bot.py`/桥接器对三人局直接拒绝。原因很具体：`SuanPai` 把活牌墙硬编码为 70 张（三麻是 55），且库没有拔北规则。
- **线上没有 `qijia`。** Akagi 的 `start_game` 不带本局基础庄家，桥接器假定"bot 自己的座位就是基础庄家"。这个视图内部自洽，对 AI 的比较运算已经够用。
- **合法性闸门是类型级的。** 它拦得住"当前根本不存在这类动作"，拦不住"类型允许但该实例不合法"（比如吃错了具体哪张）。要看住实例级别需要真正消费 Akagi 自己的合法集。
- **规则预设只有两个。** `tenhou` 与 `majsoul` 只差"是否允许食替"，其余都用库的天凤形默认（红五、食タン、头跳）。其他规则需要改 `bridge/main.js`。

### 1.6 许可

`@kobalab/majiang-ai` 与 `@kobalab/majiang-core` 为 MIT，本桥接器同为 MIT。bot 以独立 OS 进程、经管道交换 JSON 的方式运行——与 Akagi 依赖 AGPL bot 的边界一致，没有任何代码链接进 Akagi。

---

## 二、使用指南（从克隆到运行）

### 2.1 环境准备

| 软件 | 版本要求 | 用途 |
| --- | --- | --- |
| Node.js | **≥ 18**（运行必需） | `bot.py` 靠它启动桥接器；打包机器不需要 |
| npm | 随 Node 附带 | 安装 JS 依赖 |
| Git | 任意较新版本 | 克隆仓库 |
| Python | ≥ 3.10（**仅打包/开发需要**） | 运行 `pack_kobalab.py`、跑安装布局验证 |
| uv | 任意（仅 Akagi 目标机需要） | Akagi 点 "Install environment" 时自动使用，无需手动安装 |

克隆仓库：

```sh
git clone https://github.com/raidenkl/kobalab-bot.git
cd kobalab-bot
```

### 2.2 安装依赖

```sh
npm install --omit=dev        # 或 npm ci（严格按 package-lock.json 锁定版本）
```

- `package.json` 只声明两个运行时依赖：`@kobalab/majiang-ai` 与 `@kobalab/majiang-core`。
- **uv 与 npm 各管一半，互不替代**：uv 构建 `bot.py` 运行的 Python venv（依赖为空，只建环境）；npm 提供 `bridge/` require 的 Node 库。`pyproject.toml` 的 `dependencies` 留空是 Akagi 的硬性要求，不是 Node 依赖的声明处。
- 注意：若你拿到的是**发布 zip**，`node_modules` 已内置，装进 Akagi 后不需要任何 npm 步骤；只有从源码克隆运行才需要本步骤。

### 2.3 克隆后先跑一遍验证

```sh
npm test            # 四套单测，应全绿
npm run harness     # 两局种子对局，应输出 "bridge model matched the engine after every message."
```

harness 位于 `probe/`，bot 文件在仓库根，它能自动解析这两种布局（仓库布局与安装后布局同构）。若改动代码，发布前请用较大的 `--games` 值跑扫查——单点失败是大海捞针，扫查才是门槛。

### 2.4 配置说明

Bot 的设置项声明在 `manifest.toml`，在 Akagi 的 Bots 面板里修改：

| 设置项 | 取值 | 说明 |
| --- | --- | --- |
| `rule_preset` | `tenhou`（默认）/ `majsoul` | 规则预设，两者仅"是否允许食替"不同 |
| `show_candidates` | 布尔 | 是否在 HUD 显示候选列表卡片 |

两个要点：

- **设置在 Akagi 启动 bot 时（即开局时）生效**。对局中途的修改从**下一局**开始起作用。
- 如果设置保存不上，十有八九是 bot 目录名不对（见 2.6）。用自带的诊断工具看整条设置链路每一环到底写了什么：

  ```sh
  cd <akagi>/mjai_bot/kobalab
  node doctor.js
  ```

  它逐个打印 `manifest.toml` → `settings.toml` → `.akagi/resolved_settings.json` → `AKAGI_BOT_CONFIG` 的字面内容，第一处不一致会直接可见。

### 2.5 不装 Akagi 也能跑

桥接器就是个普通程序，可以手动喂数据：

```sh
# 最小启动测试：stdin 给一行 start_game，应立即回一行动作（通常是 {"type":"none"}）
echo '[{"type":"start_game","names":["a","b","c","d"],"id":0,"num_players":4}]' | node bridge/main.js 0

# 喂一份真实的 JSONL 牌谱批次
node bridge/main.js 2 < batches.jsonl
```

输出示例（每批恰好一行动作，HUD 卡片在 `meta.show`）：

```
{"type":"dahai","actor":2,"pai":"1m","tsumogiri":false,
 "meta":{"show":{"title":"打牌候选（选 1m）","items":[…]}}}
```

### 2.6 在 Akagi 里安装并激活

两种进入方式，终点相同：

- **Akagi 安装器（推荐）**：Bots 页 → 从本地 zip 安装 → 选 `kobalab.zip`（构建方法见第三节）。什么都不用改名——压缩包的顶层目录就是 `kobalab`，安装器按 zip 文件名词干命名 bot，目录自然正确。
- **手动解压**：把包解开成 `<akagi>/mjai_bot/kobalab/bot.py`。常见错误是解出嵌套的 `kobalab/kobalab/`。

然后依次：

1. **确认 Node.js ≥ 18 可用。** Akagi 不内置 Node。垫片的查找顺序：`KOBALAB_NODE` 环境变量 → `PATH` 上的 `node`/`node.exe`/`nodejs` → 常见安装位置（`C:\Program Files\nodejs\node.exe`、nvm-windows、WindowsApps、用户级安装、Chocolatey、Scoop）。每个候选都会先跑 `--version` 验证（专门防 Microsoft Store 的 App Execution Alias：文件存在但不是正常可执行文件）。找不到时 bot 会主动弹通知，而不是让 Akagi 每回合超时。

   若 Node 已装好但 bot 说找不到：多半是 Akagi 启动时没继承你的用户 PATH（装 Node 时 Akagi 正在运行是常见原因）。重启 Akagi，或者干脆指定路径：

   ```powershell
   setx KOBALAB_NODE "C:\Program Files\nodejs\node.exe"
   ```

   （`setx` 只影响之后启动的进程，改完要重启 Akagi。）不想全局装 Node 的话，解压一份 Node 便携版到任意目录、把 `KOBALAB_NODE` 指到它的 `node.exe` 即可。

2. **bot 目录必须叫 `kobalab`**（最终形如 `<akagi>/mjai_bot/kobalab/bot.py`）。这不是美观问题：Akagi 以"含 `bot.py` 的目录名"标识 bot——Bots 列表、`settings.toml`、UI 行全按它做键。名字不一致的表现就是"设置保存不上"：面板写进一个名字、读的是另一个。同一个 zip 若被存成 `kobalab-bot.zip`，就会装进 `mjai_bot/kobalab-bot/` 并触发这个问题。Akagi 解析 `bot.dir`（默认 `mjai_bot`）时先相对其可执行文件目录、再相对工作目录；Bots 页每个 bot 下方会打印解析出的路径，那是最快的确认方式。

   ```
   akagi-<版本>-windows-x64/
   └── mjai_bot/
       └── kobalab/          ← 目录名必须是 kobalab
           ├── bot.py
           ├── manifest.toml
           └── …
   ```

3. **在该行点 "Install environment"。** Akagi 强制每个子进程 bot 都有 `pyproject.toml`（用于 `uv sync`），本仓库内置了一个零依赖的最小版本，这一步只创建 venv、什么也不装，很快。之后 `bot.py` 在该 venv 的解释器下运行。

4. **打开该行的 4p 开关。** 第 3 步没跑过之前开关是禁用的（Akagi 拒绝激活环境未安装的 bot，避免第一局卡在同步上）。

> **重装/升级**：Akagi 拒绝覆盖已存在的 `mjai_bot/kobalab/`，装新版前先删掉旧目录。

---

## 三、打包成可导入 Akagi 的 zip

### 3.1 本地打包

```sh
cd kobalab-bot
python pack_kobalab.py        # 需要 Python ≥ 3.10，无第三方依赖
```

输出到仓库根：`kobalab.zip`。脚本自动处理三件**承重**的事：

1. **文件名必须是 `kobalab.zip`**——Akagi 按 zip 词干命名 bot，存成别的名字会触发 2.6 里的"设置存不上"。
2. **恰好一个顶层目录 `kobalab/`**——Akagi 解包时剥掉一层，`kobalab/…` 落成 `mjai_bot/kobalab/…`；带绝对路径或 `..` 段的条目会被 Akagi 拒收，脚本在构建时就校验。
3. **该带的带上、该排的排掉**：
   - **必须内置 `node_modules`**——Akagi 安装时没有 npm 步骤；
   - **不得包含** `.akagi/`（目标机上 Akagi 建的 venv 与同步戳）、`settings.toml`（用户自己的设置）；
   - 仓库自身的水管也不进包：`pack_kobalab.py`、`.github/`、`.gitignore`、`.gitattributes` 由脚本显式排除，装进 Akagi 的永远是纯粹的 bot。

构建是**字节可复现**的：条目排序、时间戳固定为 1980-01-01，同一棵树两次构建 sha256 一致，可以和 CI 产物互相校验。

打包后建议按安装布局复验一遍（而不是只信开发目录）：

```sh
# 把 zip 解到 <akagi>/mjai_bot/kobalab/ 后，在该目录里：
npm test                          # 四套单测
node probe/harness.js --games 2   # 整局对账
node doctor.js                    # 设置链路（此时仅缺 settings.toml 属正常）
echo '[{"type":"start_game","names":["a","b","c","d"],"id":0,"num_players":4}]' | python bot.py 2
```

### 3.2 通过 GitHub Actions 自动发布（推荐）

仓库自带 `.github/workflows/release.yml`：**推送 `kobalab-v*` tag 即自动发布**——CI 会 `npm ci` 装依赖 → `npm test` 当门槛（单测不过不出包）→ `python pack_kobalab.py` 构建 → 把 `kobalab.zip` 挂到该 tag 的 GitHub Release（不存在则自动创建，附自动 release notes）。

```sh
git tag kobalab-v0.2.3
git push origin kobalab-v0.2.3     # 这一条命令就是完整的发版流程
```

也可以在 Actions 页用 `workflow_dispatch` 手动重跑（比如改完 Release 说明后重挂附件）。

> ⚠️ **必须用 `kobalab-v*` 前缀，不要用裸 `v*`，更不要 `git push --tags`。** 本仓库因 `git fetch upstream --tags` 带有 majiang-ai 上游的四十多个 `v*` tag，裸前缀会让它们也触发发布、还会和 bot 自己的版本号撞名。上游 tag 只留在本地做观察用。

### 3.3 导入 Akagi

构建/下载得到 `kobalab.zip` 后，按 2.6 的步骤安装：**保持文件名 `kobalab.zip` 不变** → 若装过旧版先删 `<akagi>/mjai_bot/kobalab/` → Bots 页安装（或手动解压）→ 点 **Install environment** → 打开 **4p** 开关。装好后对局中就能看到 HUD 候选卡片；对 bot 行为有疑问时，看 stderr 里 `[kobalab-shim]` / `[kobalab]` 开头的日志行，其中带有座位、牌墙计数与每次决策的类型。

---

## 附录：仓库目录结构

```
kobalab-bot/                （git 仓库根）
├── bot.py              Akagi 入口：拉起 Node 桥接器并接通 stdio
├── pyproject.toml      Akagi 硬性要求；零依赖，只为建 venv
├── manifest.toml       展示元数据、supported_modes=["4p"]、设置项声明
├── package.json        @kobalab/majiang-ai + majiang-core（由 lockfile 锁定）
├── package-lock.json   依赖锁定（CI 与本地安装以此为准）
├── node_modules/       两个上游库（打包时内置；git 不跟踪，npm install 可重建）
├── doctor.js           设置链路诊断：在 bot 目录里 node doctor.js
├── bridge/
│   ├── main.js         JSONL 主循环；每批必答一个动作
│   ├── tiles.js        mjai ⇄ majiang 牌与手牌记法互译
│   ├── to_majiang.js   mjai 事件流 → 驱动 majiang-core Player 模型
│   ├── from_majiang.js Player 决策 → mjai 动作（含合法性闸门）
│   └── show.js         候选列表 → Akagi 的 meta.show HUD 卡片
├── test/               四套逐层单测（node test/test_tiles.js …）
├── probe/harness.js    整局对账：与 majiang-core 引擎棋盘逐消息比对
├── pack_kobalab.py     构建可安装的 kobalab.zip（CI 同用此脚本）
└── .github/workflows/release.yml   推送 kobalab-v* tag → 构建 zip → 挂到 Release
```

版本历史见 [CHANGELOG.md](CHANGELOG.md)。
