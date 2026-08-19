(() => {
  'use strict';

  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  const els = {
    nodeCount: document.getElementById('nodeCount'),
    nodeCountValue: document.getElementById('nodeCountValue'),
    linkRadius: document.getElementById('linkRadius'),
    linkRadiusValue: document.getElementById('linkRadiusValue'),
    speed: document.getElementById('speed'),
    speedValue: document.getElementById('speedValue'),
    trail: document.getElementById('trail'),
    trailValue: document.getElementById('trailValue'),
    themeColor: document.getElementById('themeColor'),
    colorValue: document.getElementById('colorValue'),
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
  let lastFrame = performance.now();
  let lastEdgeRefresh = 0;
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let theme = parseHex('#59c9ff');
  let nodeSprite = null;
  let selectedSprite = null;

  const highlightedEdges = new Set();
  const pathEdges = new Set();

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function parseHex(hex) {
    const value = hex.replace('#', '');
    const normalized = value.length === 3
      ? value.split('').map(c => c + c).join('')
      : value.padEnd(6, '0').slice(0, 6);
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16)
    };
  }

  function rgba(alpha, color = theme) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
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

  function updateTheme(hex) {
    theme = parseHex(hex);
    const root = document.documentElement;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-rgb', `${theme.r}, ${theme.g}, ${theme.b}`);
    els.colorValue.textContent = hex.toUpperCase();
    nodeSprite = makeGlowSprite(false);
    selectedSprite = makeGlowSprite(true);
  }

  function makeGlowSprite(selected) {
    const size = selected ? 84 : 60;
    const sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    const sctx = sprite.getContext('2d');
    const c = size / 2;
    const gradient = sctx.createRadialGradient(c, c, 0, c, c, c);
    gradient.addColorStop(0, 'rgba(255,255,255,.98)');
    gradient.addColorStop(.08, rgba(.98));
    gradient.addColorStop(.22, rgba(selected ? .68 : .46));
    gradient.addColorStop(.5, rgba(selected ? .2 : .11));
    gradient.addColorStop(1, rgba(0));
    sctx.fillStyle = gradient;
    sctx.fillRect(0, 0, size, size);
    return sprite;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#020914';
    ctx.fillRect(0, 0, width, height);

    const pad = 34;
    for (const node of nodes) {
      node.x = clamp(node.x, pad, width - pad);
      node.y = clamp(node.y, pad, height - pad);
    }
  }

  function createNodes(count) {
    const pad = 56;
    const initialSpeed = 8 + Number(els.speed.value) * 0.22;
    nodes = Array.from({ length: count }, (_, id) => {
      const angle = rand(0, Math.PI * 2);
      const magnitude = rand(.15, .55) * initialSpeed;
      return {
        id,
        x: rand(pad, Math.max(pad + 1, width - pad)),
        y: rand(pad, Math.max(pad + 1, height - pad)),
        vx: Math.cos(angle) * magnitude,
        vy: Math.sin(angle) * magnitude,
        degree: 0,
        state: 'normal',
        visitedOrder: -1,
        pinned: false,
        phase: rand(0, Math.PI * 2)
      };
    });
  }

  function refreshEdges(force = false) {
    const now = performance.now();
    if (!force && now - lastEdgeRefresh < 80) return;
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
    nodes.forEach((node, i) => { node.degree = degree[i]; });
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
    if (endNode != null && nodes[endNode] && endNode !== startNode) nodes[endNode].state = 'end';
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
    setStatus('BROWNIAN FIELD ACTIVE', '节点持续随机游走 · 小于连接距离时自动连线');
  }

  function physicsStep(dt) {
    if (paused) return;

    const speedSetting = Number(els.speed.value) / 100;
    if (speedSetting <= 0) {
      for (const node of nodes) {
        node.vx *= .9;
        node.vy *= .9;
      }
      return;
    }

    const maxSpeed = 18 + speedSetting * 118;
    const noiseAccel = 48 + speedSetting * 230;
    const damping = Math.exp(-(1.45 - speedSetting * .35) * dt);
    const pad = 30;
    const noiseScale = Math.sqrt(Math.max(dt, 1 / 240));

    for (const node of nodes) {
      if (node.pinned) continue;

      node.vx = node.vx * damping + rand(-1, 1) * noiseAccel * noiseScale;
      node.vy = node.vy * damping + rand(-1, 1) * noiseAccel * noiseScale;

      const speed = Math.hypot(node.vx, node.vy);
      if (speed > maxSpeed) {
        node.vx = (node.vx / speed) * maxSpeed;
        node.vy = (node.vy / speed) * maxSpeed;
      }

      node.x += node.vx * dt;
      node.y += node.vy * dt;

      if (node.x < pad) {
        node.x = pad;
        node.vx = Math.abs(node.vx) * .72;
      } else if (node.x > width - pad) {
        node.x = width - pad;
        node.vx = -Math.abs(node.vx) * .72;
      }

      if (node.y < pad) {
        node.y = pad;
        node.vy = Math.abs(node.vy) * .72;
      } else if (node.y > height - pad) {
        node.y = height - pad;
        node.vy = -Math.abs(node.vy) * .72;
      }
    }
  }

  function clearFrame() {
    const trail = Number(els.trail.value) / 100;
    const alpha = trail <= .01 ? 1 : clamp(.42 - trail * .36, .055, .42);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(2, 9, 20, ${alpha})`;
    ctx.fillRect(0, 0, width, height);
  }

  function drawEdges() {
    ctx.save();
    ctx.lineCap = 'round';

    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      const key = edgeKey(edge.a, edge.b);
      const isPath = pathEdges.has(key);
      const isStep = highlightedEdges.has(key);
      const isHover = hovered != null && (edge.a === hovered || edge.b === hovered);

      let alpha = .028 + edge.proximity * .18;
      let lineWidth = .48 + edge.proximity * .48;
      if (isHover) { alpha = .45; lineWidth = 1.05; }
      if (isStep) { alpha = .68; lineWidth = 1.35; }
      if (isPath) { alpha = .94; lineWidth = 1.8; }

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = rgba(alpha);
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawAlgorithmGhostEdges() {
    const visible = new Set(edges.map(edge => edgeKey(edge.a, edge.b)));
    ctx.save();
    ctx.lineCap = 'round';

    for (const key of new Set([...highlightedEdges, ...pathEdges])) {
      if (visible.has(key)) continue;
      const [aId, bId] = parseEdgeKey(key);
      const a = nodes[aId];
      const b = nodes[bId];
      if (!a || !b) continue;
      const path = pathEdges.has(key);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = rgba(path ? .76 : .46);
      ctx.lineWidth = path ? 1.7 : 1.15;
      ctx.stroke();
    }

    const now = performance.now();
    for (const key of pathEdges) {
      const [aId, bId] = parseEdgeKey(key);
      const a = nodes[aId];
      const b = nodes[bId];
      if (!a || !b) continue;
      const phase = ((now / 1050) + (aId + bId) * .071) % 1;
      const px = a.x + (b.x - a.x) * phase;
      const py = a.y + (b.y - a.y) * phase;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = '#effdff';
      ctx.fill();
    }

    ctx.restore();
  }

  function drawNodes() {
    for (const node of nodes) {
      const selected = node.id === startNode || node.id === endNode;
      const active = node.state === 'active';
      const hoveredNode = node.id === hovered;
      const visited = node.state === 'visited';
      const sprite = selected || active || hoveredNode ? selectedSprite : nodeSprite;
      const sizeBase = selected || active || hoveredNode ? 38 : 26;
      const size = sizeBase + Math.min(8, Math.sqrt(node.degree) * 1.15);

      ctx.globalAlpha = visited ? .82 : 1;
      ctx.drawImage(sprite, node.x - size / 2, node.y - size / 2, size, size);

      const coreRadius = selected || active || hoveredNode ? 2.5 : 1.65;
      ctx.beginPath();
      ctx.arc(node.x, node.y, coreRadius, 0, Math.PI * 2);
      ctx.fillStyle = selected || active ? '#f4feff' : rgba(.98);
      ctx.fill();
      ctx.globalAlpha = 1;

      const showLabel = nodes.length <= 72 || selected || hoveredNode || active || visited;
      if (showLabel) {
        ctx.font = selected || hoveredNode ? '600 9px Inter, system-ui, sans-serif' : '500 8px Inter, system-ui, sans-serif';
        ctx.fillStyle = selected || hoveredNode ? 'rgba(226,249,255,.88)' : 'rgba(157,205,230,.48)';
        const suffix = node.visitedOrder >= 0 ? ` · ${node.visitedOrder}` : '';
        ctx.fillText(`${node.id}${suffix}`, node.x + 6, node.y - 5);
      }
    }
  }

  function draw() {
    clearFrame();
    drawEdges();
    drawAlgorithmGhostEdges();
    drawNodes();
  }

  function snapshotAdjacency() {
    return adjacency.map(list => list.map(item => ({ ...item })));
  }

  function setNodeState(id, state) {
    const node = nodes[id];
    if (!node) return;
    if (id === startNode) node.state = 'start';
    else if (id === endNode) node.state = 'end';
    else node.state = state;
  }

  async function animateTraversal(mode, graph, runId) {
    const start = startNode ?? 0;
    const target = endNode;
    const seen = new Set([start]);
    const parent = Array(nodes.length).fill(-1);
    const frontier = [start];
    let order = 0;

    while (frontier.length && runId === algorithmRunId) {
      const current = mode === 'bfs' ? frontier.shift() : frontier.pop();
      nodes[current].visitedOrder = order++;
      setNodeState(current, 'active');
      await sleep(95);
      if (runId !== algorithmRunId) return;

      if (current === target) break;

      const neighbours = [...graph[current]];
      if (mode === 'dfs') neighbours.reverse();
      for (const { to } of neighbours) {
        if (seen.has(to)) continue;
        seen.add(to);
        parent[to] = current;
        highlightedEdges.add(edgeKey(current, to));
        frontier.push(to);
      }

      setNodeState(current, 'visited');
      await sleep(35);
    }

    if (target != null && seen.has(target)) buildPath(parent, start, target);
  }

  async function animateDijkstra(graph, runId) {
    const start = startNode ?? 0;
    const target = endNode;
    const dist = Array(nodes.length).fill(Infinity);
    const parent = Array(nodes.length).fill(-1);
    const used = new Set();
    dist[start] = 0;
    let order = 0;

    while (runId === algorithmRunId) {
      let current = -1;
      let best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        if (!used.has(i) && dist[i] < best) {
          best = dist[i];
          current = i;
        }
      }
      if (current < 0) break;

      used.add(current);
      nodes[current].visitedOrder = order++;
      setNodeState(current, 'active');
      await sleep(95);
      if (runId !== algorithmRunId) return;
      if (current === target) break;

      for (const { to, weight } of graph[current]) {
        if (dist[current] + weight < dist[to]) {
          dist[to] = dist[current] + weight;
          parent[to] = current;
          highlightedEdges.add(edgeKey(current, to));
        }
      }
      setNodeState(current, 'visited');
      await sleep(30);
    }

    if (target != null && Number.isFinite(dist[target])) buildPath(parent, start, target);
  }

  function buildPath(parent, start, target) {
    let current = target;
    let guard = 0;
    while (current !== start && current >= 0 && guard++ < nodes.length + 1) {
      const p = parent[current];
      if (p < 0) return;
      pathEdges.add(edgeKey(p, current));
      current = p;
    }
  }

  async function runAlgorithm() {
    if (algorithmBusy || !nodes.length) return;
    resetAlgorithmVisuals();
    algorithmBusy = true;
    const runId = algorithmRunId;
    const graph = snapshotAdjacency();
    const mode = els.algorithm.value;
    setStatus(`${mode.toUpperCase()} RUNNING`, '算法基于当前距离图快照运行，节点仍可继续运动');

    try {
      if (mode === 'dijkstra') await animateDijkstra(graph, runId);
      else await animateTraversal(mode, graph, runId);
    } finally {
      if (runId === algorithmRunId) {
        algorithmBusy = false;
        setStatus('SIMULATION ACTIVE', pathEdges.size ? '算法完成 · 高亮路径保持显示' : '算法完成 · 当前图中可能不存在可达路径');
      }
    }
  }

  function nearestNode(x, y, maxDistance = 18) {
    let best = null;
    let bestD = maxDistance;
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
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', event => {
    const p = pointerPosition(event);
    const id = nearestNode(p.x, p.y, 22);
    pointerDown = { x: p.x, y: p.y, id, shift: event.shiftKey };
    if (id != null) {
      dragging = id;
      nodes[id].pinned = true;
      canvas.setPointerCapture(event.pointerId);
    }
  });

  canvas.addEventListener('pointermove', event => {
    const p = pointerPosition(event);
    hovered = nearestNode(p.x, p.y, 18);
    if (dragging != null && nodes[dragging]) {
      const node = nodes[dragging];
      node.x = clamp(p.x, 28, width - 28);
      node.y = clamp(p.y, 28, height - 28);
      node.vx = 0;
      node.vy = 0;
      refreshEdges(true);
    }
  });

  canvas.addEventListener('pointerup', event => {
    const p = pointerPosition(event);
    const released = dragging;
    if (released != null && nodes[released]) nodes[released].pinned = false;
    dragging = null;

    if (pointerDown && pointerDown.id != null) {
      const moved = Math.hypot(p.x - pointerDown.x, p.y - pointerDown.y);
      if (moved < 5) {
        resetAlgorithmVisuals();
        if (pointerDown.shift) endNode = pointerDown.id;
        else startNode = pointerDown.id;
        if (startNode != null && nodes[startNode]) nodes[startNode].state = 'start';
        if (endNode != null && nodes[endNode] && endNode !== startNode) nodes[endNode].state = 'end';
        setStatus('SELECTION UPDATED', `起点 ${startNode ?? '—'} · 终点 ${endNode ?? '—'}`);
      }
    }
    pointerDown = null;
  });

  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    if (dragging != null && nodes[dragging]) nodes[dragging].pinned = false;
    dragging = null;
  });

  els.nodeCount.addEventListener('input', () => {
    els.nodeCountValue.textContent = els.nodeCount.value;
  });
  els.nodeCount.addEventListener('change', regenerate);

  els.linkRadius.addEventListener('input', () => {
    els.linkRadiusValue.textContent = els.linkRadius.value;
    refreshEdges(true);
  });

  els.speed.addEventListener('input', () => {
    els.speedValue.textContent = els.speed.value;
    const value = Number(els.speed.value);
    setStatus(value === 0 ? 'MOTION PAUSED' : 'BROWNIAN FIELD ACTIVE', value === 0 ? '运动速度为 0' : `运动速度 ${value} · 节点实时随机游走`);
  });

  els.trail.addEventListener('input', () => {
    els.trailValue.textContent = els.trail.value;
  });

  els.themeColor.addEventListener('input', () => updateTheme(els.themeColor.value));
  els.runAlgorithm.addEventListener('click', runAlgorithm);
  els.regenerate.addEventListener('click', regenerate);
  els.pause.addEventListener('click', () => {
    paused = !paused;
    els.pause.textContent = paused ? '继续' : '暂停';
    els.pause.setAttribute('aria-pressed', String(paused));
    setStatus(paused ? 'SIMULATION PAUSED' : 'BROWNIAN FIELD ACTIVE', paused ? '节点运动与距离图更新已暂停' : '节点持续随机游走 · 小于连接距离时自动连线');
  });

  window.addEventListener('resize', () => {
    resize();
    refreshEdges(true);
  });

  function frame(now) {
    const dt = clamp((now - lastFrame) / 1000, 1 / 240, .05);
    lastFrame = now;

    physicsStep(dt);
    if (!paused) refreshEdges();
    draw();

    fpsFrames++;
    const elapsed = now - fpsWindowStart;
    if (elapsed >= 700) {
      const fps = Math.round((fpsFrames * 1000) / elapsed);
      els.metricFps.textContent = String(fps);
      fpsFrames = 0;
      fpsWindowStart = now;
    }

    requestAnimationFrame(frame);
  }

  updateTheme(els.themeColor.value);
  els.nodeCountValue.textContent = els.nodeCount.value;
  els.linkRadiusValue.textContent = els.linkRadius.value;
  els.speedValue.textContent = els.speed.value;
  els.trailValue.textContent = els.trail.value;
  resize();
  regenerate();
  requestAnimationFrame(frame);
})();
