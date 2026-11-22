# v2.1 历史文件

这里保留旧版本的安全回归测试、未放入 `.github/workflows` 的 CI 文件，以及上传时错误命名为 `download` 的 Git 属性/忽略配置。

它们不是 Chrome 扩展安装文件，不会被扩展加载，也不会被当前 `npm test`、`npm run check` 或 `npm run build` 执行。旧测试针对 v2.1 的接口和行为，不能用于判断原始 v2.2 是否通过安全检查；仅用于历史追溯。

当前检查与构建请在仓库根目录运行：

```sh
npm run check
npm test
npm run build
```

当前检查仅验证发布完整性和语法，不表示 v2.2 的已知安全问题已经修复。
