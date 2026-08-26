# v004 严重问题修复记录

## 空气墙与出生点

- MC 碰撞从“每格最高顶面一直填充到地面”改为实际平台/墙面的 0.12 米薄壳。
- 门洞、天井出口、雨棚下方和架空层不再因上方存在屋顶而被封死。
- 树叶、花草、装饰栏杆、范围标记铁块不参与人物或子弹碰撞。
- 人物移动、服务端权威移动和客户端/服务端射线均使用 16 米空间索引。
- 8 个出生点全部位于同一室外连通区；2 米采样导航校验覆盖 131,062 个可达格。

## 动态小地图

- 雷达坐标使用 `map.json` 的 `origin=[-379,-536]` 和 `size=[759,1073]`。
- 使用 `assets/mcmap/campus_minimap.png` 作为校园底图。
- 显示以玩家为中心的 220 米动态窗口、实时 X/Z、朝向和其他存活玩家。
- 删除旧 PixelStrike 的固定 136 米竞技场投影。

## 已执行检查

- `node tools/validate-campus-collision.mjs map.json`：通过。
- TypeScript `tsc --noEmit`：通过。
- Vite production build：通过。
- JSON 结构与 200 张 MC 纹理：通过。

服务端容器使用 `golang:1.25-alpine` 在 Docker 构建阶段编译；部署时运行 `docker compose build --no-cache && docker compose up -d`。
