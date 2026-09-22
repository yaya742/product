# 地图能力

`map/` 是地图功能的统一入口，对应 `codex/map` 责任分支。这里记录共享契约、数据来源和平台实现边界，避免地图代码被误认为 Agent Core 的内部细节。

当前实现仍按平台保留适配层：

- 共享结构和路线算法：`agent/src/shared/map-v2.ts`、`agent/src/shared/map-routing.ts`。
- 桌面服务、定位和 UI：`agent/src/main/mapService.ts`、`agent/src/main/mapLocation.ts`、`agent/src/renderer/map/`。
- 桌面地图数据和来源：`agent/assets/map-v2/`、`agent/public/map-v2/`、`agent/MAP-V2.md`。
- 移动端 UI 和运行时：`mobile/src/MapPanel.tsx`、`mobile/src/runtime/map.ts`。
- 移动端随包地图数据：`mobile/public/map-v2/`。

这些平台文件由 `map/manifest.json` 统一列出。后续若把共享算法或数据迁入独立包，必须同时验证桌面构建、移动构建、Electron 资源打包和 Capacitor 同步；不能只移动文件后留下隐式复制。

地图数据来自随包快照，不代表实时门禁、道路施工或现场通行状态。来源、许可和当前覆盖边界见 `agent/assets/map-v2/SOURCE.md`。
