# 杀戮尖塔2 中文翻译器

一个 Chrome 扩展：把《杀戮尖塔 2》英文资料站翻译成中文，**使用游戏官方中文译名**，而不是机翻。

已确认可用：[searchthespire.app](https://searchthespire.app/)（杀戮尖塔 2 种子探索器）。理论上任何英文 STS2 站点都能用。

## 为什么需要它

Chrome 自带的网页翻译会把 `Vulnerable` 译成「弱势群体」、`Block` 译成「块」、`Exhaust` 译成「排气」、`Bash` 译成「重击」。这些都不是游戏里的说法（官方分别是**易伤**、**格挡**、**消耗**、**痛击**）。

本扩展内置了一份从游戏文件反编译出来的官方中英对照词典：

| 类别 | 条目数 | 说明 |
| --- | --- | --- |
| 名称 | 1475 | 卡牌、遗物、药水、敌人、角色、事件的名字 |
| 术语 | 304 | 关键词、机制、UI 用语 |
| 整句 | 6860 | 卡牌/遗物描述的完整官方译文 |
| 模板 | 997 | 带数值占位符的描述模板，用于处理升级、变量变体 |

命中词典时**完全离线**，不需要网络、瞬间出结果、100% 是官方译名。只有词典里没有的句子（比如网站的说明文字、攻略正文）才走机翻兜底。

## 安装

1. 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目的 `extension/` 目录
4. 打开任意《杀戮尖塔 2》资料页，点工具栏图标 → 「翻译成中文」

也可以直接安装打包好的 `dist/sts2-translator-1.0.0.zip`（先解压，再按上面步骤加载解压出来的目录）。

## 使用

- **工具栏图标**：翻译 / 还原当前页面，并可勾选「此站点自动翻译」
- **快捷键**：`Alt+T` 翻译或还原（可在 `chrome://extensions/shortcuts` 修改）
- **右键菜单**：「翻译 / 还原此页面」「本页自动翻译（记住此站点）」
- **设置页**：全局自动翻译开关、站点列表管理、词典信息、清空缓存

## 它如何做到「不动布局」

扩展只改写文本节点的内容，**不新增、不删除、不改动任何元素**，也不动 class、属性、结构。

站点把关键词拆进了行内元素，比如：

```html
<p class="game-description">Deal 8 damage. Apply 2 <span class="kw">Vulnerable</span>.</p>
```

一条描述横跨三个文本节点。扩展会先把整块拼起来查官方译文，再把中文**按锚点分配回原来的节点**——「易伤」仍然落在 `<span class="kw">` 里，所以关键词的高亮、颜色、悬浮提示全部照常工作。分配失败时退化为整段写入第一个节点，仍然是纯文本改动，布局不变。

还原时逐字回填原文，做到无痕。

## 目录结构

```
extension/          扩展本体（这就是要加载的目录）
  manifest.json     MV3 清单
  src/core.js       纯函数核心：词典匹配、术语保护、跨节点分配
  src/content.js    内容脚本：DOM 遍历、翻译、还原、动态内容监听
  src/background.js Service worker：翻译请求、缓存、右键菜单
  src/popup.*       工具栏弹窗
  src/options.*     设置页
  data/sts2-dict.json  内置词典（约 1MB）
  icons/            图标
tools/              构建与打包脚本
test/               单元测试与测试页面
```

词典（`extension/data/sts2-dict.json`）已经构建好并随仓库提供，**普通使用不需要原始数据**。

## 开发

```bash
npm install
npm test              # 单元测试（jsdom 里跑真实的 core.js + content.js）
npm run build:zip     # 打包成 dist/*.zip
```

重建词典需要游戏的原始本地化数据。这些文件版权归游戏发行商所有，因此**不随本仓库分发**，用脚本自行拉取：

```bash
npm run fetch:data       # 下载到 data-source/（24 个 JSON × 2 语言，约 4.4MB）
npm run build:glossary   # 生成 extension/data/sts2-dict.json
npm run check:coverage   # 校验官方条目覆盖率
```

`fetch:data` 会先试 Node 的 `fetch`，失败时自动回退到 `curl`。如果你的网络需要代理，设置环境变量后运行：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 npm run fetch:data
```

测试用 jsdom 加载**真实的** `core.js` 与 `content.js` 和真实词典，覆盖：官方术语正确性、元素结构不变、行内关键词定位、升级描述不串扰、还原无痕、机翻兜底、跳过 `translate="no"` 区域、纯符号不翻译。

> 注：Chrome 137+ 的品牌版已移除 `--load-extension` 命令行参数，所以自动化测试走 jsdom 而非 Playwright 驱动真实浏览器。

## 数据来源

词典由 [`ptrlrd/spire-codex`](https://github.com/ptrlrd/spire-codex) 项目反编译游戏文件得到的官方多语言数据构建，感谢该项目。译文版权归游戏发行商所有，本扩展仅作个人阅读辅助。

> ⚠️ 该仓库的 license 标记为 `NOASSERTION`（未明确授权）。因此本仓库**不分发**从游戏文件反编译出的原始数据（`data-source/` 已列入 `.gitignore`），只提供下载脚本。个人自用没有问题；若要商用或再分发词典数据，请先确认授权。

## 许可

本仓库的代码（扩展、脚本、测试）采用 MIT 许可，见 [LICENSE](LICENSE)。游戏文本与译文的版权归其发行商所有，不在该许可范围内。

## 已知限制

- 只处理文本节点。用 `<canvas>` 或图片渲染的文字（部分卡牌图片、图表）无法翻译。
- 机翻兜底依赖免费公共接口，可能限流；此时未命中词典的句子会保持英文，但官方术语部分仍正常翻译。
- 简体中文词典。游戏另有繁体中文数据，尚未接入。
