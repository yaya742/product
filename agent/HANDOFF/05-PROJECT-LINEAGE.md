# 项目血统：从现存证据理解演进

**Git 证据不足，以下主要来自现存文档与代码关系。** 当前只有一条提交；未虚构后续提交或合并历史。阶段顺序是文档与入口变化的归纳，不是已证明的发布时间表。

| 阶段 | 问题、尝试、结果与当前继承 | 支持证据 |
|---|---|---|
| 1. 对话原型 | 用 Electron/React建立单对话入口、设置和本地示例，降低第一次使用负担；保留其窗口/输入/返回与可见控制 | DESIGN 的0.1历史节；App、main、demo |
| 2. 校园数据与独立访问 | 区分官方记录、用户自述和导入快照；采用受限外部读取器而非把账户能力塞进前台；当前继承按域/source/学期合并 | zjuAdapter、storage/domains、校园契约与示例 |
| 3. 地图 V2 | 替换旧地图资源，采用本地OSM几何、源节点入口和独立步行图；保留可独立使用的二维地图和未知入口失败语义 | MAP-V2、assets/map-v2/SOURCE、mapService、map-routing |
| 4. 受控记忆与动作 | 以证据、条件断言、权限版本、事务/回执和恢复屏障替代松散状态；部分运行边界保留，但不代表语义成功率已证明 | memory、storage/repository、actions、旧设计验收JSON |
| 5. 人本协作尝试 | 开始区分倾听、分析、委托、暂定理解和真实承诺；旧关键词/固定模板路径出现退化，相关开发轨迹作为测试继承 | 人本协作架构/行为规范与trajectories；DESIGN历史节 |
| 6. 理解与行动重构 | 固定 Hermes 作为唯一主循环，宿主管权限/业务；增加共同理解、请求收尾、条件恢复与可靠行动，旧TypeScript循环仅在历史对照里 | 当前00–04规格；harness、runtime/hermes、collaboration |
| 7. 真实失败后的修复 | 分开私人主回复和对外成稿，细化删除来源链、会话保留与业务效果、工作者实际观察与长输入核验；专项有通过，完整模型仍有未闭合失败 | release-composer/store、localEffectScope、long-input-review；统计摘要 |
| 8. Luna 临时代测 | DeepSeek余额故障后按明确要求换 App Server 的GPT‑5.6‑Luna；只替换模型传输并保留原Harness，协议/成本差异公开；不升级为生产默认 | LUNA-TEST-SUBSTITUTE、model-selection/luna-provider、Hermes modelIdentity |

未随包收纳的其他审查、研究、手机驻留设计和重复源码仍列在 EXCLUSIONS 与 SELECTION-MANIFEST。没有从旧 minimal-core-package 反向复制文件；所有应用源码取自本次工作树。
