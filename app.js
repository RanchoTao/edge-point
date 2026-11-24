/*
 * Edge Point · 布朗 idopNetwork
 *
 * Nodes drift by Brownian motion. Each ordered pair (j → i) may carry a fixed
 * interaction coefficient a[i][j] (promotion > 0, inhibition < 0). The effect
 * is active only while the two nodes are within the interaction radius, so the
 * directed network keeps forming and dissolving as the nodes move.
 *
 * Expression follows the idopNetwork decomposition
 *   dE_i/dt = Q_i(E_i) + Σ_{j≠i} Q_{i←j}(E_j)
 * with logistic independent growth Q_i = g_i E_i (1 − E_i / K_i) and dependent
 * effects Q_{i←j} = s · a[i][j] · E_j · (1 − d_ij / R).
 */
(() => {
  'use strict'

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id)
  const stage = $('stage'), ctx = stage.getContext('2d')
  const ui = {
    nodeCount: $('nodeCount'), radius: $('radius'), speed: $('speed'), density: $('density'), promote: $('promote'), strength: $('strength'),
    pause: $('pause'), regen: $('regen'), theme: $('theme'), collapse: $('collapse'), panel: $('panel'),
    sNodes: $('sNodes'), sEdges: $('sEdges'), sPro: $('sPro'), sInh: $('sInh'),
    inspector: $('inspector'), iName: $('iName'), iClose: $('iClose'), iE: $('iE'), iIndep: $('iIndep'), iDep: $('iDep'), iIn: $('iIn'), iOut: $('iOut'),
    aSpread: $('aSpread'), aKnock: $('aKnock'), aBoost: $('aBoost'), aPin: $('aPin'), spark: $('spark'), toast: $('toast'),
  }
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------- state ----------
  let W = 1, H = 1, dpr = 1
  let nodes = [], A = [], links = [], linkKeys = new Set()
  let paused = false, selected = -1, hovered = -1, drag = null
  let pulses = [], visited = null
  let colors = {}
  let last = performance.now(), histClock = 0, uiClock = 0
  const HIST = 240

  const params = () => ({
    n: +ui.nodeCount.value, R: +ui.radius.value * Math.min(1, Math.max(.5, Math.min(W, H) / 820)), speed: +ui.speed.value / 100,
    density: +ui.density.value / 100, promote: +ui.promote.value / 100, strength: +ui.strength.value / 100,
  })
  const nameOf = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) + 1 : '')
  const rand = (a, b) => a + Math.random() * (b - a)
  const radiusOf = (E) => 6 + 15 * Math.sqrt(Math.max(0, E) / 1.2)
  // keep nodes clear of the control panel on wide screens
  const leftBound = () => (W > 720 && !ui.panel.classList.contains('collapsed') ? 340 : 24)

  function readColors() {
    const cs = getComputedStyle(document.documentElement)
    const v = (k) => cs.getPropertyValue(k).trim()
    colors = { bg: v('--bg'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), pro: v('--pro'), inh: v('--inh'), line: v('--line'), dark: document.documentElement.dataset.theme === 'dark' }
  }

  // ---------- model ----------
  function makeNode(i) {
    const pad = 60
    return {
      name: nameOf(i), x: rand(leftBound() + pad, W - pad), y: rand(pad, H - pad), vx: 0, vy: 0,
      E: rand(.15, .75), g: rand(.25, .75), K: rand(.3, 1.5),
      pinned: false, knocked: false, indep: 0, dep: 0, flash: 0,
      hist: new Float32Array(HIST), hi: 0,
    }
  }
  function makeCoefficients() {
    const { n, density, promote } = params()
    A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i !== j && Math.random() < density ? (Math.random() < promote ? 1 : -1) * rand(.25, 1) : 0)))
  }
  function regenerate() {
    const { n } = params()
    nodes = Array.from({ length: n }, (_, i) => makeNode(i))
    makeCoefficients()
    select(-1); pulses = []; visited = null
  }
  function resizeCount() {
    const { n } = params()
    if (n > nodes.length) for (let i = nodes.length; i < n; i++) nodes.push(makeNode(i))
    else nodes.length = n
    if (selected >= n) select(-1)
    makeCoefficients()
  }

  function step(dt) {
    const { R, speed, strength } = params(), n = nodes.length
    // Brownian drift
    for (let i = 0; i < n; i++) {
      const p = nodes[i]
      if (p.pinned || (drag && drag.i === i)) { p.vx = p.vy = 0; continue }
      p.vx = p.vx * .92 + (Math.random() - .5) * 90 * speed * dt
      p.vy = p.vy * .92 + (Math.random() - .5) * 90 * speed * dt
      p.x += p.vx; p.y += p.vy
      const pad = 24 + radiusOf(p.E)
      const lb = leftBound() + radiusOf(p.E)
      if (p.x < lb) { p.x += Math.min(lb - p.x, 2); p.vx = Math.abs(p.vx) } else if (p.x > W - pad) { p.x = W - pad; p.vx = -Math.abs(p.vx) }
      if (p.y < pad) { p.y = pad; p.vy = Math.abs(p.vy) } else if (p.y > H - pad) { p.y = H - pad; p.vy = -Math.abs(p.vy) }
    }
    // soft repulsion so circles never overlap
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1
      const min = radiusOf(a.E) + radiusOf(b.E) + 10
      if (d < min) {
        const k = ((min - d) / d) * .5, fa = a.pinned || (drag && drag.i === i) ? 0 : 1, fb = b.pinned || (drag && drag.i === j) ? 0 : 1
        a.x -= dx * k * fa; a.y -= dy * k * fa; b.x += dx * k * fb; b.y += dy * k * fb
      }
    }
    // active directed interactions and their effects
    links = []; linkKeys = new Set()
    const s = strength * .7
    for (let i = 0; i < n; i++) {
      const p = nodes[i]
      p.indep = p.knocked ? 0 : p.g * p.E * (1 - p.E / p.K)
      p.dep = 0
      for (let j = 0; j < n; j++) {
        const a = A[i] && A[i][j]
        if (!a) continue
        const q0 = nodes[j]
        const d = Math.hypot(q0.x - p.x, q0.y - p.y)
        if (d > R) continue
        const q = s * a * q0.E * (1 - d / R)
        if (!p.knocked) p.dep += q
        if (Math.abs(q) > .012) { links.push({ from: j, to: i, q }); linkKeys.add(j * 1000 + i) }
      }
    }
    for (const p of nodes) {
      if (p.knocked) { p.E = Math.max(0, p.E - p.E * 3 * dt); continue }
      p.E = Math.min(2, Math.max(.02, p.E + (p.indep + p.dep) * dt * .9))
    }
  }

  // ---------- perturbation spreading along directed edges ----------
  function spreadFrom(src) {
    visited = new Set([src]); pulses = []
    nodes[src].flash = 1
    launchFrom(src, 0)
    toast(`扰动从 ${nodes[src].name} 出发，沿箭头方向传播`)
  }
  function launchFrom(i, depth) {
    if (depth > 6) return
    for (const l of links) if (l.from === i && !visited.has(l.to)) pulses.push({ from: l.from, to: l.to, q: l.q, t: 0, depth })
  }
  function stepPulses(dt) {
    const arrived = []
    for (const p of pulses) p.t += dt / .7
    pulses = pulses.filter((p) => (p.t >= 1 ? (arrived.push(p), false) : true))
    for (const p of arrived) if (!visited.has(p.to)) { visited.add(p.to); nodes[p.to].flash = 1; launchFrom(p.to, p.depth + 1) }
    for (const nd of nodes) nd.flash = Math.max(0, nd.flash - dt * .9)
    if (!pulses.length && visited && nodes.every((nd) => nd.flash === 0)) visited = null
  }

  // ---------- drawing ----------
  function edgeGeometry(l) {
    const a = nodes[l.from], b = nodes[l.to]
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d
    const both = linkKeys.has(l.to * 1000 + l.from)
    const bend = both ? 16 : 0 // reciprocal pairs curve apart
    const mx = (a.x + b.x) / 2 - uy * bend, my = (a.y + b.y) / 2 + ux * bend
    const ra = radiusOf(a.E) + 2, rb = radiusOf(b.E) + 5
    // trim the curve at both circles (approximate along the chord direction toward the control point)
    const sa = Math.hypot(mx - a.x, my - a.y) || 1, sb = Math.hypot(b.x - mx, b.y - my) || 1
    const sx = a.x + ((mx - a.x) / sa) * ra, sy = a.y + ((my - a.y) / sa) * ra
    const ex = b.x - ((b.x - mx) / sb) * rb, ey = b.y - ((b.y - my) / sb) * rb
    const ang = Math.atan2(ey - my, ex - mx)
    return { sx, sy, mx, my, ex, ey, ang }
  }
  const quad = (g, t) => {
    const u = 1 - t
    return [u * u * g.sx + 2 * u * t * g.mx + t * t * g.ex, u * u * g.sy + 2 * u * t * g.my + t * t * g.ey]
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H)
    if (colors.dark) {
      const gr = ctx.createRadialGradient(W * .55, H * .45, 0, W * .55, H * .45, Math.max(W, H) * .7)
      gr.addColorStop(0, 'rgba(40,80,140,.16)'); gr.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H)
    }
    const focus = selected >= 0 ? selected : hovered
    // edges
    for (const l of links) {
      const g = edgeGeometry(l), w = Math.min(1, Math.abs(l.q) * 3.2)
      const on = focus < 0 || l.from === focus || l.to === focus
      const pro = l.q > 0, col = pro ? colors.pro : colors.inh
      ctx.globalAlpha = on ? .28 + .68 * w : .06
      ctx.strokeStyle = col; ctx.lineWidth = .8 + 2.6 * w
      ctx.setLineDash(pro ? [] : [6, 5])
      ctx.beginPath(); ctx.moveTo(g.sx, g.sy); ctx.quadraticCurveTo(g.mx, g.my, g.ex, g.ey); ctx.stroke()
      ctx.setLineDash([])
      ctx.save(); ctx.translate(g.ex, g.ey); ctx.rotate(g.ang); ctx.fillStyle = col
      const s = 6 + 3 * w
      if (pro) { ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(-s, -s * .55); ctx.lineTo(-s, s * .55); ctx.closePath(); ctx.fill() }
      else ctx.fillRect(-1, -s * .8, 2.6, s * 1.6)
      ctx.restore()
    }
    ctx.globalAlpha = 1
    // travelling pulses
    for (const p of pulses) {
      const l = links.find((x) => x.from === p.from && x.to === p.to)
      if (!l) continue
      const [x, y] = quad(edgeGeometry(l), Math.min(1, p.t))
      ctx.fillStyle = colors.pro
      if (colors.dark) { ctx.shadowColor = colors.pro; ctx.shadowBlur = 14 }
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0
    }
    // nodes
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    nodes.forEach((p, i) => {
      const r = radiusOf(p.E)
      const near = focus < 0 || i === focus || links.some((l) => (l.from === focus && l.to === i) || (l.to === focus && l.from === i))
      ctx.globalAlpha = near ? 1 : .28
      const growing = p.indep + p.dep >= 0
      if (colors.dark) { ctx.shadowColor = growing ? colors.pro : colors.inh; ctx.shadowBlur = 16 }
      ctx.fillStyle = colors.dark ? '#0b1a2e' : '#ffffff'
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0
      ctx.fillStyle = growing ? hexA(colors.pro, colors.dark ? .32 : .16) : hexA(colors.inh, colors.dark ? .22 : .08)
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, r - 2), 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = colors.ink; ctx.lineWidth = i === selected ? 2.6 : 1.2
      if (p.knocked) ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
      if (i === hovered && i !== selected) { ctx.strokeStyle = colors.ink3; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.stroke() }
      if (p.flash > 0) { ctx.strokeStyle = colors.pro; ctx.globalAlpha = p.flash; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4 + (1 - p.flash) * 16, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = near ? 1 : .28 }
      if (p.pinned) { ctx.fillStyle = colors.ink; ctx.beginPath(); ctx.arc(p.x + r * .72, p.y - r * .72, 2.6, 0, Math.PI * 2); ctx.fill() }
      ctx.fillStyle = colors.ink
      ctx.font = `${r > 11 ? 12 : 10}px Georgia, 'Times New Roman', serif`
      if (r > 9) ctx.fillText(p.name, p.x, p.y + 1)
      else ctx.fillText(p.name, p.x, p.y - r - 8)
      if (p.knocked) { ctx.strokeStyle = colors.ink2; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p.x - r * .5, p.y - r * .5); ctx.lineTo(p.x + r * .5, p.y + r * .5); ctx.stroke() }
    })
    ctx.globalAlpha = 1
  }
  function hexA(hex, a) {
    const h = hex.replace('#', ''), v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a})`
  }

  // ---------- inspector ----------
  function select(i) {
    selected = i
    ui.inspector.hidden = i < 0
    if (i >= 0) { updateInspector(); ui.aPin.textContent = nodes[i].pinned ? '释放' : '固定'; ui.aKnock.textContent = nodes[i].knocked ? '恢复' : '敲除' }
  }
  const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3)
  function updateInspector() {
    if (selected < 0) return
    const p = nodes[selected]
    ui.iName.textContent = `节点 ${p.name}${p.knocked ? '（已敲除）' : ''}`
    ui.iE.textContent = p.E.toFixed(2); ui.iIndep.textContent = fmt(p.indep); ui.iDep.textContent = fmt(p.dep)
    const row = (l, other) => `<li><span>${nodes[other].name}</span><b class="${l.q > 0 ? 'p' : 'n'}">${l.q > 0 ? '促进 ' : '抑制 '}${Math.abs(l.q).toFixed(3)}</b></li>`
    const ins = links.filter((l) => l.to === selected).sort((a, b) => Math.abs(b.q) - Math.abs(a.q)).slice(0, 6)
    const outs = links.filter((l) => l.from === selected).sort((a, b) => Math.abs(b.q) - Math.abs(a.q)).slice(0, 6)
    ui.iIn.innerHTML = ins.length ? ins.map((l) => row(l, l.from)).join('') : '<li class="none">此刻无</li>'
    ui.iOut.innerHTML = outs.length ? outs.map((l) => row(l, l.to)).join('') : '<li class="none">此刻无</li>'
    drawSpark(p)
  }
  function drawSpark(p) {
    const c = ui.spark, r = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.round(w * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r) }
    const g = c.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h)
    let max = .5; for (let k = 0; k < HIST; k++) max = Math.max(max, p.hist[k])
    g.strokeStyle = colors.line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h - .5); g.lineTo(w, h - .5); g.stroke()
    g.strokeStyle = colors.pro; g.lineWidth = 1.6; g.beginPath()
    for (let k = 0; k < HIST; k++) {
      const v = p.hist[(p.hi + k) % HIST], x = (k / (HIST - 1)) * w, y = h - 3 - (v / max) * (h - 8)
      k ? g.lineTo(x, y) : g.moveTo(x, y)
    }
    g.stroke()
    g.fillStyle = colors.ink3; g.font = '11px system-ui, sans-serif'; g.fillText('表达量（近 24 秒）', 2, 11)
  }

  let toastTimer = 0
  function toast(msg) {
    ui.toast.textContent = msg; ui.toast.classList.add('show')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2200)
  }

  // ---------- loop ----------
  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now
    if (!paused) {
      step(reduceMotion ? dt * .3 : dt)
      stepPulses(dt)
      histClock += dt
      if (histClock > .1) { histClock = 0; for (const p of nodes) { p.hist[p.hi] = p.E; p.hi = (p.hi + 1) % HIST } }
    }
    draw()
    uiClock += dt
    if (uiClock > .12) {
      uiClock = 0
      ui.sNodes.textContent = nodes.length; ui.sEdges.textContent = links.length
      ui.sPro.textContent = links.filter((l) => l.q > 0).length; ui.sInh.textContent = links.filter((l) => l.q < 0).length
      updateInspector()
    }
    requestAnimationFrame(frame)
  }

  // ---------- input ----------
  function resize() {
    W = innerWidth; H = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2)
    stage.width = Math.round(W * dpr); stage.height = Math.round(H * dpr)
    for (const p of nodes) { p.x = Math.min(Math.max(p.x, 30), W - 30); p.y = Math.min(Math.max(p.y, 30), H - 30) }
  }
  function hit(x, y) {
    let best = -1, bd = Infinity
    nodes.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < radiusOf(p.E) + 8 && d < bd) { bd = d; best = i } })
    return best
  }
  stage.addEventListener('pointerdown', (e) => {
    const i = hit(e.clientX, e.clientY)
    if (i >= 0) { drag = { i, x0: e.clientX, y0: e.clientY, moved: false }; stage.setPointerCapture(e.pointerId); stage.classList.add('grabbing') }
    else drag = { i: -1, x0: e.clientX, y0: e.clientY, moved: false }
  })
  stage.addEventListener('pointermove', (e) => {
    if (drag && drag.i >= 0) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true
      const p = nodes[drag.i]; p.x = e.clientX; p.y = e.clientY
    } else {
      hovered = hit(e.clientX, e.clientY)
      stage.classList.toggle('grab', hovered >= 0)
    }
  })
  const endDrag = (e) => {
    if (!drag) return
    if (!drag.moved) select(drag.i === selected ? -1 : drag.i)
    drag = null; stage.classList.remove('grabbing')
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', () => { drag = null; stage.classList.remove('grabbing') })
  stage.addEventListener('pointerleave', () => { hovered = -1 })

  const bindRange = (el, fmtOut, onChange) => el.addEventListener('input', () => { el.nextElementSibling.textContent = fmtOut(el.value); onChange && onChange() })
  bindRange(ui.nodeCount, (v) => v, resizeCount)
  bindRange(ui.radius, (v) => v)
  bindRange(ui.speed, (v) => v)
  bindRange(ui.density, (v) => v + '%', makeCoefficients)
  bindRange(ui.promote, (v) => v + '%', makeCoefficients)
  bindRange(ui.strength, (v) => v)

  const togglePause = () => { paused = !paused; ui.pause.textContent = paused ? '继续' : '暂停' }
  ui.pause.addEventListener('click', togglePause)
  ui.regen.addEventListener('click', () => { regenerate(); toast('已重新生成网络') })
  ui.theme.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    ui.theme.textContent = dark ? '浅色' : '深色'
    document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#050c17' : '#f6f5f1')
    readColors()
  })
  ui.collapse.addEventListener('click', () => {
    const c = ui.panel.classList.toggle('collapsed'); ui.collapse.textContent = c ? '+' : '–'
    ui.collapse.setAttribute('aria-label', c ? '展开面板' : '收起面板')
  })
  ui.iClose.addEventListener('click', () => select(-1))
  ui.aSpread.addEventListener('click', () => selected >= 0 && spreadFrom(selected))
  ui.aKnock.addEventListener('click', () => {
    if (selected < 0) return
    const p = nodes[selected]; p.knocked = !p.knocked
    if (!p.knocked) p.E = .3
    ui.aKnock.textContent = p.knocked ? '恢复' : '敲除'
    toast(p.knocked ? `已敲除 ${p.name}：它对其他节点的作用随之消失` : `已恢复 ${p.name}`)
  })
  ui.aBoost.addEventListener('click', () => {
    if (selected < 0) return
    const p = nodes[selected]; p.knocked = false; p.E = Math.min(2, p.K * 1.8 + .4)
    ui.aKnock.textContent = '敲除'
    toast(`${p.name} 过表达：观察它的下游节点`)
  })
  ui.aPin.addEventListener('click', () => {
    if (selected < 0) return
    const p = nodes[selected]; p.pinned = !p.pinned; ui.aPin.textContent = p.pinned ? '释放' : '固定'
  })
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return
    if (e.code === 'Space') { e.preventDefault(); togglePause() }
    else if (e.key === 'r' || e.key === 'R') { regenerate(); toast('已重新生成网络') }
    else if (e.key === 'Escape') select(-1)
  })
  addEventListener('resize', resize)

  // ---------- start ----------
  // small hook for embedding pages and testing
  window.edgePoint = { get nodes() { return nodes }, get links() { return links }, select, spreadFrom }

  readColors(); resize()
  if (W <= 720) { ui.panel.classList.add('collapsed'); ui.collapse.textContent = '+'; ui.collapse.setAttribute('aria-label', '展开面板') }
  regenerate()
  requestAnimationFrame(frame)
})()
