# 组合贷提前还款计算器

一个纯前端静态网页工具，用来测算公积金贷款、商业贷款和组合贷在提前还款后的变化，并比较：

- `缩短年限`
- `减少月供`
- `提前还款` vs `保留现金继续投资`

当前版本支持：

- 公积金和商贷分别录入
- `等额本息`、`等额本金`
- `执行利率` 模式
- `LPR + 加减基点` 模式
- 录入 `当前月供` 后按账单月供校准等额本息
- 自定义提前还款分配策略

## 在线发布

这个项目是纯静态站点，适合直接部署到 GitHub Pages。

部署后默认入口文件为：

- `index.html`

## 本地使用

直接用浏览器打开 `index.html` 即可。

如果你想本地起一个简单静态服务，也可以：

```bash
cd loan-calculator
python3 -m http.server 8080
```

然后访问：

- `http://localhost:8080`

## 文件结构

```text
loan-calculator/
├── index.html
├── styles.css
├── app.js
├── .gitignore
├── LICENSE
└── README.md
```

## GitHub Pages 发布步骤

1. 在 GitHub 新建一个仓库，比如 `loan-calculator`
2. 本地进入项目目录并初始化 git
3. 提交代码并推送到 GitHub
4. 在 GitHub 仓库设置中开启 `Pages`
5. 选择从当前分支发布，目录选 `/ (root)`

参考命令：

```bash
cd /Users/herr.konig/workspace/loan-calculator
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

## 使用提醒

- 不要把真实贷款截图、账号、身份证、银行卡等敏感信息提交到仓库
- 默认示例数据建议只保留演示用途，不要写入真实个人数据
- 银行实际提前还款结果仍可能受办理日、整万元规则、重定价规则和系统口径影响

## License

MIT
