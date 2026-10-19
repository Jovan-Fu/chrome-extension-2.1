# 智能截图助手 Pro

Chrome Manifest V3 扩展：截取视频画面或框选区域，保存到 Google Drive，并将分类、备注、来源和图片链接写入 Google Sheets。支持 OCR、视频语音转文字及中文翻译。

> **使用边界：当前版本仍存在 GAS 匿名访问和图片公开分享两项 High 风险，不适合处理敏感截图。** 这些行为按本轮开发者选择保留，具体见 [SECURITY.md](SECURITY.md)。

## 功能

- 支持 Facebook、YouTube、Instagram、TikTok、Pinterest、Behance、Dribbble、Flickr。
- 视频截图、自由框选、连续保存；分类和横排 / 竖排表格布局。
- OCR.Space 图片识别、Groq Whisper 语音识别。
- Groq `openai/gpt-oss-20b` 中文翻译；失败时降级到 Google 翻译。
- 配置导入 / 导出；导出不包含 API Key。

## 安装与配置

### 1. 加载扩展

1. 下载并解压源码，或解压 `dist/chrome-extension-2.1.zip`。
2. 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。

### 2. 部署 Google Apps Script

1. 在 [Apps Script](https://script.google.com/) 新建项目，将 [apps_script.gs](apps_script.gs) 的内容粘贴到脚本编辑器。
2. 选择“部署 → 新建部署 → Web 应用”。
3. 当前实现使用“以我自己身份执行”和“所有人（含匿名用户）”访问方式。**这不构成用户隔离，接口本身也没有鉴权。** 不要处理敏感资料，建议每位使用者独立部署。
4. 完成授权并复制 `https://script.google.com/macros/s/.../exec` 部署地址。
5. 每次更新服务端脚本后，必须部署新版本，修改才会生效。

### 3. 填写扩展配置

点击工具栏扩展图标，填写 GAS 部署地址、表格 ID、网盘文件夹 ID，按需填写 Sheet 名称。

表格及文件夹必须允许 **GAS 部署者账号** 访问。填写别人的资源 ID 不会改变脚本执行身份。Groq / OCR.Space Key 在扩展的“OCR/AI”页自行填写，不要提交到仓库或发到 Issue。

打开支持的平台并刷新页面，使用右侧悬浮按钮截图或提取台词。`tabCapture` 语音兜底受浏览器用户激活和流消费权限限制，仍需真实浏览器验证。

## 数据去向

| 操作 | 接收方 |
| --- | --- |
| 图片 OCR | OCR.Space |
| 视频语音转文字 | Groq |
| 文字翻译 | Groq；失败时 Google 翻译；没有 Groq Key 时直接使用 Google 翻译 |
| 保存截图及记录 | GAS 部署者可访问的 Google Drive / Sheets |

当前默认打开截图弹窗即自动 OCR。上传图片会尝试设为“知道链接的任何人可查看”。预览、台词和备注显示在宿主网页 DOM 中，页面脚本可能读取。完整边界见 [安全说明](SECURITY.md)。

## 开发、测试与打包

要求 Node.js 22 或更高版本。**没有第三方 npm 包依赖，无需运行 `npm install`。**

```sh
npm run check
npm test
npm run build
```

不使用 npm 时，可直接运行对应命令：

```sh
node scripts/check.cjs
node --test tests/security.test.cjs
node scripts/build.cjs
```

构建产物：

| 文件 | 用途 |
| --- | --- |
| `dist/chrome-extension-2.1.zip` | 仅包含 7 个扩展运行文件；解压后加载，也可作为扩展分发包 |
| `dist/github-source-2.1.zip` | 完整源码、GAS、说明、测试及 CI，适合分享或上传 GitHub |
| `dist/SHA256SUMS.txt` | 两个 ZIP 的 SHA-256 校验值 |

构建采用固定文件清单，原始归档、私人配置、测试日志和构建目录不会被打入源码包。ZIP 只包含所需的运行文件，不代表已通过 Chrome Web Store 审核。

28 项测试是离线测试，Chrome API、DOM、GAS 使用模拟对象。实际账号权限、翻译费用与效果、图片分享和真实浏览器操作仍需联调。

## 上传 GitHub

新建仓库，上传本目录的源码文件及 `.github` 等隐藏文件；不要把 ZIP 当成源码唯一文件上传。也可用 Git：

```sh
git init
git add .
git commit -m "Prepare audited screenshot assistant project"
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

先替换示例仓库地址。`.gitignore` 已忽略本地凭据、导出配置、`node_modules` 和 `dist`。如启用 CI，推送或 PR 会执行检查、测试和构建；CI 没有部署步骤，不需要 API Key。

## 项目结构

```text
manifest.json / background.js / content.js / content.css
popup.html / popup.js / icon.png   Chrome 扩展运行文件
apps_script.gs                   Google Apps Script 服务端
tests/security.test.cjs           安全回归测试
scripts/check.cjs                 语法和清单检查
scripts/build.cjs                 可复现 ZIP 构建
.github/workflows/ci.yml          检查、测试、构建
SECURITY.md                       当前安全边界
CHANGELOG.md                      本轮改动
```

## 许可证

沿用原项目声明的 [MIT License](LICENSE)。
