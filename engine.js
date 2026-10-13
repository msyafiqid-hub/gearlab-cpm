/*
 * GEAR LAB Crank Power Meter (CPM) - measurement engine
 *
 * A line-by-line port of the PC application's processing
 * (SerialReaderThread.run, RPMCalculator, handle_serial_data,
 * compute_angle, calculate_power*, calculate_speed_kmh and the CSV row).
 * The goal is identical numbers to the PC app for the same packets.
 *
 * Input: byte stream from the XIAO bridge, made of 32-byte frames:
 *        [28-byte packet exactly as on USB][uint32 LE micros timestamp]
 */
(function (root) {
  "use strict";

  const HEADER1 = 0xAA;
  const HEADER2 = 0x55;
  const PACKET_SIZE = 28;
  const FRAME_SIZE = 32;
  const GRAVITY_M_S2 = 9.80665;
  const DEFAULT_CRANK_LENGTH_MM = 170.0;
  const RPM_NOMINAL_PACKET_DT_S = 0.043;
  const MAX_COUNT = 65536;
  const DEFAULT_CASSETTE_TEETH = [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34];

  const CSV_HEADER = [
    "Timestamp (s)", "Angle (deg)",
    "CrankLeft (Nm)", "CrankRight (Nm)",
    "Cadence (RPM)", "Wheel (RPM)", "Speed (Kmh)",
    "PowerLeft (Watt)", "PowerRight (Watt)",
    "PowerTotal (Watt)", "PowerLoad (Watt)",
    "Front Chainring (Teeth)", "Rear Sprocket (Teeth)",
    "Bicycle Gear Ratio", "Wheel Circumference (m)",
  ];

  // ---------- numeric helpers matching Python / numpy ----------
  // numpy.poly1d(coef)(x) : Horner evaluation, highest power first
  function polyval(coef, x) {
    let y = 0;
    for (let i = 0; i < coef.length; i++) y = y * x + coef[i];
    return y;
  }
  // Python float modulo (result takes the sign of the divisor)
  function pymod(a, b) {
    let r = a % b;
    if (r !== 0 && (r < 0) !== (b < 0)) r += b;
    return r;
  }
  // numpy.interp with two support points
  function interp2(x, xp0, xp1, fp0, fp1) {
    if (x <= xp0) return x === xp0 ? fp0 : fp0;
    if (x >= xp1) return fp1;
    const slope = (fp1 - fp0) / (xp1 - xp0);
    return slope * (x - xp0) + fp0;
  }
  function signedLE16(lo, hi) {
    const v = lo | (hi << 8);
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  // ---------- settings.ini (QSettings IniFormat) ----------
  function parseSettingsIni(text) {
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
        val = val.slice(1, -1).replace(/\\(.)/g, "$1");
      }
      out[key] = val;
    }
    return out;
  }

  function parseList(str, fallback) {
    if (str === undefined || str === null) return fallback.slice();
    const nums = String(str).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    if (!nums || !nums.length) return fallback.slice();
    const arr = nums.map(Number);
    return arr.every(Number.isFinite) ? arr : fallback.slice();
  }
  function parseNum(str, fallback) {
    if (str === undefined || str === null || str === "") return fallback;
    const v = Number(str);
    return Number.isFinite(v) ? v : fallback;
  }

  // Same keys and defaults as load_calibration() in the PC app
  function calibrationFromSettings(s) {
    s = s || {};
    let cassette = String(s.cassette_teeth || "").match(/\d+/g);
    cassette = cassette ? cassette.map(Number) : [];
    if (cassette.length !== 12) cassette = DEFAULT_CASSETTE_TEETH.slice();
    let selected = Math.trunc(parseNum(s.selected_rear_sprocket_teeth, 17));
    if (!cassette.includes(selected)) selected = cassette[0];
    return {
      rightCoef: parseList(s.rightCoef, [1, 0]),
      leftCoef: parseList(s.leftCoef, [1, 0]),
      loadCoef: parseList(s.loadCoef, [1, 0]),
      powderCoef: parseList(s.powderCoef, [1, 0]),
      tarRight: parseNum(s.tarRight, 0),
      tarLeft: parseNum(s.tarLeft, 0),
      tarLoad: parseNum(s.tarLoad, 0),
      crankLengthMm: parseNum(s.crank_length_mm, DEFAULT_CRANK_LENGTH_MM),
      ppr: 360,              // front encoder (fixed in PC app)
      gearRatio: 1,
      ppr2: parseNum(s.rear_encoder_ppr, 360),
      gearRatio2: parseNum(s.rear_encoder_gear_ratio, 1),
      wheelCircumferenceM: parseNum(s.wheel_circumference_m, 2.105),
      frontChainringTeeth: Math.trunc(parseNum(s.front_chainring_teeth, 34)),
      cassetteTeeth: cassette,
      selectedRearSprocketTeeth: selected,
      pTorq: parseNum(s.p_torq, 0),
    };
  }

  // ---------- RPMCalculator (identical to PC) ----------
  class RPMCalculator {
    constructor(ppr, gearRatio, maxCount, alpha) {
      this.ppr = ppr; this.gearRatio = gearRatio;
      this.maxCount = maxCount; this.alpha = alpha;
      this.lastCount = null; this.lastTime = null; this.lastRpm = 0.0;
    }
    calculate(currentCount, currentTime) {
      currentCount = +currentCount; currentTime = +currentTime;
      if (this.lastCount === null) {
        this.lastCount = currentCount; this.lastTime = currentTime;
        return 0.0;
      }
      const dt = currentTime - this.lastTime;
      if (dt > 0.005) {
        let delta = currentCount - this.lastCount;
        if (delta < -this.maxCount / 2) delta += this.maxCount;
        else if (delta > this.maxCount / 2) delta -= this.maxCount;
        const effectiveDelta = delta / 2.0;
        const revolutions = effectiveDelta / (this.ppr * this.gearRatio);
        const rawRpm = -(revolutions / dt) * 60.0;
        let a;
        if (this.alpha >= 1.0) a = 1.0;
        else if (this.alpha <= 0.0) a = 0.0;
        else {
          const tau = -RPM_NOMINAL_PACKET_DT_S / Math.log1p(-this.alpha);
          a = -Math.expm1(-dt / tau);
        }
        const rpm = a * rawRpm + (1.0 - a) * this.lastRpm;
        this.lastRpm = rpm; this.lastCount = currentCount; this.lastTime = currentTime;
        return rpm;
      }
      return this.lastRpm;
    }
  }

  // ---------- frame parser + bridge clock ----------
  class FrameParser {
    constructor(onFrame) {
      this.onFrame = onFrame;
      this.buf = new Uint8Array(FRAME_SIZE);
      this.len = 0;
      this.lastStampUs = null;
      this.stampHighUs = 0;   // unwrapping of the 32-bit micros() counter
      this.badFrames = 0;
    }
    reset() { this.len = 0; this.lastStampUs = null; this.stampHighUs = 0; }
    push(bytes) {
      for (let k = 0; k < bytes.length; k++) {
        const b = bytes[k];
        this.buf[this.len++] = b;
        if (this.len >= 2 && (this.buf[0] !== HEADER1 || this.buf[1] !== HEADER2)) {
          this.buf.copyWithin(0, 1, this.len);
          this.len--;
          continue;
        }
        if (this.len === PACKET_SIZE) {
          // validate before waiting for the timestamp bytes
          if (this.buf[2] !== 26 || !checksumOk(this.buf)) {
            this.badFrames++;
            // resync: drop the header byte and rescan what we have
            const rest = this.buf.slice(1, this.len);
            this.len = 0;
            this.push(rest);
            continue;
          }
        }
        if (this.len === FRAME_SIZE) {
          const b = this.buf;
          const stamp = (b[28] | (b[29] << 8) | (b[30] << 16) | (b[31] << 24)) >>> 0;
          if (this.lastStampUs !== null && stamp < this.lastStampUs &&
              this.lastStampUs - stamp > 0x80000000) {
            this.stampHighUs += 0x100000000;
          }
          this.lastStampUs = stamp;
          const tSec = (this.stampHighUs + stamp) / 1e6;
          this.onFrame(b.slice(0, PACKET_SIZE), tSec);
          this.len = 0;
        }
      }
    }
  }
  function checksumOk(p) {
    let s = 0;
    for (let i = 0; i < 27; i++) s += p[i];
    return ((~(s & 0xFF)) & 0xFF) === p[27];
  }

  // ---------- engine: SerialReaderThread timing + handle_serial_data ----------
  class CpmEngine {
    constructor(cal) {
      this.setCalibration(cal || calibrationFromSettings({}));
      this.parser = new FrameParser((p, t) => this.handlePacket(p, t));
      this.onSamples = null;      // (samples[]) while recording
      this.onLive = null;         // (live) every packet
      this.resetConnectionState();
      this.recording = false;
      this.startOrigin = null;
      this.clockOffset = 0;
      this.prevSessionEnd = null;
    }

    setCalibration(cal) {
      this.cal = cal;
      this.rpmCalc1 = new RPMCalculator(cal.ppr, cal.gearRatio, MAX_COUNT, 0.1);
      this.rpmCalc2 = new RPMCalculator(cal.ppr2, cal.gearRatio2, MAX_COUNT, 0.1);
    }

    // Swap calibration values without losing encoder/RPM history
    setCalibrationKeepState(cal) {
      this.cal = cal;
      this.rpmCalc1.ppr = cal.ppr; this.rpmCalc1.gearRatio = cal.gearRatio;
      this.rpmCalc2.ppr = cal.ppr2; this.rpmCalc2.gearRatio = cal.gearRatio2;
    }

    // State reset on (re)connect, as when the PC creates a new serial thread
    resetConnectionState() {
      if (this.parser) this.parser.reset();
      // Keep time continuous if the bridge restarted its clock (e.g. power loss)
      if (this.lastBridgeTime !== null && this.lastBridgeTime !== undefined) {
        this.prevSessionEnd = this.lastBridgeTime;
      }
      this.firstAfterReset = true;
      this.lastCounterStepThread = null;
      this.lastDeltaTime = [-Infinity, -Infinity, -Infinity, -Infinity];
      this.lastCounterStep = null;
      this.enc1LastRaw = null; this.enc1Unwrapped = null;
      this.enc2LastRaw = null; this.enc2Unwrapped = null;
      this.lastGetEncoder1 = 0; this.lastGetEncoder2 = 0; this.lastGetLoadSensor = 0;
      this.lastBridgeTime = null; this.lastArrivalMs = null;
      this.packets = 0;
    }

    feed(bytes) { this.parser.push(bytes); }

    // Estimate of the bridge clock "now" (for the Start button origin)
    bridgeNow() {
      if (this.lastBridgeTime === null) return null;
      const nowMs = (typeof performance !== "undefined") ? performance.now() : Date.now();
      return this.lastBridgeTime + Math.max(0, nowMs - this.lastArrivalMs) / 1000;
    }

    crankLengthM() {
      if (this.trial) return this.trial.crankLengthM;
      return this.cal.crankLengthMm / 1000.0;
    }

    // Start recording. originSec: bridge-clock time of t = 0
    start(settings, originSec) {
      const s = settings;
      this.trial = {
        crankLengthM: s.crankLengthMm / 1000.0,
        front: Math.trunc(s.frontChainringTeeth),
        rear: Math.trunc(s.rearSprocketTeeth),
        wheelCircumferenceM: +s.wheelCircumferenceM,
      };
      this.startOrigin = originSec;
      this.zeroAngleDeg = null;
      this.zeroPending = true;
      this.recording = true;
    }
    stop() {
      this.recording = false;
      this.zeroPending = false;
      this.trial = null;
    }

    computeAngle(count) {
      const cpr = this.cal.ppr * this.cal.gearRatio;
      const c = count / 2;
      const angle = pymod(c, cpr) * (360.0 / cpr);
      const inverted = pymod(360.0 - angle, 360.0);
      if (this.zeroAngleDeg === null || this.zeroAngleDeg === undefined) return inverted;
      return pymod(inverted - this.zeroAngleDeg, 360.0);
    }

    unwrap(which, raw) {
      raw = +raw;
      const lastKey = which === 1 ? "enc1LastRaw" : "enc2LastRaw";
      const unKey = which === 1 ? "enc1Unwrapped" : "enc2Unwrapped";
      if (this[lastKey] === null) {
        this[lastKey] = raw; this[unKey] = raw;
        return raw;
      }
      let delta = raw - this[lastKey];
      if (delta < -(MAX_COUNT / 2.0)) delta += MAX_COUNT;
      else if (delta > MAX_COUNT / 2.0) delta -= MAX_COUNT;
      this[unKey] += delta;
      this[lastKey] = raw;
      return this[unKey];
    }

    speedKmh(wheelRpm) {
      const c = this.trial ? this.trial.wheelCircumferenceM : this.cal.wheelCircumferenceM;
      return Math.abs(wheelRpm) * c * 60.0 / 1000.0;
    }

    handlePacket(p, curTime) {
      if (this.firstAfterReset) {
        this.firstAfterReset = false;
        if (this.prevSessionEnd !== null && curTime + this.clockOffset <= this.prevSessionEnd) {
          this.clockOffset += this.prevSessionEnd - (curTime + this.clockOffset) + 0.05;
        }
      }
      curTime += this.clockOffset;
      this.lastBridgeTime = curTime;
      this.lastArrivalMs = (typeof performance !== "undefined") ? performance.now() : Date.now();
      this.packets++;

      // --- SerialReaderThread part ---
      const weight1 = [], weight2 = [];
      for (let i = 0; i < 16; i += 4) {
        weight1.push(-signedLE16(p[3 + i], p[4 + i]));
        weight2.push(-signedLE16(p[5 + i], p[6 + i]));
      }
      const dtS = p[19] / 1000.0;
      const counterStep = p[20];
      let delTime = [curTime - dtS * 3.0, curTime - dtS * 2.0, curTime - dtS, curTime];
      if (counterStep !== this.lastCounterStepThread) {
        this.lastCounterStepThread = counterStep;
        if (this.lastDeltaTime[3] >= delTime[0]) {
          const dtT = (curTime - this.lastDeltaTime[3]) / 4.0;
          delTime = [curTime - dtT * 3.0, curTime - dtT * 2.0, curTime - dtT, curTime];
        }
        this.lastDeltaTime = delTime;
      }
      const getEncoder1 = p[21] | (p[22] << 8);
      const getEncoder2 = p[23] | (p[24] << 8);
      const getLoadSensor = (p[25] | (p[26] << 8)) - 32767;

      // --- handle_serial_data part ---
      if (counterStep === this.lastCounterStep) return;
      this.lastCounterStep = counterStep;

      const cal = this.cal;
      const torqueFactor = GRAVITY_M_S2 * this.crankLengthM();

      // Crank mass of this packet (used by Reset Crank tare)
      let mR = 0, mL = 0;
      for (let i = 0; i < 4; i++) {
        mR += polyval(cal.rightCoef, weight1[i]) - cal.tarRight;
        mL += polyval(cal.leftCoef, weight2[i]) - cal.tarLeft;
      }
      this.lastCrankMassRight = mR / 4;
      this.lastCrankMassLeft = mL / 4;

      const packetTimestamp = delTime[3];

      let prev1 = this.enc1Unwrapped;
      const cur1 = this.unwrap(1, getEncoder1);
      if (prev1 === null) prev1 = cur1;
      let prev2 = this.enc2Unwrapped;
      const cur2 = this.unwrap(2, getEncoder2);
      if (prev2 === null) prev2 = cur2;
      const loadPrev = this.lastGetLoadSensor;

      const rpm1 = this.rpmCalc1.calculate(getEncoder1, packetTimestamp);
      const rpm2 = this.rpmCalc2.calculate(getEncoder2, packetTimestamp);

      this.lastGetEncoder1 = getEncoder1;
      this.lastGetEncoder2 = getEncoder2;
      this.lastGetLoadSensor = getLoadSensor;

      // Live values even while idle (for readouts before Start)
      const liveTorqL = this.lastCrankMassLeft * torqueFactor;
      const liveTorqR = this.lastCrankMassRight * torqueFactor;
      const liveLoadTorq = polyval(cal.loadCoef, getLoadSensor) - cal.tarLoad;
      const k = 2.0 * Math.PI / 60.0;
      const live = {
        time: curTime,
        cadenceRpm: rpm1, wheelRpm: rpm2,
        torqueLeft: liveTorqL, torqueRight: liveTorqR, loadTorque: liveLoadTorq,
        powerLeft: liveTorqL * rpm1 * k, powerRight: liveTorqR * rpm1 * k,
        powerLoad: liveLoadTorq * rpm2 * k,
        speedKmh: this.speedKmh(rpm2),
      };
      live.powerTotal = live.powerLeft + live.powerRight;

      live.angle = this.computeAngle(cur1);

      if (!this.recording) {
        if (this.onLive) this.onLive(live, null);
        return;
      }
      if (this.startOrigin === null) this.startOrigin = delTime[0];

      // --- recorded samples: the 4 real hardware samples of this packet ---
      const t = delTime.map((x) => x - this.startOrigin);
      const t0 = t[0], t3 = t[3];
      const samples = [];
      let zeroIndex = -1;
      const enc1 = [], enc2 = [], load = [];
      for (let i = 0; i < 4; i++) {
        if (t3 !== t0) {
          enc1.push(interp2(t[i], t0, t3, prev1, cur1));
          enc2.push(interp2(t[i], t0, t3, prev2, cur2));
          load.push(interp2(t[i], t0, t3, loadPrev, getLoadSensor));
        } else {
          enc1.push(getEncoder1); enc2.push(cur2); load.push(getLoadSensor);
        }
        if (zeroIndex < 0 && t[i] >= 0.0) zeroIndex = i;
      }
      if (zeroIndex < 0) {
        if (this.onLive) this.onLive(live, null);
        return;
      }
      if (this.zeroPending) {
        this.zeroAngleDeg = this.computeAngle(enc1[zeroIndex]);
        this.zeroPending = false;
      }
      const tr = this.trial;
      for (let i = 0; i < 4; i++) {
        if (!(t[i] >= 0.0)) continue;
        const tqR = (polyval(cal.rightCoef, weight1[i]) - cal.tarRight) * torqueFactor;
        const tqL = (polyval(cal.leftCoef, weight2[i]) - cal.tarLeft) * torqueFactor;
        const loadTq = polyval(cal.loadCoef, load[i]) - cal.tarLoad;
        const angle = this.computeAngle(enc1[i]);
        const pL = tqL * rpm1 * k;
        const pR = tqR * rpm1 * k;
        samples.push({
          t: t[i], angle,
          torqueLeft: tqL, torqueRight: tqR, loadTorque: loadTq,
          cadenceRpm: rpm1, wheelRpm: rpm2, speedKmh: this.speedKmh(rpm2),
          powerLeft: pL, powerRight: pR, powerTotal: pL + pR,
          powerLoad: loadTq * rpm2 * k,
          front: tr.front, rear: tr.rear,
          gearRatio: tr.front / tr.rear,
          wheelCircumferenceM: tr.wheelCircumferenceM,
        });
      }
      if (this.onLive) this.onLive(live, samples);
      if (this.onSamples) this.onSamples(samples);
    }

    // Riding-load command, same as the PC: poly(powderCoef)(Nm), clip 0..999, int()
    torqueCommand(ridingLoadNm) {
      let v = polyval(this.cal.powderCoef, +ridingLoadNm);
      if (!Number.isFinite(v)) v = 0;
      if (v < 0) v = 0; else if (v > 999) v = 999;
      return "TQ>" + Math.trunc(v) + ";\n";
    }
  }

  function csvRow(s) {
    let a = pymod(s.angle, 360.0);
    if (a >= 359.9999995) a = 0.0;
    return [
      s.t.toFixed(9), a.toFixed(6),
      s.torqueLeft.toFixed(9), s.torqueRight.toFixed(9),
      s.cadenceRpm.toFixed(6), s.wheelRpm.toFixed(6), s.speedKmh.toFixed(6),
      s.powerLeft.toFixed(6), s.powerRight.toFixed(6),
      s.powerTotal.toFixed(6), s.powerLoad.toFixed(6),
      String(s.front), String(s.rear),
      s.gearRatio.toFixed(6), s.wheelCircumferenceM.toFixed(4),
    ].join(",");
  }

  const api = {
    CpmEngine, FrameParser, RPMCalculator,
    parseSettingsIni, calibrationFromSettings, csvRow, CSV_HEADER,
    polyval, pymod, DEFAULT_CASSETTE_TEETH, FRAME_SIZE, PACKET_SIZE,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CPM = api;
})(typeof self !== "undefined" ? self : this);
