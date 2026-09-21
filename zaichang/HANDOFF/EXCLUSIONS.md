# 排除项与重建方法

分类只决定包内选择，没有删除、移动或清理原仓库。体积来自只读文件元数据；私密和运行数据没有读取内容、没有计算内容哈希。完整选择在 SELECTION-MANIFEST.json。

| 路径 | 排除文件数 | 原始排除体积 MiB | 理由 / 重建 |
|---|---:|---:|---|
| `.test-data` | 41389 | 11536.25 | 隔离数据库、故障运行资料及旧源码基线；测试可生成新数据，不能伪造原 B1 历史快照。 |
| `release` | 20357 | 1830.48 | 可执行产物不是源码；后续按源码安装、构建和打包。 |
| `node_modules` | 17784 | 644.19 | npm ci 依据 package-lock 重建；安装缓存不是源码。 |
| `build` | 30204 | 587.53 | runtime-staging 与生成配置可由安装/打包流程重建；仅图标包含。 |
| `artifacts` | 9769 | 572.01 | 原始报告、截图、模型/工具正文及账户记录全集不分发；HANDOFF只含重新整理的统计。 |
| `.git` | 3616 | 366.41 | 版本库对象与索引不分发；当前HEAD不足以还原未提交成果。 |
| `.runtime` | 18164 | 347.86 | 固定 setup:hermes 从上游及 uv.lock 重建；不复制本机环境或状态。 |
| `dist` | 106 | 7.17 | npm run build 重新生成。 |
| `tmp` | 33 | 5.14 | 临时探针/截图/输出，不参与当前源码闭包。 |
| `dist-electron` | 4 | 3.92 | npm run build 重新生成。 |
| `tmp-probe.cjs` | 1 | 1.23 | Not part of default source scope; requires dependency review. |
| `tmp-live.cjs` | 1 | 1.18 | Not part of default source scope; requires dependency review. |
| `output` | 1 | 0.44 | 历史生成文档和输出，不参与当前产品。 |
| `在场-Harness-审查研究与语义重构包` | 15 | 0.27 | Historical design; retain only verified dynamic test dependencies. |
| `在场-手机驻留式演进-v2-研究与Codex实施包` | 9 | 0.18 | Historical design; retain only verified dynamic test dependencies. |
| `在场-Harness-设计与Codex实施包` | 11 | 0.15 | Historical design; retain only verified dynamic test dependencies. |
| `在场-Harness-人本协作设计与Codex实施包` | 5 | 0.06 | Historical design; retain only verified dynamic test dependencies. |
| `在场-Harness-理解与行动-设计实施包.zip` | 1 | 0.05 | Old archive or log; excluded to avoid duplicates and private data. |
| `tmp-meta.json` | 1 | 0.05 | Not part of default source scope; requires dependency review. |
| `scripts` | 1 | 0.04 | Unused historical PDF generator with a hardcoded original-machine write path; not an app/build/package/test dependency. |
| `tmp-probe.ts` | 1 | 0.00 | Not part of default source scope; requires dependency review. |
| `tmp-print-argv.mjs` | 1 | 0.00 | Not part of default source scope; requires dependency review. |
| `tmp-print-argv.cmd` | 1 | 0.00 | Not part of default source scope; requires dependency review. |

`scripts/build-harness-pdf.py` 未被 package 命令或其他源码引用，是硬编码原机输出路径的历史文档生成器，故从默认 scripts 选择中排除。其原文件没有更改。保留的旧验收 JSON、两份人本规范及其一致性文件、旧 CHECKSUMS 是实际测试/证据脚本的动态依赖，路径不变。

历史研究、手机驻留规格和旧 minimal-core 等只在血统说明中概括，未纳入主阅读路径。`check-project-docs.mjs` 是完整原仓库索引检查，仍期待已排除的历史目录/报告，因此不能把它在源码交接包中的缺项当作应用模块失踪。真实模型对照/复判/统计工具需要另外取得授权的运行证据；B1原始冻结快照和模型轨迹没有随包复制，重新生成的新基线不得冒充旧基线。

外部 zju-student-info 的安装源码和凭据、Codex/App Server 登录态、DeepSeek DPAPI/Key、Cookie/token、真实学生数据库均不属于本包；没有跨目录读取或复制。Gurobi、ffmpeg、reportlab等历史研究/录像工具不是应用运行依赖，相关可选命令须自备环境。
