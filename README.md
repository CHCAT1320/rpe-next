# Re:PhiEdit Next

作者：**cmdysj**。本项目是在原 **Re:PhiEdit（RPE）** 项目基础上，使用 **AI（GPT）** 进行的重构，是 Phigros 的非官方制谱器。

[在线使用](https://kclg-ysj.github.io/rpe-next/) · [源码](https://github.com/kclg-YSJ/rpe-next)

当前版本：**0.7.1**。

基于 Canvas、Web Audio、WebGL 和 IndexedDB，支持音符与事件编辑、实时预览、着色器、多谱面管理、原 RPE 谱面导入、热键及设置迁移。当前仍在持续完善，尚不保证与原 RPE 完全一致；建议保留原始谱面与资源备份。

## 使用

推荐使用桌面版现代 Edge 或 Chrome，开启硬件加速。无需安装即可打开在线页面。

- 在谱面库选择“打开 JSON / PEZ”，可导入谱面包或同时选择谱面、音乐、曲绘。
- 迁移旧 RPE 时，选择包含 `Resources`、`Hotkey.txt`、`Settings.json` 的原 RPE 主文件夹。迁移读取原文件，并复制到当前浏览器谱面库；同标识名项目覆盖前会询问，`extra.json` 随资源迁移。
- 选择谱面进入编辑，默认 Q/W/E/R 放置 Tap/Drag/Flick/Hold，空格暂停或继续。热键可在设置中修改。
- 保存到谱面库后，可导出 PEZ 备份完整资源；单独导出的 JSON 不包含音乐和曲绘。
- shader 仅作用于预览区域，重叠事件按顺序叠加，包括同类型 shader。
- 多选自动打开多音符/多事件编辑，支持脚本、参数历史与命名收藏；事件支持克隆、批量切割和粘合。克隆可选择是否保留源事件，撤销/重做保留对应的多选状态。

## 本地运行

安装 Node.js 22.12 或更新版本，下载源码后在项目目录运行：

```sh
npm install
npm start
```

Windows 也可双击 `start.cmd`（首次运行会自动安装依赖）。开发服务器默认打开 `http://127.0.0.1:5173`，关闭终端会停止服务。想预览生产构建：

```sh
npm run build
npm run preview
```

## Windows 桌面测试版

桌面包内置 Electron 运行环境，解压后双击 `RePhiEdit-Next.exe`，无需另装 Node.js 或浏览器。请保留整个文件夹。当前提供 Windows x64 版本，尚未进行代码签名。

桌面版谱面、配置与自动备份保存在 `%APPDATA%\rpe-next-desktop`，与网页版谱面库独立；可通过 PEZ 导入或迁移原 RPE 文件夹转移项目。

大贴图按需解码，并按当前显示尺度选择缓存分辨率；缩放放大时自动补充更高分辨率。该缓存不改变贴图坐标、逻辑尺寸或导出的原始素材。

仅在需要桌面包时手动运行（不会随网页构建或部署自动生成，脚本会先重新构建 `dist/`）：

```sh
npm ci
npm run build:desktop
```

产物位于 `release/`，只包含程序、内置素材与许可文件；不包含个人谱面和开发记录。开发调试可运行 `npm run desktop`（会先构建 `dist/`，再用 Electron 打开构建产物）。

## 数据与隐私

谱面、媒体、热键、设置和自动备份保存在当前浏览器的本地存储中，应用没有上传谱面的服务器或分析埋点。GitHub Pages 提供静态网页托管，访问网页时托管方可能记录常规访问日志。

不同浏览器、地址、端口及在线/本地版本的谱面库相互独立。清除网站数据可能删除谱面库和自动备份，请定期导出 PEZ。选择原 RPE 文件夹只用于本地读取迁移，不会自动上传文件。

## 开发

开发服务器与构建使用 [Vite](https://vite.dev/)，源码以 TypeScript 编写、界面使用 [Vue 3](https://vuejs.org/) 单文件组件。开发服务器和构建步骤都会处理类型，日常运行不需要额外的编译命令。

`npm test` 不用任何构建步骤：Node 直接以类型擦除方式运行 `test/` 与 `src/` 中的 `.ts` 文件。因此源码不能使用 `enum`、构造函数参数属性（`constructor(private x: T)`）和 `namespace` 这类需要真正生成代码的语法，`tsconfig.json` 里的 `erasableSyntaxOnly` 会让 `npm run typecheck` 一并拒绝它们，保证类型检查通过的写法在测试里也能直接跑。相对导入需要保留 `.ts` / `.vue` 后缀，这与 Node 的解析规则一致。

```sh
npm test
npm run typecheck
npm run build
npm run smoke-build
npm run build:pages
npm run smoke-pages
```

`public/` 下的素材会原样复制进 `dist/`：编辑器在运行时才按需解析贴图、缓动曲线、shader 与音效，所以这些文件不做哈希改名。`build` 生成从域名根路径提供服务的 `dist/`；`build:pages` 生成部署在 `/rpe-next/` 子目录的静态网站。推送到 `main` 后，GitHub Actions 自动测试并部署 GitHub Pages。

### 写代码时的约定

- **类型放哪。** 领域共享类型集中在 `src/core/types.ts`（`Chart`、`JudgeLine`、`Note`、`ChartEvent`、`Beat`、`EventLayer` 等）；只被单个模块使用的类型就地定义并导出。
- **外部数据一律先校验再收窄。** IndexedDB 记录、RPE 工程文件、ZIP 条目都来自磁盘或用户，入口参数用 `unknown` 接住，校验后收窄，不要直接断言成结构体。校验函数用断言签名（`assertChart(chart: unknown): asserts chart is Chart`），让调用方无法跳过检查。
- **类要显式声明字段**，包括那些只在构造函数里赋值的。未声明的字段会被推断成过窄的类型（例如 `notes: never[]`），进而在调用方产生成百上千的连锁报错。
- **不要用 `any`、`@ts-ignore`、`@ts-expect-error`**，也不要为了消除报错而放宽 `strict`。如果某个类型确实无法精确表达，用 `unknown` 加收窄，并在注释里写明原因。同样不要删掉校验分支或把 `throw` 改成静默返回。
- **保留原有的中文错误信息与注释意图**：注释可以用英文重写，但含义不能丢。

## 许可与来源

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE)，仅许可符合条款的非商业用途，商业用途需另行取得授权。它属于源码可用许可，不是 OSI 定义的开源许可。再分发须保留许可证及 [NOTICE](NOTICE) 中的必需声明。

原 RPE 代码与素材是本次重构的基础，保留其来源及相应权利；独立第三方内容的原有权利和许可不因本项目许可而改变。本项目并非 Phigros 官方产品。
