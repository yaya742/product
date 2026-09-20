# 当前界面视觉索引

仅本次新建隔离目录、合成数据。截图均已查看，原始PNG字节复制，没有裁剪或美化。

| 文件 | 命令 | 生成时间 | 范围与限制 |
|---|---|---|---|
| [01-chat.png](01-chat.png) | `npm run test:desktop` | 2026-09-15T11:08:33.852085+08:00 | 聊天示例和已登记本地条目；全套后续在连接按钮等待处失败。 |
| [02-map.png](02-map.png) | `node <HANDOFF_TOOL>/capture_map.mjs` | 2026-09-15T11:16:41.745045+08:00 | 新隔离Electron当前地图；没有真实定位，没有模型请求。 |
| [03-memory.png](03-memory.png) | `npm run test:harness:desktop` | 2026-09-15T11:13:10.114868+08:00 | 合成记忆条目与开关；不是当前用户画像。 |
| [04-local-receipt.png](04-local-receipt.png) | `npm run test:harness:desktop` | 2026-09-15T11:13:13.337146+08:00 | 合成本地登记回执；后续撤销提示等待失败，截图不证明撤销通过。 |
| [05-image-draft.png](05-image-draft.png) | `npm run test:multimodal` | 2026-09-15T11:04:57.849265+08:00 | 图文发送前草稿；合成发送验证随后失败，不是模型识图成功证据。 |
