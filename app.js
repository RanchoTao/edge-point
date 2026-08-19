(() => {
  'use strict';

  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });

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
  let edgeRebuildTimer = null;

  const highlightedEdges = new Set();
  const pathEdges = new Set();

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function edgeKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#030303';
    ctx.fillRect(0, 0, width, height);
  }

  function createNodes(count) {
    const margin = 70;
    const usableW = Math.max(200, width - margin * 2);
    const usableH = Math.max(200, height - margin * 2);
    const clusterCount = Math.max(2, Math.min(5, Math.round(count / 16)));
    const clusters = [];

    for (let i = 0; i < clusterCount; i++) {
      const angle = (Math.PI * 2 * i) / clusterCount + rand(-0.25, 0.25);
      const rx = usableW * 0.28;
      const ry = usableH * 0.23;
      clusters.push({
        x: width / 2 + Math.cos(angle) * rx,
        y: height / 2 + Math.sin(angle) * ry
      });
    }

    nodes = Array.from({ length: count }, (_, id) => {
      const c = clusters[id % clusterCount];
      return {
        id,
        x: clamp(c.x + rand(-usableW * 0.13, usableW * 0.13), margin, width - margin),
        y: clamp(c.y + rand(-usableH * 0.16, usableH * 0.16), margin, height - margin),
        vx: rand(-0.3, 0.3),
        vy: rand(-0.3, 0.3),
        radius: 5,
        degree: 0,
        state: 'normal',
        pinned: false,
        visitedOrder: -1
      };
    });
  }

  function connectGraph(radius) {
    const set = new Set();
    const nextEdges = [];

    const addEdge = (a, b) => {
      if (a === b) return;
      const key = edgeKey(a, b);
      if (set.has(key)) return;
      set.add(key);
      const dx = nodes[a].x - nodes[b].x;
      const dy = nodes[a].y - nodes[b].y;
      const dist = Math.hypot(dx, dy);
      nextEdges.push({
        a,
        b,
        rest: clamp(dist * rand(0.74, 0.9), 52, 150),
        weight: Math.max(1, Math.round(dist / 12 + rand(0, 5)))
      });
    };

    // Build a nearest-neighbour spanning tree first so every generated graph is connected.
    for (let i = 1; i < nodes.length; i++) {
      let nearest = 0;
      let best = Infinity;
      for (let j = 0; j < i; j++) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (d < best) {
          best = d;
          nearest = j;
        }
      }
      addEdge(i, nearest);
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;

        const probability = 0.12 + 0.48 * (1 - dist / radius);
        if (Math.random() < probability) addEdge(i, j);
      }
    }

    // Give sparse nodes one or two additional nearby links.
    const degree = Array(nodes.length).fill(0);
    nextEdges.forEach(e => { degree[e.a]++; degree[e.b]++; });
    for (let i = 0; i < nodes.length; i++) {
      if (degree[i] >= 2) continue;
      const candidates = nodes
        .map((n, j) => ({ j, d: i === j ? Infinity : Math.hypot(nodes[i].x - n.x, nodes[i].y - n.y) }))
        .sort((p, q) => p.d - q.d);
      for (const candidate of candidates.slice(0, 4)) {
        if (degree[i] >= 2) break;
        const before = nextEdges.length;
        addEdge(i, candidate.j);
        if (nextEdges.length > before) {
          degree[i]++;
          degree[candidate.j]++;
        }
      }
    }

    edges = nextEdges;
    rebuildAdjacency();
    updateNodeRadii();
    els.metricEdges.textContent = String(edges.length);
  }

  function rebuildAdjacency() {
    adjacency = Array.from({ length: nodes.length }, () => []);
    for (const edge of edges) {
      adjacency[edge.a].push({ to: edge.b, weight: edge.weight });
      adjacency[edge.b].push({ to: edge.a, weight: edge.weight });
    }
  }

  function updateNodeRadii() {
    const degrees = Array(nodes.length).fill(0);
    for (const edge of edges) {
      degrees[edge.a]++;
      degrees[edge.b]++;
    }
    nodes.forEach((node, i) => {
      node.degree = degrees[i];
      node.radius = clamp(4.8 + Math.sqrt(degrees[i]) * 1.9, 5, 13);
    });
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
    connectGraph(Number(els.linkRadius.value));
    startNode = 0;
    endNode = count - 1;
    nodes[startNode].state = 'start';
    nodes[endNode].state = 'end';
    els.metricNodes.textContent = String(count);
    setStatus('SIMULATION ACTIVE', '拖拽节点 · 点击选择起点 · Shift + 点击选择终点');
  }

  function rebuildEdgesOnly() {
    resetAlgorithmVisuals();
    connectGraph(Number(els.linkRadius.value));
    if (startNode != null && nodes[startNode]) nodes[startNode].state = 'start';
    if (endNode != null && nodes[endNode]) nodes[endNode].state = 'end';
  }

  function physicsStep(dt) {
    if (paused || dragging) {
      if (dragging != null && nodes[dragging]) {
        nodes[dragging].vx *= 0.5;
        nodes[dragging].vy *= 0.5;
      }
    }

    const motion = Number(els.motion.value) / 100;
    const repulsion = 1600 + motion * 1700;
    const springK = 0.00165;
    const centerK = 0.00018;
    const damping = 0.985 - motion * 0.025;
    const maxSpeed = 1.1 + motion * 2.5;

    if (!paused) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy + 80;
          const d = Math.sqrt(d2);
          const force = repulsion / d2;
          dx /= d;
          dy /= d;
          a.vx -= dx * force * dt;
          a.vy -= dy * force * dt;
          b.vx += dx * force * dt;
          b.vy += dy * force * dt;
        }
      }

      for (const edge of edges) {
        const a = nodes[edge.a];
        const b = nodes[edge.b];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const stretch = d - edge.rest;
        const force = stretch * springK;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx * dt;
        a.vy += fy * dt;
        b.vx -= fx * dt;
        b.vy -= fy * dt;
      }

      const cx = width / 2;
      const cy = height / 2;
      for (const node of nodes) {
        node.vx += (cx - node.x) * centerK * dt;
        node.vy += (cy - node.y) * centerK * dt;
        node.vx += rand(-0.006, 0.006) * motion * dt;
        node.vy += rand(-0.006, 0.006) * motion * dt;
      }

      // Soft collision pass.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.max(0.1, Math.hypot(dx, dy));
          const minD = a.radius + b.radius + 7;
          if (d >= minD) continue;
          const push = (minD - d) * 0.02;
          const px = (dx / d) * push;
          const py = (dy / d) * push;
          a.vx -= px;
          a.vy -= py;
          b.vx += px;
          b.vy += py;
        }
      }

      const pad = 26;
      for (const node of nodes) {
        if (node.pinned) continue;
        node.vx *= damping;
        node.vy *= damping;
        const speed = Math.hypot(node.vx, node.vy);
        if (speed > maxSpeed) {
          node.vx = (node.vx / speed) * maxSpeed;
          node.vy = (node.vy / speed) * maxSpeed;
        }
        node.x += node.vx * dt;
        node.y += node.vy * dt;

        if (node.x < pad) { node.x = pad; node.vx = Math.abs(node.vx) * 0.65; }
        if (node.x > width - pad) { node.x = width - pad; node.vx = -Math.abs(node.vx) * 0.65; }
        if (node.y < pad) { node.y = pad; node.vy = Math.abs(node.vy) * 0.65; }
        if (node.y > height - pad) { node.y = height - pad; node.vy = -Math.abs(node.vy) * 0.65; }
      }
    }
  }

  function draw() {
    const trail = Number(els.trail.value) / 100;
    const fadeAlpha = trail <= 0.01 ? 1 : 0.34 - trail * 0.28;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(3,3,3,${clamp(fadeAlpha, 0.045, 1)})`;
    ctx.fillRect(0, 0, width, height);

    const neighbourSet = new Set();
    if (hovered != null) {
      neighbourSet.add(hovered);
      for (const n of adjacency[hovered]) neighbourSet.add(n.to);
    }

    ctx.lineCap = 'round';
    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      const key = edgeKey(edge.a, edge.b);
      const isPath = pathEdges.has(key);
      const isStep = highlightedEdges.has(key);
      const isHover = hovered != null && (edge.a === hovered || edge.b === hovered);

      let alpha = 0.12;
      let lineWidth = 0.75;
      if (isHover) { alpha = 0.38; lineWidth = 1.15; }
      if (isStep) { alpha = 0.56; lineWidth = 1.5; }
      if (isPath) { alpha = 0.95; lineWidth = 2.15; }

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(235,235,235,${alpha})`;
      ctx.lineWidth = lineWidth;
      if (isPath) {
        ctx.shadowColor = 'rgba(255,255,255,.65)';
        ctx.shadowBlur = 9;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (isPath) {
        const phase = ((performance.now() / 950) + (edge.a + edge.b) * 0.07) % 1;
        const px = a.x + (b.x - a.x) * phase;
        const py = a.y + (b.y - a.y) * phase;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.shadowColor = 'rgba(255,255,255,.9)';
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    for (const node of nodes) {
      const hoveredNode = hovered === node.id;
      const dimmed = hovered != null && !neighbourSet.has(node.id);
      const active = node.state === 'active';
      const visited = node.state === 'visited';
      const onPath = node.state === 'path';
      const isStart = node.id === startNode;
      const isEnd = node.id === endNode;

      let radius = node.radius;
      if (hoveredNode || active || isStart || isEnd) radius += 2.2;
      if (onPath) radius += 1.4;

      const alpha = dimmed ? 0.18 : visited ? 0.58 : 0.88;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(238,238,238,${alpha})`;
      ctx.strokeStyle = isStart || isEnd || active || onPath
        ? 'rgba(255,255,255,.98)'
        : 'rgba(255,255,255,.44)';
      ctx.lineWidth = isStart || isEnd || active ? 1.7 : 0.8;
      if (active || hoveredNode || isStart || isEnd || onPath) {
        ctx.shadowColor = 'rgba(255,255,255,.82)';
        ctx.shadowBlur = active ? 24 : 15;
      }
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.font = `${active ? 600 : 450} 11px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = dimmed ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.72)';
      ctx.fillText(String(node.id), node.x + radius + 5, node.y - radius * 0.42);

      if (node.visitedOrder >= 0 && node.state !== 'path') {
        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        ctx.fillText(`#${node.visitedOrder}`, node.x + radius + 5, node.y + radius + 7);
      }
    }
  }

  function findNode(x, y) {
    let hit = null;
    let best = Infinity;
    for (const node of nodes) {
      const d = Math.hypot(x - node.x, y - node.y);
      if (d <= node.radius + 8 && d < best) {
        hit = node.id;
        best = d;
      }
    }
    return hit;
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function setStatus(title, text) {
    els.statusTitle.textContent = title;
    els.statusText.textContent = text;
  }

  canvas.addEventListener('pointermove', event => {
    const p = pointerPosition(event);
    if (dragging != null && nodes[dragging]) {
      const node = nodes[dragging];
      node.x = clamp(p.x, 18, width - 18);
      node.y = clamp(p.y, 18, height - 18);
      node.vx = 0;
      node.vy = 0;
      node.pinned = true;
      canvas.style.cursor = 'grabbing';
      return;
    }
    hovered = findNode(p.x, p.y);
    canvas.style.cursor = hovered == null ? 'crosshair' : 'grab';
  });

  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    if (dragging == null) canvas.style.cursor = 'crosshair';
  });

  canvas.addEventListener('pointerdown', event => {
    const p = pointerPosition(event);
    const hit = findNode(p.x, p.y);
    if (hit == null) return;
    pointerDown = { id: hit, x: p.x, y: p.y, time: performance.now(), shift: event.shiftKey };
    dragging = hit;
    nodes[hit].pinned = true;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointerup', event => {
    if (dragging == null) return;
    const p = pointerPosition(event);
    const id = dragging;
    const click = pointerDown && Math.hypot(p.x - pointerDown.x, p.y - pointerDown.y) < 5 && performance.now() - pointerDown.time < 420;
    nodes[id].pinned = false;
    dragging = null;
    canvas.style.cursor = hovered == null ? 'crosshair' : 'grab';

    if (click) {
      resetAlgorithmVisuals();
      if (pointerDown.shift) {
        endNode = id;
      } else {
        startNode = id;
      }
      if (startNode != null && nodes[startNode]) nodes[startNode].state = 'start';
      if (endNode != null && nodes[endNode]) nodes[endNode].state = 'end';
      setStatus('SELECTION UPDATED', `起点 ${startNode ?? '—'} · 终点 ${endNode ?? '—'} · Shift + 点击设置终点`);
    }

    pointerDown = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
  });

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function animateTraversal(order, parents, runId, label) {
    for (let i = 0; i < order.length; i++) {
      if (runId !== algorithmRunId) return false;
      const id = order[i];
      const node = nodes[id];
      node.state = 'active';
      node.visitedOrder = i + 1;
      if (parents[id] != null) highlightedEdges.add(edgeKey(id, parents[id]));
      setStatus(`${label} · ${i + 1}/${order.length}`, `正在访问节点 ${id}`);
      await sleep(clamp(165 - nodes.length * 0.9, 68, 150));
      if (id !== startNode && id !== endNode) node.state = 'visited';
    }
    return true;
  }

  function reconstructPath(parents, target) {
    if (target == null || target < 0 || parents[target] === undefined) return [];
    const path = [];
    let current = target;
    const guard = new Set();
    while (current != null && !guard.has(current)) {
      guard.add(current);
      path.push(current);
      if (current === startNode) break;
      current = parents[current];
    }
    if (path[path.length - 1] !== startNode) return [];
    return path.reverse();
  }

  function markPath(path) {
    pathEdges.clear();
    for (let i = 0; i < path.length; i++) {
      const id = path[i];
      if (id !== startNode && id !== endNode) nodes[id].state = 'path';
      if (i > 0) pathEdges.add(edgeKey(path[i - 1], id));
    }
    if (startNode != null) nodes[startNode].state = 'start';
    if (endNode != null) nodes[endNode].state = 'end';
  }

  async function runBfs(runId) {
    const queue = [startNode];
    const seen = new Set([startNode]);
    const parents = Array(nodes.length).fill(undefined);
    parents[startNode] = null;
    const order = [];

    while (queue.length) {
      const current = queue.shift();
      order.push(current);
      if (current === endNode) break;
      for (const item of adjacency[current]) {
        if (seen.has(item.to)) continue;
        seen.add(item.to);
        parents[item.to] = current;
        queue.push(item.to);
      }
    }

    const ok = await animateTraversal(order, parents, runId, 'BFS');
    if (!ok) return;
    const path = reconstructPath(parents, endNode);
    if (path.length) markPath(path);
    setStatus('BFS COMPLETE', path.length ? `找到 ${path.length - 1} 条边的路径` : '遍历完成，未找到终点');
  }

  async function runDfs(runId) {
    const stack = [startNode];
    const seen = new Set();
    const parents = Array(nodes.length).fill(undefined);
    parents[startNode] = null;
    const order = [];

    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      order.push(current);
      if (current === endNode) break;
      const neighbours = adjacency[current].slice().reverse();
      for (const item of neighbours) {
        if (!seen.has(item.to)) {
          if (parents[item.to] === undefined) parents[item.to] = current;
          stack.push(item.to);
        }
      }
    }

    const ok = await animateTraversal(order, parents, runId, 'DFS');
    if (!ok) return;
    const path = reconstructPath(parents, endNode);
    if (path.length) markPath(path);
    setStatus('DFS COMPLETE', path.length ? `DFS 搜索路径长度 ${path.length - 1}` : '遍历完成，未找到终点');
  }

  async function runDijkstra(runId) {
    const dist = Array(nodes.length).fill(Infinity);
    const parents = Array(nodes.length).fill(undefined);
    const done = new Set();
    const order = [];
    dist[startNode] = 0;
    parents[startNode] = null;

    while (done.size < nodes.length) {
      let current = -1;
      let best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        if (!done.has(i) && dist[i] < best) {
          best = dist[i];
          current = i;
        }
      }
      if (current < 0) break;
      done.add(current);
      order.push(current);
      if (current === endNode) break;

      for (const item of adjacency[current]) {
        const candidate = dist[current] + item.weight;
        if (candidate < dist[item.to]) {
          dist[item.to] = candidate;
          parents[item.to] = current;
        }
      }
    }

    const ok = await animateTraversal(order, parents, runId, 'DIJKSTRA');
    if (!ok) return;
    const path = reconstructPath(parents, endNode);
    if (path.length) markPath(path);
    setStatus('DIJKSTRA COMPLETE', Number.isFinite(dist[endNode]) ? `最短距离 ${dist[endNode]} · ${path.length - 1} 条边` : '终点不可达');
  }

  async function runAlgorithm() {
    if (!nodes.length) return;
    if (startNode == null) startNode = 0;
    if (endNode == null) endNode = nodes.length - 1;

    resetAlgorithmVisuals();
    const runId = ++algorithmRunId;
    algorithmBusy = true;
    nodes[startNode].state = 'start';
    nodes[endNode].state = 'end';
    els.runAlgorithm.disabled = true;

    try {
      const algo = els.algorithm.value;
      if (algo === 'dfs') await runDfs(runId);
      else if (algo === 'dijkstra') await runDijkstra(runId);
      else await runBfs(runId);
    } finally {
      if (runId === algorithmRunId) {
        algorithmBusy = false;
        els.runAlgorithm.disabled = false;
      }
    }
  }

  function bindRange(input, output, handler) {
    const update = () => {
      output.textContent = input.value;
      if (handler) handler();
    };
    input.addEventListener('input', update);
    update();
  }

  bindRange(els.nodeCount, els.nodeCountValue, () => {
    clearTimeout(edgeRebuildTimer);
    edgeRebuildTimer = setTimeout(regenerate, 120);
  });

  bindRange(els.linkRadius, els.linkRadiusValue, () => {
    clearTimeout(edgeRebuildTimer);
    edgeRebuildTimer = setTimeout(rebuildEdgesOnly, 110);
  });

  bindRange(els.motion, els.motionValue);
  bindRange(els.trail, els.trailValue);

  els.regenerate.addEventListener('click', regenerate);
  els.runAlgorithm.addEventListener('click', runAlgorithm);
  els.pause.addEventListener('click', () => {
    paused = !paused;
    els.pause.textContent = paused ? '继续' : '暂停';
    els.pause.setAttribute('aria-pressed', String(paused));
    setStatus(paused ? 'SIMULATION PAUSED' : 'SIMULATION ACTIVE', paused ? '图布局已冻结，算法动画仍可运行' : '拖拽节点 · 点击选择起点 · Shift + 点击选择终点');
  });

  let last = performance.now();
  let fpsClock = last;
  let frameCount = 0;

  function frame(now) {
    const elapsed = now - last;
    last = now;
    const dt = clamp(elapsed / 16.6667, 0.25, 2.2);

    physicsStep(dt);
    draw();

    frameCount++;
    if (now - fpsClock >= 500) {
      const fps = Math.round((frameCount * 1000) / (now - fpsClock));
      els.metricFps.textContent = String(fps);
      frameCount = 0;
      fpsClock = now;
    }

    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => {
    resize();
    for (const node of nodes) {
      node.x = clamp(node.x, 28, width - 28);
      node.y = clamp(node.y, 28, height - 28);
    }
  });

  resize();
  regenerate();
  requestAnimationFrame(frame);
})();
