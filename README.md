# Edge Point

一个纯前端的动态无向图 / 图算法可视化实验。

- Canvas 2D 实时渲染
- 自实现弹簧-斥力布局（无运行时依赖）
- 节点拖影、发光、动态连线
- 鼠标拖拽节点、悬停高亮邻居
- BFS / DFS / Dijkstra 动画
- 节点数、连边半径、运动速度、拖影强度实时调节
- GitHub Pages 自动部署

## 本地运行

直接打开 `index.html` 即可；也可以在仓库目录运行任意静态服务器，例如：

```bash
python -m http.server 8000
```

然后访问 `http://localhost:8000`。

## GitHub Pages

仓库包含 `.github/workflows/pages.yml`。推送到 `main` 后会自动构建并部署静态站点。

如首次部署提示 Pages 尚未启用，在 GitHub 仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**，然后重新运行 workflow。
