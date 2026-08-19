(() => {
  'use strict';

  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });

  const els = {
    nodeCount: document.getElementById('nodeCount'),
    nodeCountValue: document.getElementById('nodeCountValue'),
    linkRadius: document.getElementById('linkRadius'),
    linkRadiusValue: document.getElementById('linkRadiusValue'),
    motion: document.getElementById('motion'),
    motionValue: document.getElementById('motionValue'),
    trail: document.getElementById('trail'),
    trailValue: document.getElementById('trailValue'),
    algorithm: document.getElementById('algorithm'),
    runAlgorithm: document.getElementById('runAlgorithm'),
    regenerate: document.getElementById('regenerate'),
    pause: document.getElementById('pause'),
    statusTitle: document.getElementById('statusTitle'),
    statusText: document.getElementById('statusText'),
    metricNodes: document.getElementById('metricNodes'),
    metricEdges: document.getElementById('metricEdges'),
    metricFps: document.getElementById('metricFps')
  };

  let width = 1;
  let height = 1;
  let dpr = 1;
  let nodes = [];
  let edges = [];
  let adjacency = [];
  let paused = false;
  let hovered = null;
  let dragging = null;
  let pointerDown = null;
  let startNode = null;
  let endNode = null;
  let algorithmRunId = 0;
  let algorithmBusy = false;
  let lastTime = performance.now();
  let lastEdgeRefresh = 0;
  let fpsFrames = 0;
  let fpsStart = performance.now();

  const highlightedEdges = new Set();
  const pathEdges = new Set();

  const palette = {
    cyan: '#78dcff',
    cyanSoft: '#5fc9ff',
    blue: '#3f91ff',
    blueDeep: '#1f63ff',
    ice: '#ebfbff',
    muted: '#8fc6df'
  };

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function edgeKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  function parseEdgeKey(key) {
    return key.split('-').map(Number);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setStatus(title, text) {
    els.statusTitle.textContent = title;
    els.statusText.textContent = text;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pad = 34;
    for (const node of nodes) {
      node.x = clamp(node.x, pad, width - pad);
      node.y = clamp(node.y, pad, height - pad);
    }
  }

  function createNodes(count) {
    const pad = 62;
    nodes = Array.from({ length: count }, (_, id) => ({
      id,
      x: rand(pad, Math.max(pad + 1, width - pad)),
      y: rand(pad, Math.max(pad + 1, height - pad)),
      vx: rand(-0.08, 0.08),
      vy: rand(-0.08, 0.08),
      degree: 0,
      radius: rand(1.8, 2.6),
      state: 'normal',
      visitedOrder: -1,
      pinned: false,
      phase: rand(0, Math.PI * 2)
    }));
  }

  function refreshEdges(force = false) {
    const now = performance.now();
    if (!force && now - lastEdgeRefresh < 55) return;
    lastEdgeRefresh = now;

    const radius = Number(els.linkRadius.value);
    const radiusSq = radius * radius;
    const nextEdges = [];
    const nextAdj = Array.from({ length: nodes.length }, () => []);
    const degree = Array(nodes.length).fill(0);

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= radiusSq) continue;

        const dist = Math.sqrt(d2);
        const proximity = 1 - dist / radius;
        const weight = Math.max(1, Math.round(dist));
        nextEdges.push({ a: i, b: j, dist, proximity, weight });
        nextAdj[i].push({ to: j, weight });
        nextAdj[j].push({ to: i, weight });
        degree[i]++;
        degree[j]++;
      }
    }

    edges = nextEdges;
    adjacency = nextAdj;
    nodes.forEach((node, i) => {
      node.degree = degree[i];
    });
    els.metricEdges.textContent = String(edges.length);
  }

  function resetAlgorithmVisuals() {
    algorithmRunId++;
    algorithmBusy = false;
    highlightedEdges.clear();
    pathEdges.clear();
    for (const node of nodes) {
      node.state = 'normal';
      node.visitedOrder = -1;
    }
    if (startNode != null && nodes[startNode]) nodes[startNode].state = 'start';
    if (endNode != null && nodes[endNode]) nodes[endNode].state = 'end';
  }

  function regenerate() {
    resetAlgorithmVisuals();
    const count = Number(els.nodeCount.value);
    createNodes(count);
    startNode = 0;
    endNode = count > 1 ? count - 1 : 0;
    nodes[startNode].state = 'start';
    if (endNode !== startNode) nodes[endNode].state = 'end';
    refreshEdges(true);
    els.metricNodes.textContent = String(count);
    setStatus('BROWNIAN FIELD ACTIVE', '节点独立缓慢随机游走 · 距离小于阈值自动连线');
  }

  function physicsStep(dt) {
    if (paused) return;

    const activity = Number(els.motion.value) / 100;
    const frameScale = clamp(dt / 16.6667, 0.2, 2.2);
    const noise = activity * 0.032;
    const damping = Math.pow(0.986, frameScale);
    const maxSpeed = 0.10 + activity * 0.52;
    const pad = 34;

    for (const node of nodes) {
      if (node.pinned) continue;

      // Ornstein-Uhlenbeck style Brownian drift: white-noise impulses + gentle damping.
      // This keeps the motion random, slow and locally smooth instead of ballistic.
      node.vx = node.vx * damping + rand(-noise, noise) * Math.sqrt(frameScale);
      node.vy = node.vy * damping + rand(-noise, noise) * Math.sqrt(frameScale);

      const speed = Math.hypot(node.vx, node.vy);
      if (speed > maxSpeed) {
        node.vx = (node.vx / speed) * maxSpeed;
        node.vy = (node.vy / speed) * maxSpeed;
      }

      node.x += node.vx * frameScale;
      node.y += node.vy * frameScale;

      if (node.x < pad) {
        node.x = pad;
        node.vx = Math.abs(node.vx) * 0.72;
      } else if (node.x > width - pad) {
        node.x = width - pad;
        node.vx = -Math.abs(node.vx) * 0.72;
      }

      if (node.y < pad) {
        node.y = pad;
        node.vy = Math.abs(node.vy) * 0.72;
      } else if (node.y > height - pad) {
        node.y = height - pad;
        node.vy = -Math.abs(node.vy) * 0.72;
      }
    }
  }

  function drawBaseEdges() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      const key = edgeKey(edge.a, edge.b);
      const isPath = pathEdges.has(key);
      const isStep = highlightedEdges.has(key);
      const isHover = hovered != null && (edge.a === hovered || edge.b === hovered);

      let alpha = 0.035 + edge.proximity * 0.13;
      let lineWidth = 0.55 + edge.proximity * 0.35;

      if (isHover) {
        alpha = 0.34 + edge.proximity * 0.22;
        lineWidth = 1.05;
      }
      if (isStep) {
        alpha = 0.72;
        lineWidth = 1.4;
      }
      if (isPath) {
        alpha = 0.96;
        lineWidth = 1.9;
      }

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = isPath
        ? `rgba(118, 220, 255, ${alpha})`
        : `rgba(61, 148, 255, ${alpha})`;
      ctx.lineWidth = lineWidth;

      if (isPath || isStep) {
        ctx.shadowColor = isPath ? 'rgba(95, 211, 255, .9)' : 'rgba(58, 143, 255, .72)';
        ctx.shadowBlur = isPath ? 13 : 8;
      }

      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  function drawAlgorithmOverlays() {
    const visible = new Set(edges.map(e => edgeKey(e.a, e.b)));
    const overlays = new Set([...highlightedEdges, ...pathEdges]);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (const key of overlays) {
      if (visible.has(key)) continue;
      const [aId, bId] = parseEdgeKey(key);
      const a = nodes[aId];
      const b = nodes[bId];
      if (!a || !b) continue;
      const isPath = pathEdges.has(key);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = isPath ? 'rgba(118,220,255,.86)' : 'rgba(68,142,255,.56)';
      ctx.lineWidth = isPath ? 1.8 : 1.2;
      ctx.shadowColor = isPath ? 'rgba(100,220,255,.9)' : 'rgba(53,133,255,.7)';
      ctx.shadowBlur = isPath ? 12 : 7;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    const now = performance.now();
    for (const key of pathEdges) {
      const [aId, bId] = parseEdgeKey(key);
      const a = nodes[aId];
      const b = nodes[bId];
      if (!a || !b) continue;
      const phase = ((now / 1100) + (aId + bId) * 0.071) % 1;
      const px = a.x + (b.x - a.x) * phase;
      const py = a.y + (b.y - a.y) * phase;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220, 251, 255, .98)';
      ctx.shadowColor = 'rgba(88, 211, 255, 1)';
      ctx.shadowBlur = 15;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  function drawNode(node, now) {
    const selected = node.id === startNode || node.id === endNode;
    const hoveredNode = node.id === hovered;
    const visited = node.state === 'visited';
    const active = node.state === 'active';
    const isStart = node.id === startNode;
    const isEnd = node.id === endNode;

    let core = palette.cyan;
    let glow = 'rgba(70, 184, 255, .88)';
    let radius = 2.0 + Math.min(1.7, Math.sqrt(node.degree) * 0.16);

    if (visited) {
      core = '#66a8ff';
      glow = 'rgba(55, 111, 255, .9)';
    }
    if (active) {
      core = '#e9fdff';
      glow = 'rgba(89, 225, 255, 1)';
      radius += 1.3;
    }
    if (isEnd) {
      core = '#95b7ff';
      glow = 'rgba(73, 113, 255, 1)';
      radius += 1.0;
    }
    if (isStart) {
      core = '#f0fdff';
      glow = 'rgba(75, 202, 255, 1)';
      radius += 1.4;
    }
    if (hoveredNode) radius += 1.8;

    const breathe = 0.88 + Math.sin(now * 0.0018 + node.phase) * 0.12;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius * (3.3 + breathe), 0, Math.PI * 2);
    ctx.fillStyle = isStart || isEnd || active
      ? 'rgba(84, 192, 255, .075)'
      : 'rgba(46, 137, 255, .035)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.shadowColor = glow;
    ctx.shadowBlur = selected || hoveredNode || active ? 24 : 14;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(node.x - radius * .25, node.y - radius * .25, Math.max(.65, radius * .34), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.shadowBlur = 7;
    ctx.fill();

    ctx.restore();

    const showLabel = nodes.length <= 80 || selected || hoveredNode || visited || active;
    if (showLabel) {
      ctx.save();
      ctx.font = selected || hoveredNode ? '600 9px Inter, system-ui, sans-serif' : '500 8px Inter, system-ui, sans-serif';
      ctx.fillStyle = selected || hoveredNode
        ? 'rgba(211, 245, 255, .86)'
        : 'rgba(143, 201, 230, .42)';
      ctx.shadowColor = 'rgba(32, 126, 255, .45)';
      ctx.shadowBlur = selected || hoveredNode ? 7 : 0;
      const suffix = node.visitedOrder >= 0 ? ` · ${node.visitedOrder}` : '';
      ctx.fillText(`${node.id}${suffix}`, node.x + radius + 5, node.y - radius - 3);
      ctx.restore();
    }
  }

  function draw() {
    const trail = Number(els.trail.value) / 100;
    const fadeAlpha = trail <= 0.01 ? 1 : clamp(0.30 - trail * 0.245, 0.055, 0.30);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(1, 7, 16, ${fadeAlpha})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    drawBaseEdges();
    drawAlgorithmOverlays();

    const now = performance.now();
    for (const node of nodes) drawNode(node, now);
  }

  function nearestNode(x, y, radius = 16) {
    let best = null;
    let bestD = radius;
    for (const node of nodes) {
      const d = Math.hypot(node.x - x, node.y - y);
      if (d < bestD) {
        bestD = d;
        best = node.id;
      }
    }
    return best;
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function applySelection(nodeId, chooseEnd) {
    if (nodeId == null || !nodes[nodeId]) return;
    resetAlgorithmVisuals();

    if (chooseEnd) {
      endNode = nodeId;
    } else {
      startNode = nodeId;
    }

    for (const node of nodes) node.state = 'normal';
    if (startNode != null && nodes[startNode]) nodes[startNode].state = 'start';
    if (endNode != null && nodes[endNode] && endNode !== startNode) nodes[endNode].state = 'end';

    setStatus(
      'SELECTION UPDATED',
      `起点 ${startNode ?? '—'} · 终点 ${endNode ?? '—'} · Shift + 点击选择终点`
    );
  }

  function snapshotAdjacency() {
    refreshEdges(true);
    return adjacency.map(list => list.map(item => ({ ...item })));
  }

  async function animateTraversal(kind) {
    if (startNode == null || !nodes[startNode]) return;

    const graph = snapshotAdjacency();
    const runId = ++algorithmRunId;
    algorithmBusy = true;
    highlightedEdges.clear();
    pathEdges.clear();
    for (const node of nodes) {
      node.state = 'normal';
      node.visitedOrder = -1;
    }
    nodes[startNode].state = 'start';
    if (endNode != null && endNode !== startNode) nodes[endNode].state = 'end';

    const visited = new Set();
    const previous = Array(nodes.length).fill(null);
    const frontier = [startNode];
    let order = 0;

    setStatus(kind === 'bfs' ? 'BFS RUNNING' : 'DFS RUNNING', '以当前距离邻接关系为快照执行搜索');

    while (frontier.length && runId === algorithmRunId) {
      const current = kind === 'bfs' ? frontier.shift() : frontier.pop();
      if (visited.has(current)) continue;
      visited.add(current);

      const node = nodes[current];
      if (!node) continue;
      node.state = 'active';
      node.visitedOrder = order++;

      if (previous[current] != null) highlightedEdges.add(edgeKey(current, previous[current]));
      await sleep(70);
      if (runId !== algorithmRunId) return;

      node.state = current === startNode ? 'start' : current === endNode ? 'end' : 'visited';
      if (current === endNode) break;

      const neighbours = [...graph[current]];
      if (kind === 'dfs') neighbours.reverse();
      for (const next of neighbours) {
        if (visited.has(next.to)) continue;
        if (previous[next.to] == null && next.to !== startNode) previous[next.to] = current;
        frontier.push(next.to);
      }
    }

    finishTraversal(previous, runId, kind.toUpperCase());
  }

  async function animateDijkstra() {
    if (startNode == null || !nodes[startNode]) return;

    const graph = snapshotAdjacency();
    const runId = ++algorithmRunId;
    algorithmBusy = true;
    highlightedEdges.clear();
    pathEdges.clear();

    for (const node of nodes) {
      node.state = 'normal';
      node.visitedOrder = -1;
    }
    nodes[startNode].state = 'start';
    if (endNode != null && endNode !== startNode) nodes[endNode].state = 'end';

    const dist = Array(nodes.length).fill(Infinity);
    const previous = Array(nodes.length).fill(null);
    const used = new Set();
    dist[startNode] = 0;
    let order = 0;

    setStatus('DIJKSTRA RUNNING', '边权采用运行瞬间的节点欧氏距离');

    while (used.size < nodes.length && runId === algorithmRunId) {
      let current = null;
      let best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        if (!used.has(i) && dist[i] < best) {
          best = dist[i];
          current = i;
        }
      }
      if (current == null) break;

      used.add(current);
      nodes[current].state = 'active';
      nodes[current].visitedOrder = order++;
      if (previous[current] != null) highlightedEdges.add(edgeKey(current, previous[current]));

      await sleep(72);
      if (runId !== algorithmRunId) return;

      nodes[current].state = current === startNode ? 'start' : current === endNode ? 'end' : 'visited';
      if (current === endNode) break;

      for (const next of graph[current]) {
        if (used.has(next.to)) continue;
        const candidate = dist[current] + next.weight;
        if (candidate < dist[next.to]) {
          dist[next.to] = candidate;
          previous[next.to] = current;
        }
      }
    }

    finishTraversal(previous, runId, 'DIJKSTRA', Number.isFinite(dist[endNode]) ? dist[endNode] : null);
  }

  function finishTraversal(previous, runId, label, distance = null) {
    if (runId !== algorithmRunId) return;
    pathEdges.clear();

    let pathLength = 0;
    if (endNode != null && endNode !== startNode) {
      let current = endNode;
      const guard = new Set();
      while (current != null && current !== startNode && !guard.has(current)) {
        guard.add(current);
        const prev = previous[current];
        if (prev == null) break;
        pathEdges.add(edgeKey(current, prev));
        pathLength++;
        current = prev;
      }
    }

    algorithmBusy = false;
    if (endNode === startNode || pathEdges.size > 0) {
      const distanceText = distance == null ? `${pathLength} 条边` : `距离 ${Math.round(distance)}`;
      setStatus(`${label} COMPLETE`, `路径已锁定 · ${distanceText} · 节点仍继续布朗运动`);
    } else {
      setStatus(`${label} COMPLETE`, '当前邻接快照中起点与终点不连通');
    }
  }

  async function runSelectedAlgorithm() {
    if (algorithmBusy) resetAlgorithmVisuals();
    const kind = els.algorithm.value;
    if (kind === 'dijkstra') await animateDijkstra();
    else await animateTraversal(kind);
  }

  function syncControls() {
    els.nodeCountValue.textContent = els.nodeCount.value;
    els.linkRadiusValue.textContent = els.linkRadius.value;
    els.motionValue.textContent = els.motion.value;
    els.trailValue.textContent = els.trail.value;
  }

  els.nodeCount.addEventListener('input', () => {
    syncControls();
  });

  els.nodeCount.addEventListener('change', regenerate);

  els.linkRadius.addEventListener('input', () => {
    syncControls();
    refreshEdges(true);
  });

  els.motion.addEventListener('input', syncControls);
  els.trail.addEventListener('input', syncControls);
  els.regenerate.addEventListener('click', regenerate);
  els.runAlgorithm.addEventListener('click', runSelectedAlgorithm);

  els.pause.addEventListener('click', () => {
    paused = !paused;
    els.pause.textContent = paused ? '继续' : '暂停';
    els.pause.setAttribute('aria-pressed', String(paused));
    setStatus(
      paused ? 'FIELD PAUSED' : 'BROWNIAN FIELD ACTIVE',
      paused ? '节点位置已冻结，距离邻接关系保持当前状态' : '节点恢复独立缓慢随机游走'
    );
  });

  canvas.addEventListener('pointermove', event => {
    const p = pointerPosition(event);

    if (dragging != null && nodes[dragging]) {
      const node = nodes[dragging];
      node.x = clamp(p.x, 28, width - 28);
      node.y = clamp(p.y, 28, height - 28);
      node.vx = 0;
      node.vy = 0;
      refreshEdges(true);
      return;
    }

    hovered = nearestNode(p.x, p.y, 18);
    canvas.style.cursor = hovered == null ? 'crosshair' : 'grab';
  });

  canvas.addEventListener('pointerdown', event => {
    const p = pointerPosition(event);
    const id = nearestNode(p.x, p.y, 18);
    pointerDown = { x: p.x, y: p.y, id, shift: event.shiftKey };
    if (id != null) {
      dragging = id;
      nodes[id].pinned = true;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointerup', event => {
    const p = pointerPosition(event);
    const moved = pointerDown ? Math.hypot(p.x - pointerDown.x, p.y - pointerDown.y) : Infinity;
    const id = dragging;

    if (id != null && nodes[id]) {
      nodes[id].pinned = false;
      nodes[id].vx = rand(-0.05, 0.05);
      nodes[id].vy = rand(-0.05, 0.05);
    }

    dragging = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = hovered == null ? 'crosshair' : 'grab';

    if (pointerDown && pointerDown.id != null && moved < 6) {
      applySelection(pointerDown.id, event.shiftKey || pointerDown.shift);
    }
    pointerDown = null;
  });

  canvas.addEventListener('pointerleave', () => {
    if (dragging == null) hovered = null;
  });

  window.addEventListener('resize', () => {
    resize();
    refreshEdges(true);
  });

  function frame(now) {
    const dt = Math.min(34, now - lastTime || 16.67);
    lastTime = now;

    physicsStep(dt);
    refreshEdges(false);
    draw();

    fpsFrames++;
    if (now - fpsStart >= 500) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsStart));
      els.metricFps.textContent = String(fps);
      fpsFrames = 0;
      fpsStart = now;
    }

    requestAnimationFrame(frame);
  }

  syncControls();
  resize();
  regenerate();
  requestAnimationFrame(frame);
})();
