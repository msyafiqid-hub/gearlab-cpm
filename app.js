/* GEAR LAB Crank Power Meter (CPM) - mobile app (UI, Bluetooth, recording) */
(function () {
  "use strict";
  const { CpmEngine, calibrationFromSettings, parseSettingsIni, csvRow, CSV_HEADER } = window.CPM;

  const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";   // phone -> bridge
  const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";   // bridge -> phone
  const STORE_KEY = "gearlab.cpm.v1";
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ persistence
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage unavailable */ }
  }
  const store = loadStore();
  store.ui = Object.assign({ avg: 3, win: 10, graph: "power" }, store.ui || {});
  let cal = store.cal ? Object.assign(calibrationFromSettings({}), store.cal) : calibrationFromSettings({});
  store.cal = cal;

  const engine = new CpmEngine(cal);

  // ------------------------------------------------------------ app state
  const st = {
    mode: "idle",            // idle | connecting | connected | reconnecting | demo
    recording: false,
    recStartMs: 0,
    device: null, rxChar: null, userDisconnect: false,
    lastDataMs: 0,
    wakeLock: null,
  };

  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toast._h);
    toast._h = setTimeout(() => { t.style.display = "none"; }, ms || 2600);
  }

  // ------------------------------------------------------------ live buffers
  const LIVE_KEEP_S = 12;
  const live = [];                    // per packet, for the averaged readouts
  const plot = { t: [], tqL: [], tqR: [], tqLoad: [], cad: [], rear: [], pL: [], pR: [], pT: [], pLoad: [], ang: [] };
  let idleOrigin = null;

  function clearPlot() { for (const k in plot) plot[k].length = 0; idleOrigin = null; }
  function pushPlot(t, s) {
    plot.t.push(t); plot.tqL.push(s.torqueLeft); plot.tqR.push(s.torqueRight); plot.tqLoad.push(s.loadTorque);
    plot.cad.push(s.cadenceRpm); plot.rear.push(s.wheelRpm);
    plot.pL.push(s.powerLeft); plot.pR.push(s.powerRight); plot.pT.push(s.powerTotal); plot.pLoad.push(s.powerLoad);
    plot.ang.push(s.angle);
  }
  function trimPlot() {
    const keep = Math.max(store.ui.win, 10) * 1.25 + 2;
    const tEnd = plot.t.length ? plot.t[plot.t.length - 1] : 0;
    let n = 0;
    while (n < plot.t.length && plot.t[n] < tEnd - keep) n++;
    if (n > 200 || (n > 0 && plot.t.length > 20000)) for (const k in plot) plot[k].splice(0, n);
  }

  engine.onLive = (lv, samples) => {
    st.lastDataMs = performance.now();
    live.push(lv);
    while (live.length && live[0].time < lv.time - LIVE_KEEP_S) live.shift();
    if (samples) {
      for (const s of samples) pushPlot(s.t, s);
    } else if (!st.recording) {
      if (idleOrigin === null) idleOrigin = lv.time;
      pushPlot(lv.time - idleOrigin, lv);
    }
    trimPlot();
  };

  // ------------------------------------------------------------ readouts (Garmin-style average)
  function averaged(key) {
    if (!live.length) return null;
    const last = live[live.length - 1];
    const w = +store.ui.avg;
    if (!(w > 0)) return last[key];
    let sum = 0, n = 0;
    for (let i = live.length - 1; i >= 0 && live[i].time >= last.time - w; i--) {
      const v = live[i][key];
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    return n ? sum / n : null;
  }
  function showVal(id, v) {
    $(id).textContent = (v === null || !Number.isFinite(v)) ? "--" : Math.round(v).toString();
  }
  function refreshReadouts() {
    const stale = performance.now() - st.lastDataMs > 2500;
    if (stale) { ["vTotal", "vCad", "vLeft", "vRight", "vLoad", "vRear"].forEach((id) => { $(id).textContent = "--"; }); return; }
    showVal("vTotal", averaged("powerTotal"));
    showVal("vCad", averaged("cadenceRpm"));
    showVal("vLeft", averaged("powerLeft"));
    showVal("vRight", averaged("powerRight"));
    showVal("vLoad", averaged("powerLoad"));
    showVal("vRear", averaged("wheelRpm"));
  }
  setInterval(refreshReadouts, 500);

  // ------------------------------------------------------------ plotting
  const GRAPHS = {
    torque: { title: "Torque", unit: "Nm", series: [["Left crank", "tqL", "--s-yellow"], ["Right crank", "tqR", "--s-red"], ["Load", "tqLoad", "--s-green"]] },
    rpm: { title: "RPM Speed", unit: "rpm", series: [["Front", "cad", "--s-yellow"], ["Rear", "rear", "--s-red"]] },
    power: { title: "Power", unit: "W", series: [["Left", "pL", "--s-yellow"], ["Right", "pR", "--s-red"], ["Total L+R", "pT", "--s-green"], ["Load", "pLoad", "--s-white"]] },
    angle: { title: "Angle", unit: "deg", fixed: [0, 360], ticks: [0, 90, 180, 270, 360], series: [["Angle", "ang", "--s-yellow"]] },
  };
  const css = getComputedStyle(document.documentElement);
  const cvar = (n) => css.getPropertyValue(n).trim();
  let canvases = [];

  function buildGraphArea() {
    const wrap = $("graphWrap");
    wrap.innerHTML = "";
    const g = store.ui.graph;
    const keys = g === "all" ? ["torque", "rpm", "power", "angle"] : [g];
    wrap.classList.toggle("all", g === "all");
    canvases = keys.map((k) => {
      const c = document.createElement("canvas");
      c.dataset.g = k;
      wrap.appendChild(c);
      return c;
    });
  }

  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  function drawGraph(c) {
    const cfg = GRAPHS[c.dataset.g];
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    }
    const x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    x.fillStyle = cvar("--plot"); x.fillRect(0, 0, W, H);

    const showLegend = cfg.series.length > 1 && H >= 150 && W >= 240;
    const L = 46, R = 8, T = showLegend ? 40 : 26, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const win = +store.ui.win;
    const n = plot.t.length;
    const tEnd = n ? Math.max(plot.t[n - 1], win) : win;
    const tStart = tEnd - win;
    let i0 = 0;
    while (i0 < n && plot.t[i0] < tStart) i0++;

    // y range
    let lo, hi;
    if (cfg.fixed) { [lo, hi] = cfg.fixed; }
    else {
      lo = Infinity; hi = -Infinity;
      for (const [, key] of cfg.series) {
        const a = plot[key];
        for (let i = i0; i < n; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
      if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    }
    const ys = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
    const xs = (t) => L + ((t - tStart) / win) * pw;

    // grid + ticks
    x.font = "11px system-ui, sans-serif";
    x.strokeStyle = "rgba(255,255,255,0.07)"; x.lineWidth = 1;
    x.fillStyle = cvar("--dim"); x.textAlign = "right"; x.textBaseline = "middle";
    const yt = cfg.ticks || (() => { const s = niceStep(hi - lo, 4); const a = []; for (let v = Math.ceil(lo / s) * s; v <= hi; v += s) a.push(+v.toFixed(10)); return a; })();
    for (const v of yt) {
      const y = Math.round(ys(v)) + 0.5;
      x.beginPath(); x.moveTo(L, y); x.lineTo(L + pw, y); x.stroke();
      x.fillText(Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : String(+v.toPrecision(4)), L - 5, y);
    }
    x.textAlign = "center"; x.textBaseline = "top";
    const xsStep = niceStep(win, 5);
    for (let t = Math.ceil(tStart / xsStep) * xsStep; t <= tEnd + 1e-9; t += xsStep) {
      const xx = Math.round(xs(t)) + 0.5;
      x.beginPath(); x.moveTo(xx, T); x.lineTo(xx, T + ph); x.stroke();
      x.fillText(String(+t.toFixed(1)), xx, T + ph + 4);
    }
    // zero line
    if (!cfg.fixed && lo < 0 && hi > 0) {
      x.strokeStyle = "rgba(255,255,255,0.22)";
      const y = Math.round(ys(0)) + 0.5;
      x.beginPath(); x.moveTo(L, y); x.lineTo(L + pw, y); x.stroke();
    }

    // series
    x.save();
    x.beginPath(); x.rect(L, T, pw, ph); x.clip();
    x.lineWidth = 1.8; x.lineJoin = "round";
    const step = Math.max(1, Math.floor((n - i0) / (pw * 2)));
    // draw the sum first so the individual traces stay visible on top of it
    const order = cfg.series.slice().sort((p, q) => (q[1] === "pT") - (p[1] === "pT"));
    for (const [, key, color] of order) {
      const a = plot[key];
      x.strokeStyle = cvar(color);
      x.beginPath();
      let started = false, prevT = null;
      for (let i = Math.max(0, i0 - 1); i < n; i += step) {
        const px = xs(plot.t[i]), py = ys(a[i]);
        // break the line on wrap-around (angle) or on data gaps
        const gap = prevT !== null && plot.t[i] - prevT > 0.5;
        const wrap = key === "ang" && i > 0 && Math.abs(a[i] - a[i - step >= 0 ? i - step : i]) > 180;
        if (!started || gap || wrap) { x.moveTo(px, py); started = true; } else x.lineTo(px, py);
        prevT = plot.t[i];
      }
      x.stroke();
    }
    x.restore();

    // title + legend
    x.textBaseline = "middle"; x.textAlign = "left";
    x.font = "600 13px system-ui, sans-serif"; x.fillStyle = cvar("--text");
    x.fillText(cfg.title + " [" + cfg.unit + "]", L, 13);
    // legend on its own line under the title
    x.font = "11px system-ui, sans-serif"; x.textAlign = "left";
    let lx = L;
    for (const [name, , color] of showLegend ? cfg.series : []) {
      x.fillStyle = cvar(color); x.fillRect(lx, 28, 12, 2.5);
      lx += 16;
      x.fillStyle = cvar("--dim"); x.fillText(name, lx, 29);
      lx += x.measureText(name).width + 12;
    }
    if (!n) {
      x.fillStyle = cvar("--muted"); x.textAlign = "center"; x.font = "13px system-ui, sans-serif";
      x.fillText("No data yet - connect to the power meter", L + pw / 2, T + ph / 2);
    }
  }

  let lastDraw = 0;
  function frame(ts) {
    if (ts - lastDraw > 90) { lastDraw = ts; canvases.forEach(drawGraph); updateStatus(); }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ status pill
  function fmtDur(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }
  function updateStatus() {
    const p = $("statusPill");
    const noData = (st.mode === "connected" || st.mode === "demo") && performance.now() - st.lastDataMs > 2000;
    let cls = "idle", txt = "○ DISCONNECTED";
    if (st.mode === "connecting") { cls = "warn"; txt = "◌ CONNECTING"; }
    else if (st.mode === "reconnecting") { cls = "warn"; txt = "◌ RECONNECTING"; }
    else if (st.mode === "connected" || st.mode === "demo") {
      if (st.recording) { cls = "rec"; txt = "● REC " + fmtDur(Date.now() - st.recStartMs); }
      else if (noData) { cls = "warn"; txt = "● NO DATA"; }
      else { cls = "conn"; txt = st.mode === "demo" ? "● DEMO" : "● CONNECTED"; }
    }
    if (st.recording && st.mode === "reconnecting") { cls = "warn"; txt = "◌ REC · RECONNECTING"; }
    if (p.textContent !== txt) p.textContent = txt;
    if (p.className !== "pill " + cls) p.className = "pill " + cls;
  }

  // ------------------------------------------------------------ buttons state
  function refreshButtons() {
    const online = st.mode === "connected" || st.mode === "demo" || (st.recording && st.mode === "reconnecting");
    const cb = $("connectBtn");
    if (st.mode === "idle") { cb.textContent = "Connect"; cb.className = "btn primary"; }
    else if (st.mode === "demo") { cb.textContent = "Stop demo"; cb.className = "btn"; }
    else if (st.mode === "connecting") { cb.textContent = "Connecting…"; cb.className = "btn"; }
    else { cb.textContent = "Disconnect"; cb.className = "btn"; }
    cb.disabled = st.mode === "connecting";
    const sb = $("startBtn");
    sb.disabled = !online;
    sb.textContent = st.recording ? "Stop" : "Start";
    sb.className = "btn " + (st.recording ? "stop" : "start");
    $("tareBtn").disabled = !(st.mode === "connected" || st.mode === "demo") || st.recording;
    $("lockable").classList.toggle("locked", st.recording);
    $("settingsBtn").disabled = false;
  }

  // ------------------------------------------------------------ wake lock
  async function keepAwake(on) {
    try {
      if (on && "wakeLock" in navigator && !st.wakeLock) {
        st.wakeLock = await navigator.wakeLock.request("screen");
        st.wakeLock.addEventListener("release", () => { st.wakeLock = null; });
      } else if (!on && st.wakeLock) { await st.wakeLock.release(); st.wakeLock = null; }
    } catch (e) { /* not supported or not allowed */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && st.mode !== "idle") keepAwake(true);
    if (document.visibilityState === "hidden" && st.recording) {
      // The browser may pause Bluetooth in the background; warn on return
      st.wasHiddenWhileRecording = true;
    } else if (st.wasHiddenWhileRecording) {
      st.wasHiddenWhileRecording = false;
      toast("The app was in the background during recording - check the data for gaps.", 4500);
    }
  });

  // ------------------------------------------------------------ Bluetooth
  let writeChain = Promise.resolve();
  function bleWrite(text) {
    if (!st.rxChar) return;
    const bytes = new TextEncoder().encode(text);
    const ch = st.rxChar;
    writeChain = writeChain.then(() =>
      (ch.writeValueWithResponse ? ch.writeValueWithResponse(bytes) : ch.writeValue(bytes))
    ).catch((e) => console.warn("write failed", e));
  }
  function sendRidingLoad() {
    if (st.mode !== "connected") return;
    bleWrite(engine.torqueCommand(cal.pTorq));
  }

  function onNotify(ev) {
    const dv = ev.target.value;
    engine.feed(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  }

  async function openGatt() {
    const server = await st.device.gatt.connect();
    const svc = await server.getPrimaryService(NUS_SERVICE);
    const tx = await svc.getCharacteristic(NUS_TX);
    st.rxChar = await svc.getCharacteristic(NUS_RX);
    engine.resetConnectionState();
    tx.addEventListener("characteristicvaluechanged", onNotify);
    await tx.startNotifications();
    st.mode = "connected";
    st.lastDataMs = performance.now();
    refreshButtons();
    keepAwake(true);
    sendRidingLoad();          // the PC also sends the riding load on connect
  }

  async function connect() {
    if (!navigator.bluetooth) {
      showBleHelp(true);
      return;
    }
    try {
      st.mode = "connecting"; refreshButtons();
      st.userDisconnect = false;
      st.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }, { namePrefix: "GEARLAB" }],
        optionalServices: [NUS_SERVICE],
      });
      st.device.addEventListener("gattserverdisconnected", onDisconnected);
      await openGatt();
      toast("Connected to " + (st.device.name || "power meter"));
    } catch (e) {
      st.mode = "idle"; refreshButtons();
      if (e && e.name !== "NotFoundError") toast("Could not connect: " + (e.message || e), 4000);
    }
  }

  async function onDisconnected() {
    st.rxChar = null;
    if (st.userDisconnect) return;
    // Unexpected drop: keep the recording open and keep trying to reconnect
    st.mode = "reconnecting"; refreshButtons();
    for (let attempt = 1; attempt <= 30 && !st.userDisconnect; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3000)));
        if (st.userDisconnect) return;
        await openGatt();
        toast("Reconnected" + (st.recording ? " - recording continues" : ""));
        return;
      } catch (e) { /* retry */ }
    }
    if (!st.userDisconnect) {
      if (st.recording) await stopRecording();
      st.mode = "idle"; refreshButtons(); keepAwake(false);
      toast("Lost connection to the power meter.", 4500);
    }
  }

  async function disconnect() {
    st.userDisconnect = true;
    if (st.recording) await stopRecording();
    try { if (st.device && st.device.gatt.connected) st.device.gatt.disconnect(); } catch (e) { /* ignore */ }
    st.rxChar = null;
    st.mode = "idle"; refreshButtons(); keepAwake(false);
  }

  // ------------------------------------------------------------ demo mode
  let demoTimer = null;
  function startDemo() {
    if (st.mode !== "idle") { toast("Disconnect first."); return; }
    engine.resetConnectionState();
    st.mode = "demo"; st.lastDataMs = performance.now();
    const d = { enc1: 30000, enc2: 20000, step: 0, t0: performance.now(), angle: 0, cad: 0 };
    const sampleDt = 0.01075;       // 4 samples per 43 ms packet, like the hardware
    // raw sensor value giving polyval(coef, raw) = target (robust: Newton from the
    // linear estimate, falls back to a bisection-free clamp if it cannot converge)
    const invert = (coef, target) => {
      const f = (r) => { let y = 0; for (const c of coef) y = y * r + c; return y; };
      const df = (r) => { let y = 0, d = 0; for (const c of coef) { d = d * r + y; y = y * r + c; } return d; };
      const d0 = df(0);
      let r = Math.abs(d0) > 1e-12 ? (target - f(0)) / d0 : 0;
      for (let it = 0; it < 40; it++) {
        const d = df(r);
        if (Math.abs(d) < 1e-12) break;
        const nr = r - (f(r) - target) / d;
        if (!Number.isFinite(nr)) break;
        if (Math.abs(nr - r) < 1e-6) { r = nr; break; }
        r = nr;
      }
      if (!Number.isFinite(r) || Math.abs(f(r) - target) > 0.01 * Math.abs(target) + 0.01) {
        r = Math.abs(d0) > 1e-12 ? (target - f(0)) / d0 : 0;     // linear approximation
      }
      return Math.max(-32000, Math.min(32000, r));
    };
    demoTimer = setInterval(() => {
      const el = (performance.now() - d.t0) / 1000;
      const targetCad = 80 + 10 * Math.sin(el / 9);
      d.cad += (targetCad - d.cad) * 0.05;
      const torquePeak = 35 + 8 * Math.sin(el / 5);              // Nm
      const g = 9.80665 * cal.crankLengthMm / 1000;
      const p = new Uint8Array(28);
      p[0] = 0xAA; p[1] = 0x55; p[2] = 26;
      for (let i = 0; i < 4; i++) {
        d.angle += d.cad / 60 * 360 * sampleDt;
        const th = d.angle * Math.PI / 180;
        const tL = Math.max(0, torquePeak * Math.sin(th)) + (Math.random() - 0.5) * 1.5;
        const tR = Math.max(0, torquePeak * 0.95 * Math.sin(th + Math.PI)) + (Math.random() - 0.5) * 1.5;
        const w1 = Math.round(invert(cal.rightCoef, tR / g + cal.tarRight));   // weight1 = right
        const w2 = Math.round(invert(cal.leftCoef, tL / g + cal.tarLeft));     // weight2 = left
        const r1 = Math.max(-32768, Math.min(32767, -w1)) & 0xFFFF;
        const r2 = Math.max(-32768, Math.min(32767, -w2)) & 0xFFFF;
        p[3 + i * 4] = r1 & 0xFF; p[4 + i * 4] = r1 >> 8;
        p[5 + i * 4] = r2 & 0xFF; p[6 + i * 4] = r2 >> 8;
      }
      p[19] = 11;
      p[20] = d.step = (d.step + 1) & 0xFF;
      const ratio = cal.frontChainringTeeth / cal.selectedRearSprocketTeeth;
      d.enc1 -= d.cad / 60 * 2 * cal.ppr * cal.gearRatio * 0.043;
      d.enc2 -= d.cad * ratio / 60 * 2 * cal.ppr2 * cal.gearRatio2 * 0.043;
      const e1 = ((Math.round(d.enc1) % 65536) + 65536) % 65536;
      const e2 = ((Math.round(d.enc2) % 65536) + 65536) % 65536;
      p[21] = e1 & 0xFF; p[22] = e1 >> 8; p[23] = e2 & 0xFF; p[24] = e2 >> 8;
      const loadRaw = Math.round(invert(cal.loadCoef, cal.pTorq * 0.9 + cal.tarLoad + (Math.random() - 0.5) * 0.2)) + 32767;
      const lr = Math.max(0, Math.min(65535, loadRaw));
      p[25] = lr & 0xFF; p[26] = lr >> 8;
      let s = 0; for (let i = 0; i < 27; i++) s += p[i];
      p[27] = (~s) & 0xFF;
      const us = Math.round(performance.now() * 1000) >>> 0;
      const f = new Uint8Array(32);
      f.set(p); f[28] = us & 0xFF; f[29] = (us >>> 8) & 0xFF; f[30] = (us >>> 16) & 0xFF; f[31] = (us >>> 24) & 0xFF;
      engine.feed(f);
    }, 43);
    refreshButtons(); keepAwake(true);
    toast("Demo mode - simulated data");
  }
  async function stopDemo() {
    if (st.recording) await stopRecording();
    clearInterval(demoTimer); demoTimer = null;
    st.mode = "idle"; refreshButtons(); keepAwake(false);
  }

  // ------------------------------------------------------------ recording storage (IndexedDB)
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("gearlab-cpm", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("recs", { keyPath: "id" });
        d.createObjectStore("chunks", { keyPath: ["rec", "seq"] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function idb(storeName, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const out = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const rec = { id: null, name: "", seq: 0, pending: [], rows: 0, flushTimer: null, lastT: 0, saving: Promise.resolve() };

  function stamp(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  function flushRec() {
    if (!rec.id || !rec.pending.length) return rec.saving;
    const text = rec.pending.join("");
    rec.pending = [];
    const chunk = { rec: rec.id, seq: rec.seq++, text };
    const meta = { id: rec.id, name: rec.name, created: rec.created, rows: rec.rows, duration: rec.lastT, done: false,
      front: rec.front, rearT: rec.rearT };
    rec.saving = rec.saving.then(() => idb("chunks", "readwrite", (s) => s.put(chunk)))
      .then(() => idb("recs", "readwrite", (s) => s.put(meta)))
      .catch((e) => { console.error(e); toast("Saving failed: " + e.message, 5000); });
    return rec.saving;
  }

  async function startRecording() {
    const now = new Date();
    rec.id = now.getTime();
    rec.name = `data_${stamp(now)}.csv`;
    rec.created = now.toISOString();
    rec.seq = 0; rec.rows = 0; rec.pending = [CSV_HEADER.join(",") + "\r\n"]; rec.lastT = 0;
    rec.front = cal.frontChainringTeeth; rec.rearT = cal.selectedRearSprocketTeeth;
    clearPlot();
    live.length = 0;
    engine.onSamples = (samples) => {
      for (const s of samples) { rec.pending.push(csvRow(s) + "\r\n"); rec.rows++; rec.lastT = s.t; }
    };
    engine.start({
      crankLengthMm: cal.crankLengthMm,
      frontChainringTeeth: cal.frontChainringTeeth,
      rearSprocketTeeth: cal.selectedRearSprocketTeeth,
      wheelCircumferenceM: cal.wheelCircumferenceM,
    }, engine.bridgeNow());
    st.recording = true; st.recStartMs = Date.now();
    rec.flushTimer = setInterval(flushRec, 1000);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    refreshButtons();
    flushRec();
  }

  async function stopRecording() {
    if (!st.recording) return;
    engine.stop();
    engine.onSamples = null;
    st.recording = false;
    clearInterval(rec.flushTimer);
    await flushRec();
    const meta = { id: rec.id, name: rec.name, created: rec.created, rows: rec.rows, duration: rec.lastT, done: true,
      front: rec.front, rearT: rec.rearT };
    await idb("recs", "readwrite", (s) => s.put(meta));
    const id = rec.id;
    rec.id = null;
    refreshButtons();
    await renderRecordings();
    toast(`Saved ${meta.name} (${meta.rows.toLocaleString()} rows)`, 3500);
    return id;
  }

  async function recordingBlob(id) {
    const meta = await idb("recs", "readonly", (s) => s.get(id));
    const chunks = await idb("chunks", "readonly", (s) => s.getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
    chunks.sort((a, b) => a.seq - b.seq);
    return { meta, blob: new Blob(chunks.map((c) => c.text), { type: "text/csv" }) };
  }
  async function shareRecording(id) {
    const { meta, blob } = await recordingBlob(id);
    const file = new File([blob], meta.name, { type: "text/csv" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: meta.name }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    saveRecording(id, blob, meta);
  }
  async function saveRecording(id, blob, meta) {
    if (!blob) ({ meta, blob } = await recordingBlob(id));
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = meta.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }
  async function deleteRecording(id) {
    if (!confirm("Delete this recording from the phone?")) return;
    await idb("chunks", "readwrite", (s) => s.delete(IDBKeyRange.bound([id, 0], [id, Infinity])));
    await idb("recs", "readwrite", (s) => s.delete(id));
    renderRecordings();
  }

  async function renderRecordings() {
    let list = [];
    try { list = await idb("recs", "readonly", (s) => s.getAll()); } catch (e) { /* IDB unavailable */ }
    list.sort((a, b) => b.id - a.id);
    const el = $("recList");
    if (!list.length) { el.innerHTML = '<p class="hint">No recordings yet. Press Start to record a CSV (same columns as the PC app).</p>'; return; }
    el.innerHTML = "";
    for (const r of list) {
      const item = document.createElement("div");
      item.className = "rec-item";
      const status = r.done ? "" : (rec.id === r.id ? " · recording…" : " · interrupted (data kept)");
      item.innerHTML = `<div class="meta"><b></b><span></span></div>
        <button class="btn small" data-act="share">Share</button>
        <button class="btn small" data-act="save">Save</button>
        <button class="btn small" data-act="del" aria-label="Delete">✕</button>`;
      item.querySelector("b").textContent = r.name;
      item.querySelector("span").textContent =
        `${fmtDur((r.duration || 0) * 1000)} · ${Number(r.rows || 0).toLocaleString()} rows · ${r.front || "?"}/${r.rearT || "?"}T${status}`;
      item.querySelector('[data-act="share"]').onclick = () => shareRecording(r.id);
      item.querySelector('[data-act="save"]').onclick = () => saveRecording(r.id);
      item.querySelector('[data-act="del"]').onclick = () => deleteRecording(r.id);
      if (rec.id === r.id) item.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      el.appendChild(item);
    }
  }

  // ------------------------------------------------------------ Reset Crank (tare), same as PC
  async function tare() {
    if (st.mode !== "connected" && st.mode !== "demo") return;
    const btn = $("tareBtn");
    btn.disabled = true; btn.textContent = "Keep cranks still… 2 s";
    const accR = [], accL = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const h = setInterval(() => {
        if (performance.now() - t0 >= 2000) { clearInterval(h); resolve(); return; }
        if (Number.isFinite(engine.lastCrankMassRight) && Number.isFinite(engine.lastCrankMassLeft)) {
          accR.push(engine.lastCrankMassRight); accL.push(engine.lastCrankMassLeft);
        }
      }, 50);
    });
    btn.textContent = "Reset Crank (zero torque)";
    if (accR.length && accL.length) {
      cal.tarRight += accR.reduce((a, b) => a + b, 0) / accR.length;
      cal.tarLeft += accL.reduce((a, b) => a + b, 0) / accL.length;
      cal.tareSource = "phone " + new Date().toLocaleString();
      engine.setCalibrationKeepState ? engine.setCalibrationKeepState(cal) : (engine.cal = cal);
      saveStore(); renderCalSummary();
      toast("Crank reset successfully.");
    } else toast("No torque data collected.");
    refreshButtons();
  }

  // ------------------------------------------------------------ controls
  function fillRearSelect() {
    const sel = $("rearSelect");
    sel.innerHTML = "";
    cal.cassetteTeeth.forEach((teeth, i) => {
      const o = document.createElement("option");
      o.value = teeth; o.textContent = `${teeth} T  (pos ${i + 1})`;
      sel.appendChild(o);
    });
    sel.value = String(cal.selectedRearSprocketTeeth);
  }
  function refreshControls() {
    $("loadInput").value = (+cal.pTorq).toFixed(2);
    $("frontInput").value = cal.frontChainringTeeth;
    $("crankInput").value = (+cal.crankLengthMm).toFixed(1);
    $("wheelInput").value = (+cal.wheelCircumferenceM).toFixed(3);
    fillRearSelect();
    const f = cal.frontChainringTeeth, r = cal.selectedRearSprocketTeeth;
    $("ratioHint").textContent = `Ratio ${f}/${r} = ${(f / r).toFixed(3)}`;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let loadSendTimer = null;
  function setField(which, value) {
    if (!Number.isFinite(value)) { refreshControls(); return; }
    if (which === "load") {
      cal.pTorq = +clamp(value, 0, 1000).toFixed(2);
      clearTimeout(loadSendTimer); loadSendTimer = setTimeout(sendRidingLoad, 250);
    } else if (which === "front") {
      if (st.recording) return;
      cal.frontChainringTeeth = clamp(Math.round(value), 1, 100);
    } else if (which === "crank") {
      if (st.recording) return;
      cal.crankLengthMm = +clamp(value, 50, 250).toFixed(1);
    } else if (which === "wheel") {
      cal.wheelCircumferenceM = +clamp(value, 0.5, 4).toFixed(4);
    }
    saveStore(); refreshControls();
  }
  document.querySelectorAll(".stepper button").forEach((b) => {
    b.addEventListener("click", () => {
      const which = b.dataset.for, step = +b.dataset.step;
      const cur = { load: cal.pTorq, front: cal.frontChainringTeeth, crank: cal.crankLengthMm, wheel: cal.wheelCircumferenceM }[which];
      setField(which, +(cur + step).toFixed(4));
    });
  });
  [["loadInput", "load"], ["frontInput", "front"], ["crankInput", "crank"], ["wheelInput", "wheel"]].forEach(([id, which]) => {
    $(id).addEventListener("change", (e) => setField(which, parseFloat(e.target.value)));
  });
  $("rearSelect").addEventListener("change", (e) => {
    if (st.recording) { refreshControls(); return; }
    cal.selectedRearSprocketTeeth = +e.target.value; saveStore(); refreshControls();
  });

  function bindSeg(id, key, attr, after) {
    const seg = $(id);
    const sync = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", String(store.ui[key]) === b.dataset[attr]));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      store.ui[key] = attr === "v" ? +b.dataset[attr] : b.dataset[attr];
      saveStore(); sync(); if (after) after();
    });
    sync();
  }
  bindSeg("avgSeg", "avg", "v", refreshReadouts);
  bindSeg("graphSeg", "graph", "g", buildGraphArea);
  bindSeg("winSeg", "win", "v");

  $("connectBtn").addEventListener("click", () => {
    if (st.mode === "idle") connect();
    else if (st.mode === "demo") stopDemo();
    else disconnect();
  });
  $("startBtn").addEventListener("click", async () => {
    if (st.recording) {
      await stopRecording();
    } else {
      await startRecording();
      renderRecordings();
    }
  });
  $("tareBtn").addEventListener("click", tare);

  // ------------------------------------------------------------ settings sheet / calibration import
  function renderCalSummary() {
    const fmt = (a) => "[" + a.map((v) => +(+v).toPrecision(6)).join(", ") + "]";
    const rows = [
      ["Source", cal.source || "defaults (not imported yet)"],
      ["Right crank", fmt(cal.rightCoef)],
      ["Left crank", fmt(cal.leftCoef)],
      ["Tare R / L", `${(+cal.tarRight).toFixed(4)} / ${(+cal.tarLeft).toFixed(4)}` + (cal.tareSource ? ` (${cal.tareSource})` : "")],
      ["Load sensor", fmt(cal.loadCoef) + ` tare ${(+cal.tarLoad).toFixed(4)}`],
      ["Brake (TQ)", fmt(cal.powderCoef)],
      ["Rear encoder", `PPR ${+(+cal.ppr2).toFixed(4)} · ratio ${+(+cal.gearRatio2).toFixed(4)}`],
      ["Cassette", cal.cassetteTeeth.join(", ")],
    ];
    const dl = $("calSummary");
    dl.innerHTML = "";
    for (const [k, v] of rows) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }
    const warn = !cal.source;
    showBanner("cal", warn ? "No calibration imported yet. Open Settings (⚙) and import settings.ini from the PC." : "");
  }
  function applyIni(text, label) {
    const parsed = parseSettingsIni(text);
    if (!parsed.rightCoef && !parsed.leftCoef && !parsed.loadCoef) {
      toast("That file has no calibration values (rightCoef / leftCoef / loadCoef).", 4500);
      return;
    }
    const next = calibrationFromSettings(parsed);
    next.source = `${label} · ${new Date().toLocaleString()}`;
    cal = Object.assign(cal, next);
    delete cal.tareSource;
    store.cal = cal;
    engine.setCalibrationKeepState ? engine.setCalibrationKeepState(cal) : engine.setCalibration(cal);
    saveStore(); refreshControls(); renderCalSummary();
    toast("Calibration imported.");
    sendRidingLoad();
  }
  $("iniFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    applyIni(await f.text(), f.name);
    e.target.value = "";
  });
  $("pasteToggle").addEventListener("click", () => { $("pasteBox").hidden = !$("pasteBox").hidden; });
  $("pasteApply").addEventListener("click", () => applyIni($("pasteText").value, "pasted text"));
  $("settingsBtn").addEventListener("click", () => { renderCalSummary(); $("settingsDlg").showModal(); });
  $("closeSettings").addEventListener("click", () => $("settingsDlg").close());
  $("demoBtn").addEventListener("click", () => { $("settingsDlg").close(); startDemo(); });

  // ------------------------------------------------------------ banners
  const banners = {};
  function showBanner(key, html, err) {
    banners[key] = html ? { html, err } : null;
    const el = $("banners");
    el.innerHTML = "";
    for (const k in banners) {
      if (!banners[k]) continue;
      const d = document.createElement("div");
      d.className = "banner" + (banners[k].err ? " err" : "");
      d.innerHTML = banners[k].html;
      el.appendChild(d);
    }
    el.style.display = el.children.length ? "grid" : "none";
    el.style.gap = "8px";
  }
  function showBleHelp(force) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (navigator.bluetooth && !force) { $("bleSupport").textContent = "Bluetooth: supported in this browser."; return; }
    const msg = ios
      ? "This browser can't use Bluetooth. On iPhone, open this page in the free <b>Bluefy – Web BLE Browser</b> app."
      : "This browser can't use Bluetooth. On Android, open this page in <b>Google Chrome</b>.";
    $("bleSupport").innerHTML = msg;
    showBanner("ble", msg + " Demo mode still works (⚙ Settings).", true);
  }

  // ------------------------------------------------------------ boot
  window.addEventListener("beforeunload", (e) => { if (st.recording) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("resize", () => canvases.forEach(drawGraph));
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  refreshControls();
  renderCalSummary();
  buildGraphArea();
  refreshButtons();
  if (!navigator.bluetooth) showBleHelp(true); else showBleHelp(false);
  renderRecordings();
  requestAnimationFrame(frame);

  // exposed for automated checks
  window.__cpm = { engine, st, startDemo, stopDemo, startRecording, stopRecording, recordingBlob, applyIni, get cal() { return cal; } };
})();
