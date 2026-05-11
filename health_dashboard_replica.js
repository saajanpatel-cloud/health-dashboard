const DATA_URL = "health_data_replica_daily.csv";
const REFRESH_ENDPOINT = "/api/refresh";

/** Set by WKUserScript at document start when embedded in the iOS app. */
function isIosAppHost() {
  return typeof window.__HEALTH_DASH_IOS__ !== "undefined" && window.__HEALTH_DASH_IOS__ === true
    && typeof window.webkit !== "undefined"
    && window.webkit.messageHandlers
    && window.webkit.messageHandlers.healthDashboardBridge;
}

function postToIosBridge(action) {
  try {
    window.webkit.messageHandlers.healthDashboardBridge.postMessage(action);
  } catch (e) {
    setStatus(`Native bridge error: ${e.message}`);
  }
}

/** Called from native iOS (base64 UTF-8 CSV). */
window.__applyDashboardCsvFromBase64 = function applyDashboardCsvFromBase64(b64) {
  try {
    const text = atob(b64);
    dailyRows = filterLastYear(parseCsv(text));
    render();
    setStatus(`Loaded ${fmt0(dailyRows.length)} days from Apple Health`);
  } catch (err) {
    setStatus(`Load failed: ${err.message}`);
  }
};
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_YEAR_DAYS = 365;
const SIX_MONTH_DAYS = 183;
const KCAL_PER_KG_RULE = 7700;
/** Prefill: prefer kcal days in this many calendar days ending at latest export (needs ≥5 days). */
const MAINTENANCE_PREFILL_RECENT_DAYS = 14;
/** Fallback window if not enough days in the recent window (needs ≥7 days). */
const MAINTENANCE_PREFILL_DAYS = 28;
const RESTING_HR_MIN_DAYS = 28;
const RESTING_HR_MIN_FRACTION = 0.12;
/** Muscle / fat loss presets shift daily kcal vs maintenance (or vs current macro total if no maintenance). */
const MACRO_PRESET_KCAL_DELTA = 250;
/** Single footer for all goal-summary blocks (wording kept in one place). */
const TARGETS_ACHIEV_FOOTER = "Heuristic only: modest weekly targets are graded mainly on feasibility; steeper targets weigh your recent trend more. ≈7700 kcal/kg links weight pace to kcal vs maintenance. Outlook may read Tight instead of Likely if recent steps fall short of your steps target. Not medical advice.";

const defaultTargets = {
  minProtein: 110,
  carbsTarget: 110,
  minFats: 37,
  proPct: 36,
  carbPct: 36,
  fatPct: 27,
  stepsAvgTarget: 10000,
  weightGoal: "",
  bodyFatGoal: "",
  goalWeeks: 12,
  maintenanceKcal: "",
};

const defaultPrefs = {
  weightUnit: "kg",
  energyUnit: "kcal",
  trendMode: "raw",
  activeTab: "overview",
};

const numFmt0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const numFmt1 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateCellFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short" });
const weekFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "2-digit" });

let dailyRows = [];
let targets = { ...defaultTargets, ...loadJson("replica_targets", {}) };
let prefs = { ...defaultPrefs, ...loadJson("replica_prefs", {}) };
let showRestingHrColumn = false;

const el = {
  refreshBtn: document.getElementById("refreshBtn"),
  refreshStatus: document.getElementById("refreshStatus"),
  weeklyTableBody: document.getElementById("weeklyTableBody"),
  lastSixWeeksTableBody: document.getElementById("lastSixWeeksTableBody"),
  sixMonthTableBody: document.getElementById("sixMonthTableBody"),
  sixMonthHeadRow: document.getElementById("sixMonthHeadRow"),
  lastSixWeeksHeadRow: document.getElementById("lastSixWeeksHeadRow"),
  sixMonthCommentary: document.getElementById("sixMonthCommentary"),
  saveTargetsBtn: document.getElementById("saveTargetsBtn"),
  exportBtn: document.getElementById("exportBtn"),
  conflictBanner: document.getElementById("conflictBanner"),
  achievabilityText: document.getElementById("achievabilityText"),
  weightUnit: document.getElementById("weightUnit"),
  energyUnit: document.getElementById("energyUnit"),
  trendMode: document.getElementById("trendMode"),
  kcalTarget: document.getElementById("kcalTarget"),
  totalPct: document.getElementById("totalPct"),
  tabBtnOverview: document.getElementById("tabBtnOverview"),
  tabBtnTargets: document.getElementById("tabBtnTargets"),
  tabBtnInvestment: document.getElementById("tabBtnInvestment"),
  tabPanelOverview: document.getElementById("tabPanelOverview"),
  tabPanelTargets: document.getElementById("tabPanelTargets"),
  tabPanelInvestment: document.getElementById("tabPanelInvestment"),
  maintenanceKcal: document.getElementById("maintenanceKcal"),
  prefillMaintenanceBtn: document.getElementById("prefillMaintenanceBtn"),
  applyMuscleMacroBtn: document.getElementById("applyMuscleMacroBtn"),
  applyFatLossMacroBtn: document.getElementById("applyFatLossMacroBtn"),
};

Object.keys(defaultTargets).forEach((key) => { el[key] = document.getElementById(key); });

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function setStatus(message) {
  el.refreshStatus.textContent = message;
}

function parseNumField(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parsed target field: empty storage → NaN (avoids Number('') === 0). */
function numTarget(raw) {
  if (raw === "" || raw === undefined || raw === null) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** Most recent calendar week in `weekly` with a usable value for achievability. */
function latestFiniteWeekMetric(weekly, key) {
  for (let i = 0; i < weekly.length; i++) {
    const w = weekly[i];
    const v = w[key];
    if (key === "bodyFatAvg") {
      if (Number.isFinite(v) && v > 0 && v < 100) return { value: v, weekKey: w.weekKey, weeksAgo: i };
    } else if (key === "wAvg") {
      if (Number.isFinite(v) && v > 0) return { value: v, weekKey: w.weekKey, weeksAgo: i };
    }
  }
  return null;
}

function parseCsv(text) {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return {
      date: row.date,
      weightKg: parseNumField(row.weightKg),
      steps: parseNumField(row.steps),
      proteinG: parseNumField(row.proteinG),
      kcal: parseNumField(row.kcal),
      bodyFatPct: parseNumField(row.bodyFatPct),
      leanMassKg: parseNumField(row.leanMassKg),
      trainingDay: row.trainingDay === "TRUE",
      restingHr: headers.includes("restingHr") ? parseNumField(row.restingHr) : null,
    };
  }).filter((r) => !Number.isNaN(new Date(r.date).getTime()));
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function filterLastYear(rows) {
  if (!rows.length) return rows;
  const latest = new Date(rows[rows.length - 1].date).getTime();
  const minTime = latest - (ONE_YEAR_DAYS * ONE_DAY_MS);
  return rows.filter((r) => new Date(r.date).getTime() >= minTime);
}

function averagePositiveMassKg(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function averageBodyFatPct(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0 && v < 100);
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function averageProteinLogged(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function averageKcalLogged(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function averageRestingHr(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 30 && v < 220);
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function sum(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((a, v) => a + v, 0) : null;
}

function smoothRows(rows, field, window, isValid) {
  const out = rows.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    const vals = [];
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = out[j][field];
      if (isValid(v)) vals.push(v);
    }
    if (vals.length) out[i][field] = vals.reduce((a, v) => a + v, 0) / vals.length;
  }
  return out;
}

function maybeSmoothedRows(rows) {
  if (prefs.trendMode !== "smooth") return rows;
  let next = smoothRows(rows, "weightKg", 7, (v) => Number.isFinite(v) && v > 0);
  next = smoothRows(next, "bodyFatPct", 7, (v) => Number.isFinite(v) && v > 0 && v < 100);
  return next;
}

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || Math.abs(previous) < Number.EPSILON) return null;
  return ((current - previous) / previous) * 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function weekStart(dateStr) {
  const d = new Date(dateStr);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function groupByWeek(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = weekStart(row.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function metricGateLastSixMonths(rows, field, valueOk) {
  if (!rows.length) return false;
  const latest = new Date(rows[rows.length - 1].date).getTime();
  const minT = latest - (SIX_MONTH_DAYS * ONE_DAY_MS);
  const inWin = rows.filter((r) => {
    const t = new Date(r.date).getTime();
    return t >= minT && t <= latest;
  });
  if (!inWin.length) return false;
  const withData = inWin.filter((r) => valueOk(r[field])).length;
  return withData >= RESTING_HR_MIN_DAYS && withData >= inWin.length * RESTING_HR_MIN_FRACTION;
}

function kgToDisplay(kg) {
  if (!Number.isFinite(kg)) return null;
  return prefs.weightUnit === "lb" ? kg * 2.20462262 : kg;
}

function kcalToDisplay(kcal) {
  if (!Number.isFinite(kcal)) return null;
  return prefs.energyUnit === "kj" ? kcal * 4.184 : kcal;
}

function displayWeightLabel() {
  return prefs.weightUnit;
}

function displayEnergyLabel() {
  return prefs.energyUnit === "kj" ? "kJ" : "kcal";
}

function fmt0(v) {
  return Number.isFinite(v) ? numFmt0.format(v) : "-";
}

function fmt1(v) {
  return Number.isFinite(v) ? numFmt1.format(v) : "-";
}

function formatDateCell(isoDate) {
  const d = new Date(isoDate);
  return Number.isNaN(d.getTime()) ? isoDate : dateCellFmt.format(d);
}

function formatWeekDate(isoDate) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  return weekFmt.format(d).replace(/\s/g, "-");
}

function computeDerivedTargets() {
  const minProtein = Number(targets.minProtein || 0);
  const carbsTarget = Number(targets.carbsTarget || 0);
  const minFats = Number(targets.minFats || 0);
  const proPct = Number(targets.proPct || 0);
  const carbPct = Number(targets.carbPct || 0);
  const fatPct = Number(targets.fatPct || 0);
  return {
    kcalTarget: (4 * minProtein) + (4 * carbsTarget) + (9 * minFats),
    totalPct: proPct + carbPct + fatPct,
  };
}

/** Last few weeks' implied daily steps vs stepsAvgTarget (for achievability). */
function recentStepsContext(weekly) {
  const stepTarget = Number(targets.stepsAvgTarget);
  const weeks = weekly.slice(0, 6);
  const dailyAvgs = [];
  weeks.forEach((w) => {
    if (Number.isFinite(w.stepsTotal) && w.stepsTotal >= 0) dailyAvgs.push(w.stepsTotal / 7);
  });
  if (!dailyAvgs.length || !Number.isFinite(stepTarget) || stepTarget <= 0) {
    return { ratio: null, avgDaily: null, stepTarget };
  }
  const avgDaily = dailyAvgs.reduce((a, b) => a + b, 0) / dailyAvgs.length;
  return { ratio: avgDaily / stepTarget, avgDaily, stepTarget };
}

function adjustOutlookForSteps(baseStatus, ctx) {
  const { ratio } = ctx;
  if (ratio == null || !Number.isFinite(ratio)) return baseStatus;
  if (ratio < 0.65 && baseStatus === "Likely") return "Tight";
  if (ratio < 0.82 && baseStatus === "Likely") return "Tight";
  return baseStatus;
}

/** BF % change per calendar week between newest and oldest logged week in the first `maxWeeks` weeks (newest first). */
function trendPerWeekInWindow(weekly, field, maxWeeks = 8) {
  const slice = weekly.slice(0, maxWeeks);
  let firstI = -1;
  let firstV = null;
  let lastI = -1;
  let lastV = null;
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i][field];
    const ok = field === "bodyFatAvg"
      ? Number.isFinite(v) && v > 0 && v < 100
      : Number.isFinite(v) && v > 0;
    if (!ok) continue;
    if (firstI === -1) {
      firstI = i;
      firstV = v;
    }
    lastI = i;
    lastV = v;
  }
  if (firstI === -1 || lastI === firstI) return null;
  const span = lastI - firstI;
  return (firstV - lastV) / span;
}

function outlookBfPctPerWeek(requiredDelta, observedDelta) {
  if (!Number.isFinite(requiredDelta)) return "Tight";
  const absReq = Math.abs(requiredDelta);
  if (absReq < 0.16) {
    if (!Number.isFinite(observedDelta)) return "Likely";
    if (requiredDelta < 0 && observedDelta > 0.05) return "Unlikely";
    if (requiredDelta > 0 && observedDelta < -0.05) return "Unlikely";
    return "Likely";
  }
  if (!Number.isFinite(observedDelta)) return absReq < 0.22 ? "Likely" : "Tight";
  const gap = observedDelta - requiredDelta;
  const band = Math.max(0.12, absReq * 0.55);
  if (Math.abs(gap) <= band) return "Likely";
  if (requiredDelta < 0 && observedDelta > requiredDelta + band) return "Unlikely";
  if (requiredDelta > 0 && observedDelta < requiredDelta - band) return "Unlikely";
  return "Tight";
}

function outlookWeightKgPerWeek(wReq, wObs) {
  if (!Number.isFinite(wReq) || Math.abs(wReq) < 1e-9) return "Tight";
  const absReq = Math.abs(wReq);
  if (absReq <= 0.42) {
    if (!Number.isFinite(wObs)) return "Likely";
    if (wReq < 0 && wObs > 0.07) return "Unlikely";
    if (wReq > 0 && wObs < -0.07) return "Unlikely";
    return "Likely";
  }
  if (absReq <= 0.7) {
    if (!Number.isFinite(wObs)) return "Tight";
    const sameSign = Math.sign(wObs) === Math.sign(wReq) || Math.abs(wObs) < 0.03;
    const paceOk = Math.abs(wObs) >= absReq * 0.35;
    if (sameSign && paceOk) return "Likely";
    if (!sameSign && Math.abs(wObs) > 0.06) return "Unlikely";
    return "Tight";
  }
  if (!Number.isFinite(wObs)) return "Tight";
  const sameSign = Math.sign(wObs) === Math.sign(wReq) || Math.abs(wObs) < 0.02;
  const paceOk = Math.abs(wObs) >= absReq * 0.45;
  if (sameSign && paceOk) return "Likely";
  if (!sameSign && Math.abs(wObs) > 0.04) return "Unlikely";
  return "Tight";
}

function detectGoalConflicts({
  bfCurrent, bfGoal, bfGoalActive, wCurrent, wGoal, wGoalActive, goalWeeks,
}) {
  const lines = [];
  const wk = fmt0(goalWeeks);

  if (bfGoalActive && wGoalActive && Number.isFinite(bfCurrent) && Number.isFinite(bfGoal)
    && Number.isFinite(wCurrent) && Number.isFinite(wGoal)) {
    const dWkg = wGoal - wCurrent;
    const loseBfPct = bfCurrent - bfGoal;

    if (dWkg > 0.25 && loseBfPct > 0.6) {
      lines.push(
        `<p><strong>Recomposition tension:</strong> Goals aim for <strong>higher weight</strong> (~${fmt1(kgToDisplay(dWkg))} ${displayWeightLabel()}) and <strong>lower body fat</strong> (~${fmt1(loseBfPct)}%) in the same <strong>${wk}</strong>-week window. Pushing both hard at once is usually unrealistic — try a longer timeline, alternating phases, or prioritise one outcome first.</p>`,
      );
    }
    if (dWkg < -0.25 && bfGoal > bfCurrent + 0.4) {
      lines.push(
        `<p><strong>Conflicting direction:</strong> You are targeting <strong>weight loss</strong> but a <strong>higher body fat %</strong> than now. That can happen with muscle loss; if both are intentional, confirm the numbers reflect what you want.</p>`,
      );
    }
  }

  if (bfGoalActive && Number.isFinite(bfCurrent) && Number.isFinite(bfGoal) && goalWeeks >= 1) {
    const reqAbs = Math.abs((bfGoal - bfCurrent) / goalWeeks);
    if (reqAbs > 0.22) {
      lines.push(
        `<p><strong>Very steep body-fat pace:</strong> About <strong>${fmt1((bfGoal - bfCurrent) / goalWeeks)}%</strong> body fat per week on average — outlook below will lean cautious.</p>`,
      );
    }
  }
  if (wGoalActive && Number.isFinite(wCurrent) && Number.isFinite(wGoal) && goalWeeks >= 1) {
    const rwAbs = Math.abs((wGoal - wCurrent) / goalWeeks);
    if (rwAbs > 0.85) {
      lines.push(
        `<p><strong>Very steep weight pace:</strong> About <strong>${fmt1(kgToDisplay((wGoal - wCurrent) / goalWeeks))} ${displayWeightLabel()}</strong> per week on average — outlook below will lean cautious.</p>`,
      );
    }
  }

  return lines;
}

/**
 * Daily kcal anchor for macro grams: preset mode uses maintenance ±250 (or current macro kcal ±250);
 * otherwise maintenance ± implied weight-pace kcal, or maintenance alone.
 * `macroEnergyMode` is "muscle" | "fat" | "" (not in defaultTargets — persisted, not bound to an input).
 */
/** Returns true if macro grams were updated from an anchor kcal. */
function syncNutritionGramsFromTargets() {
  const proPct = Number(targets.proPct);
  const carbPct = Number(targets.carbPct);
  const fatPct = Number(targets.fatPct);
  if (![proPct, carbPct, fatPct].every((n) => Number.isFinite(n))) return false;
  const sum = proPct + carbPct + fatPct;
  if (sum < 97 || sum > 103) return false;

  const mode = targets.macroEnergyMode || "";
  const maintenance = Number(targets.maintenanceKcal);
  const bump = mode === "muscle" ? MACRO_PRESET_KCAL_DELTA : mode === "fat" ? -MACRO_PRESET_KCAL_DELTA : 0;

  let anchorKcal = null;

  if (mode === "muscle" || mode === "fat") {
    if (Number.isFinite(maintenance) && maintenance > 500) {
      anchorKcal = maintenance + bump;
    } else {
      const d = computeDerivedTargets();
      if (Number.isFinite(d.kcalTarget) && d.kcalTarget > 400) anchorKcal = d.kcalTarget + bump;
    }
  } else {
    const wGoal = numTarget(targets.weightGoal);
    const goalWeeks = Math.max(1, Number(targets.goalWeeks || 12));
    if (Number.isFinite(maintenance) && maintenance > 500) {
      if (dailyRows.length) {
        const weekly = buildWeeklySummaries(maybeSmoothedRows(dailyRows));
        const wSnap = latestFiniteWeekMetric(weekly, "wAvg");
        const wCurrent = wSnap?.value;
        if (Number.isFinite(wCurrent) && Number.isFinite(wGoal)) {
          const deltaKgPerWeek = (wGoal - wCurrent) / goalWeeks;
          anchorKcal = maintenance + (deltaKgPerWeek * KCAL_PER_KG_RULE) / 7;
        } else {
          anchorKcal = maintenance;
        }
      } else {
        anchorKcal = maintenance;
      }
    }
  }

  if (!Number.isFinite(anchorKcal) || anchorKcal < 900) return false;

  targets.minProtein = Math.round((anchorKcal * proPct) / 100 / 4);
  targets.carbsTarget = Math.round((anchorKcal * carbPct) / 100 / 4);
  targets.minFats = Math.max(25, Math.round((anchorKcal * fatPct) / 100 / 9));
  saveJson("replica_targets", targets);
  ["minProtein", "carbsTarget", "minFats"].forEach((id) => {
    if (el[id]) el[id].value = String(targets[id]);
  });
  return true;
}

function updateComputedFields() {
  const d = computeDerivedTargets();
  el.kcalTarget.value = fmt0(kcalToDisplay(d.kcalTarget));
  el.totalPct.value = fmt0(d.totalPct);
}

function loadStateToUi() {
  Object.keys(defaultTargets).forEach((k) => {
    if (!el[k]) return;
    const v = targets[k];
    el[k].value = v === "" || v === undefined || v === null ? "" : String(v);
  });
  el.weightUnit.value = prefs.weightUnit;
  el.energyUnit.value = prefs.energyUnit;
  el.trendMode.value = prefs.trendMode;
  el.stepsAvgTarget.value = Number.isFinite(Number(el.stepsAvgTarget.value)) ? Math.round(Number(el.stepsAvgTarget.value)) : 10000;
  updateComputedFields();
}

function readTargets() {
  Object.keys(defaultTargets).forEach((k) => {
    const raw = el[k]?.value;
    targets[k] = raw === "" ? "" : Number(raw);
  });
  targets.stepsAvgTarget = Math.round(Number(targets.stepsAvgTarget || 0));
  saveJson("replica_targets", targets);
  updateComputedFields();
}

function readPrefs() {
  prefs.weightUnit = el.weightUnit.value;
  prefs.energyUnit = el.energyUnit.value;
  prefs.trendMode = el.trendMode.value;
  saveJson("replica_prefs", prefs);
  updateComputedFields();
}

function weightWowTrendGood(change, prevW, currW) {
  if (change == null || !Number.isFinite(prevW) || !Number.isFinite(currW)) return null;
  const goal = numTarget(targets.weightGoal);
  if (!Number.isFinite(goal)) return change <= 0;
  if (currW > goal) return currW < prevW;
  if (currW < goal) return currW > prevW;
  return true;
}

function bfWowTrendGood(change, prevB, currB) {
  if (change == null || !Number.isFinite(prevB) || !Number.isFinite(currB)) return null;
  const goal = numTarget(targets.bodyFatGoal);
  if (!Number.isFinite(goal)) return change <= 0;
  if (currB > goal) return currB < prevB;
  if (currB < goal) return currB > prevB;
  return true;
}

function wowClass(isGood) {
  if (isGood === null) return "metric-neutral";
  return isGood ? "metric-positive" : "metric-warning";
}

function goalBarHtml(pct) {
  const p = clamp(Math.round(pct), 0, 100);
  return `<div class="goal-bar" title="Progress vs goal"><div class="goal-bar-fill" style="width:${p}%"></div></div>`;
}

function goalBarHigherIsBetter(current, goal) {
  if (!Number.isFinite(current) || !Number.isFinite(goal) || goal <= 0) return "";
  if (current >= goal) return goalBarHtml(100);
  return goalBarHtml(100 * (current / goal));
}

function goalBarWeightKg(current, goal) {
  if (!Number.isFinite(current) || !Number.isFinite(goal)) return "";
  const tol = 0.35;
  if (Math.abs(current - goal) <= tol) return goalBarHtml(100);
  if (goal < current) {
    if (current <= goal) return goalBarHtml(100);
    const span = Math.max(4, Math.abs(current - goal) * 1.5);
    return goalBarHtml(100 * (1 - Math.min(1, (current - goal) / span)));
  }
  if (goal > current) {
    if (current >= goal) return goalBarHtml(100);
    const span = Math.max(4, (goal - current) * 1.5);
    return goalBarHtml(100 * (1 - Math.min(1, (goal - current) / span)));
  }
  return goalBarHtml(100);
}

function goalBarBodyFat(current, goal) {
  if (!Number.isFinite(current) || !Number.isFinite(goal)) return "";
  const tol = 0.5;
  if (Math.abs(current - goal) <= tol) return goalBarHtml(100);
  if (goal < current) {
    if (current <= goal) return goalBarHtml(100);
    const span = Math.max(3, (current - goal) * 1.5);
    return goalBarHtml(100 * (1 - Math.min(1, (current - goal) / span)));
  }
  if (goal > current) {
    if (current >= goal) return goalBarHtml(100);
    const span = Math.max(3, (goal - current) * 1.5);
    return goalBarHtml(100 * (1 - Math.min(1, (goal - current) / span)));
  }
  return goalBarHtml(100);
}

function goalSubWeight(avgKg) {
  const g = numTarget(targets.weightGoal);
  if (!Number.isFinite(avgKg) || !Number.isFinite(g)) return "";
  const cls = Math.abs(avgKg - g) < 0.35 ? "metric-goal-good" : "metric-goal-warn";
  return `<div class="${cls} goal-sub">Goal ${fmt1(kgToDisplay(g))} ${displayWeightLabel()}</div>${goalBarWeightKg(avgKg, g)}`;
}

function goalSubBf(avgBf) {
  const g = numTarget(targets.bodyFatGoal);
  if (!Number.isFinite(avgBf) || !Number.isFinite(g)) return "";
  const cls = Math.abs(avgBf - g) < 0.5 ? "metric-goal-good" : "metric-goal-warn";
  return `<div class="${cls} goal-sub">Goal ${fmt1(g)}%</div>${goalBarBodyFat(avgBf, g)}`;
}

function goalSubSteps(avgWeekSteps) {
  const daily = Number(targets.stepsAvgTarget);
  if (!Number.isFinite(avgWeekSteps) || !Number.isFinite(daily) || daily <= 0) return "";
  const goalWeek = daily * 7;
  const cls = avgWeekSteps >= goalWeek * 0.95 ? "metric-goal-good" : "metric-goal-warn";
  return `<div class="${cls} goal-sub">Target ${fmt0(goalWeek)}/wk</div>${goalBarHigherIsBetter(avgWeekSteps, goalWeek)}`;
}

function goalSubProtein(avgProtein) {
  const minP = Number(targets.minProtein);
  if (!Number.isFinite(avgProtein) || !Number.isFinite(minP) || minP <= 0) return "";
  const cls = avgProtein >= minP ? "metric-goal-good" : "metric-goal-warn";
  return `<div class="${cls} goal-sub">Min ${fmt0(minP)} g/d</div>${goalBarHigherIsBetter(avgProtein, minP)}`;
}

function buildWeeklySummaries(rows) {
  const d = computeDerivedTargets();
  const stepTargetWeek = Number(targets.stepsAvgTarget || 0) * 7;
  return groupByWeek(rows).map(([weekKey, weekRows]) => {
    const wAvg = averagePositiveMassKg(weekRows.map((r) => r.weightKg));
    const leanAvg = averagePositiveMassKg(weekRows.map((r) => r.leanMassKg));
    const bodyFatAvg = averageBodyFatPct(weekRows.map((r) => r.bodyFatPct));
    const kcalAvg = averageKcalLogged(weekRows.map((r) => r.kcal));
    const proteinAvg = averageProteinLogged(weekRows.map((r) => r.proteinG));
    const stepsTotal = sum(weekRows.map((r) => r.steps));
    const kcalWeekSum = sum(weekRows.map((r) => r.kcal));
    const trainingDays = weekRows.filter((r) => r.trainingDay).length;
    const restingHrAvg = averageRestingHr(weekRows.map((r) => r.restingHr));
    const completenessRatio = [wAvg, bodyFatAvg, proteinAvg, kcalAvg, stepsTotal].filter((v) => Number.isFinite(v)).length / 5;

    return {
      weekKey,
      rows: weekRows,
      wAvg,
      leanAvg,
      bodyFatAvg,
      kcalAvg,
      kcalWeekSum,
      proteinAvg,
      stepsTotal,
      trainingDays,
      restingHrAvg,
      completenessRatio,
    };
  });
}

function completenessBadge(ratio) {
  const completenessClass = !Number.isFinite(ratio) ? "badge-low"
    : ratio >= 0.8 ? "badge-good"
    : ratio >= 0.5 ? "badge-amber"
    : "badge-low";
  const completenessText = !Number.isFinite(ratio) ? "Low"
    : ratio >= 0.8 ? "Good"
    : ratio >= 0.5 ? "Fair"
    : "Low";
  return `<span class="badge ${completenessClass}">${completenessText}</span>`;
}

function syncAggregateRestingColumns(show) {
  document.getElementById("sixMonthThResting")?.remove();
  document.getElementById("lastSixThResting")?.remove();
  if (!show) return;
  const label = "Avg Resting HR <span class=\"th-sub\">(week avg)</span>";
  const th1 = document.createElement("th");
  th1.id = "sixMonthThResting";
  th1.className = "col-resting";
  th1.innerHTML = label;
  el.sixMonthHeadRow.appendChild(th1);
  const th2 = document.createElement("th");
  th2.id = "lastSixThResting";
  th2.className = "col-resting";
  th2.innerHTML = label;
  el.lastSixWeeksHeadRow?.appendChild(th2);
}

function renderSixMonthMonthly(weekly) {
  el.sixMonthTableBody.innerHTML = "";
  if (!weekly.length) {
    el.sixMonthCommentary.textContent = "No data available for monthly aggregation.";
    return;
  }
  const latestTs = new Date(weekly[0].weekKey).getTime();
  const minTs = latestTs - (SIX_MONTH_DAYS * ONE_DAY_MS);
  const recentWeeks = weekly.filter((w) => new Date(w.weekKey).getTime() >= minTs);

  const monthMap = new Map();
  recentWeeks.forEach((w) => {
    const d = new Date(w.weekKey);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthMap.has(key)) monthMap.set(key, []);
    monthMap.get(key).push(w);
  });

  const monthRows = [...monthMap.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, arr]) => ({
    key,
    avgWeight: average(arr.map((w) => w.wAvg)),
    avgBodyFat: average(arr.map((w) => w.bodyFatAvg)),
    avgSteps: average(arr.map((w) => w.stepsTotal)),
    avgProtein: average(arr.map((w) => w.proteinAvg)),
    avgKcal: average(arr.map((w) => w.kcalAvg)),
    avgCompleteness: average(arr.map((w) => w.completenessRatio)),
    avgWeeklyTrainingDays: average(arr.map((w) => w.trainingDays)),
    avgRestingHr: showRestingHrColumn ? average(arr.map((w) => w.restingHrAvg)) : null,
  }));

  monthRows.forEach((m) => {
    const [year, month] = m.key.split("-").map(Number);
    const monthDate = new Date(year, month - 1, 1);
    const monthLabel = monthDate.toLocaleString("en-GB", { month: "short", year: "2-digit" }).replace(" ", "-");
    const restingCell = showRestingHrColumn
      ? `<td>${Number.isFinite(m.avgRestingHr) ? `${fmt0(m.avgRestingHr)} bpm` : "-"}</td>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${monthLabel}</td>
      <td class="cell-goal-wrap">${fmt1(kgToDisplay(m.avgWeight))} ${displayWeightLabel()}${goalSubWeight(m.avgWeight)}</td>
      <td class="cell-goal-wrap">${fmt1(m.avgBodyFat)}%${goalSubBf(m.avgBodyFat)}</td>
      <td class="cell-goal-wrap">${fmt0(m.avgSteps)}${goalSubSteps(m.avgSteps)}</td>
      <td class="cell-goal-wrap">${fmt0(m.avgProtein)} g${goalSubProtein(m.avgProtein)}</td>
      <td>${fmt0(kcalToDisplay(m.avgKcal))}</td>
      <td>${completenessBadge(m.avgCompleteness)}</td>
      <td>${fmt1(m.avgWeeklyTrainingDays)}</td>
      ${restingCell}
    `;
    el.sixMonthTableBody.appendChild(tr);
  });

  const avgTraining = average(monthRows.map((m) => m.avgWeeklyTrainingDays));
  const avgWeight = average(monthRows.map((m) => m.avgWeight));
  el.sixMonthCommentary.textContent = `Last ${fmt0(monthRows.length)} months summary: average weight ${fmt1(kgToDisplay(avgWeight))} ${displayWeightLabel()}, average weekly training days ${fmt1(avgTraining)}.`;
}

function renderLastSixWeeks(weekly) {
  if (!el.lastSixWeeksTableBody) return;
  el.lastSixWeeksTableBody.innerHTML = "";
  weekly.slice(0, 6).forEach((w) => {
    const restingCell = showRestingHrColumn
      ? `<td>${Number.isFinite(w.restingHrAvg) ? `${fmt0(w.restingHrAvg)} bpm` : "-"}</td>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatWeekDate(w.weekKey)}</td>
      <td class="cell-goal-wrap">${fmt1(kgToDisplay(w.wAvg))} ${displayWeightLabel()}${goalSubWeight(w.wAvg)}</td>
      <td class="cell-goal-wrap">${fmt1(w.bodyFatAvg)}%${goalSubBf(w.bodyFatAvg)}</td>
      <td class="cell-goal-wrap">${fmt0(w.stepsTotal)}${goalSubSteps(w.stepsTotal)}</td>
      <td class="cell-goal-wrap">${fmt0(w.proteinAvg)} g${goalSubProtein(w.proteinAvg)}</td>
      <td>${fmt0(kcalToDisplay(w.kcalAvg))}</td>
      <td>${completenessBadge(w.completenessRatio)}</td>
      <td>${fmt0(w.trainingDays)}</td>
      ${restingCell}
    `;
    el.lastSixWeeksTableBody.appendChild(tr);
  });
}

function prefillMaintenanceFromLogs() {
  if (!dailyRows.length) return;
  const latestRow = dailyRows[dailyRows.length - 1];
  const latest = new Date(latestRow.date).getTime();
  const latestIso = latestRow.date;

  function kcalDaysInLast(daysBack) {
    const minT = latest - daysBack * ONE_DAY_MS;
    return dailyRows
      .filter((r) => {
        const t = new Date(r.date).getTime();
        return t >= minT && Number.isFinite(r.kcal) && r.kcal > 0;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  let slice = kcalDaysInLast(MAINTENANCE_PREFILL_RECENT_DAYS);
  let windowPhrase = `the ${MAINTENANCE_PREFILL_RECENT_DAYS} calendar days before your latest export`;
  let minDays = 5;

  if (slice.length < minDays) {
    slice = kcalDaysInLast(MAINTENANCE_PREFILL_DAYS);
    windowPhrase = `the ${MAINTENANCE_PREFILL_DAYS} calendar days before your latest export`;
    minDays = 7;
  }
  if (slice.length < minDays) {
    setStatus(
      `Prefill needs at least ${minDays} days with dietary kcal logged in the chosen window (latest export date: ${latestIso}).`,
    );
    return;
  }

  const avg = slice.reduce((a, r) => a + r.kcal, 0) / slice.length;
  targets.maintenanceKcal = Math.round(avg);
  el.maintenanceKcal.value = String(targets.maintenanceKcal);
  saveJson("replica_targets", targets);
  syncNutritionGramsFromTargets();
  loadStateToUi();
  const fromD = slice[0].date;
  const toD = slice[slice.length - 1].date;
  setStatus(
    `Prefilled maintenance: ~${fmt0(kcalToDisplay(avg))} ${displayEnergyLabel()}/day from ${fmt0(slice.length)} logged days (${fromD} → ${toD}) in ${windowPhrase}; latest export ${latestIso}.`,
  );
  render();
}

function renderAchievability(weekly) {
  const bfSnap = latestFiniteWeekMetric(weekly, "bodyFatAvg");
  const bfCurrent = bfSnap?.value;
  const bfGoal = numTarget(targets.bodyFatGoal);
  const bfGoalActive = Number.isFinite(bfGoal);

  const wSnap = latestFiniteWeekMetric(weekly, "wAvg");
  const wCurrent = wSnap?.value;
  const wGoal = numTarget(targets.weightGoal);
  const wGoalActive = Number.isFinite(wGoal);

  const goalWeeks = Math.max(1, Number(targets.goalWeeks || 12));
  const maintenance = Number(targets.maintenanceKcal);
  const observedBfPerWeek = trendPerWeekInWindow(weekly, "bodyFatAvg", 8);
  const observedWtPerWeek = trendPerWeekInWindow(weekly, "wAvg", 8);

  const stepsCtx = recentStepsContext(weekly);
  const blocks = [];

  const conflictLines = detectGoalConflicts({
    bfCurrent, bfGoal, bfGoalActive, wCurrent, wGoal, wGoalActive, goalWeeks,
  });
  if (conflictLines.length) {
    blocks.push(
      `<div class="achiev-block achiev-conflict">`
      + `<div class="achiev-h">Check your goals</div>`
      + conflictLines.join("")
      + `</div>`,
    );
  }

  if (stepsCtx.ratio != null && Number.isFinite(stepsCtx.avgDaily)) {
    const pct = Math.round(stepsCtx.ratio * 100);
    blocks.push(
      `<div class="achiev-block">`
      + `<div class="achiev-h">Steps</div>`
      + `<p><strong>Recent average:</strong> ${fmt0(stepsCtx.avgDaily)} steps/day (from your export). <strong>Your steps target:</strong> ${fmt0(stepsCtx.stepTarget)} steps/day (${pct}% of target). Used to temper outlook below.</p>`
      + `</div>`,
    );
  }

  if (bfGoalActive) {
    if (Number.isFinite(bfCurrent)) {
      const requiredDelta = (bfGoal - bfCurrent) / goalWeeks;
      const status = outlookBfPctPerWeek(requiredDelta, observedBfPerWeek);
      const bfOutlook = adjustOutlookForSteps(status, stepsCtx);
      const weekNote = bfSnap.weeksAgo > 0
        ? `<p class="achiev-meta"><strong>Source week:</strong> ${formatWeekDate(bfSnap.weekKey)} (most recent week in your export with body fat % logged).</p>`
        : "";
      blocks.push(
        `<div class="achiev-block">`
        + `<div class="achiev-h">Body fat goal</div>`
        + `<p><strong>Latest weekly average:</strong> ${fmt1(bfCurrent)}% body fat. <strong>Target:</strong> ${fmt1(bfGoal)}% in ${fmt0(goalWeeks)} weeks.</p>`
        + weekNote
        + `<p><strong>Implied pace:</strong> ${fmt1(requiredDelta)}% body fat per week. <strong>Recent trend:</strong> ${Number.isFinite(observedBfPerWeek) ? `${fmt1(observedBfPerWeek)}% / week` : "not enough weeks with BF% to estimate"}. <strong>Outlook:</strong> ${bfOutlook}.</p>`
        + `</div>`,
      );
    } else {
      blocks.push(
        `<div class="achiev-block">`
        + `<div class="achiev-h">Body fat goal</div>`
        + `<p><strong>Target:</strong> ${fmt1(bfGoal)}% in ${fmt0(goalWeeks)} weeks. <strong>No recent body fat %</strong> in your weekly export data — outlook cannot be estimated. Include body composition in your Apple Health export and refresh.</p>`
        + `</div>`,
      );
    }
  }

  if (wGoalActive && Number.isFinite(wCurrent)) {
    const wReq = (wGoal - wCurrent) / goalWeeks;
    const wStat = outlookWeightKgPerWeek(wReq, observedWtPerWeek);
    const wOutlook = adjustOutlookForSteps(wStat, stepsCtx);
    const deltaKgPerWeek = (wGoal - wCurrent) / goalWeeks;
    const kcalPerDayBalance = (deltaKgPerWeek * KCAL_PER_KG_RULE) / 7;
    const signWord = kcalPerDayBalance >= 0 ? "surplus" : "deficit";
    let kcalLines = `<p><strong>Implied average vs maintenance:</strong> ${fmt0(Math.abs(kcalPerDayBalance))} kcal/day ${signWord} (≈${KCAL_PER_KG_RULE} kcal/kg body-mass change ÷ 7 days).</p>`;
    if (Number.isFinite(maintenance) && maintenance > 0) {
      const suggestedKcal = maintenance + kcalPerDayBalance;
      kcalLines += `<p><strong>Maintenance</strong> (${displayEnergyLabel()}/day): ${fmt0(kcalToDisplay(maintenance))} → <strong>suggested intake:</strong> ${fmt0(kcalToDisplay(suggestedKcal))}.</p>`;
    } else {
      kcalLines += `<p>Enter <strong>maintenance</strong> (${displayEnergyLabel()}/day) above, or use <strong>Prefill from logs</strong>, to see suggested intake.</p>`;
    }
    const wWeekNote = wSnap.weeksAgo > 0
      ? `<p class="achiev-meta"><strong>Source week:</strong> ${formatWeekDate(wSnap.weekKey)} (most recent week in your export with weight logged).</p>`
      : "";
    blocks.push(
      `<div class="achiev-block">`
      + `<div class="achiev-h">Weight goal</div>`
      + `<p><strong>Latest weekly average:</strong> ${fmt1(kgToDisplay(wCurrent))} ${displayWeightLabel()}. <strong>Target:</strong> ${fmt1(kgToDisplay(wGoal))} ${displayWeightLabel()} in ${fmt0(goalWeeks)} weeks.</p>`
      + wWeekNote
      + `<p><strong>Implied change:</strong> ${fmt1(kgToDisplay(wReq))} ${displayWeightLabel()} per week. <strong>Recent trend:</strong> ${Number.isFinite(observedWtPerWeek) ? `${fmt1(kgToDisplay(observedWtPerWeek))} ${displayWeightLabel()} / week` : "not enough weeks with weight to estimate"}. <strong>Outlook:</strong> ${wOutlook}.</p>`
      + kcalLines
      + `</div>`,
    );
  }

  if (wGoalActive && !Number.isFinite(wCurrent)) {
    blocks.push(
      `<div class="achiev-block">`
      + `<div class="achiev-h">Weight goal</div>`
      + `<p><strong>Target:</strong> ${fmt1(kgToDisplay(wGoal))} ${displayWeightLabel()} in ${fmt0(goalWeeks)} weeks. <strong>No recent weight</strong> in your weekly export data — outlook cannot be estimated.</p>`
      + `</div>`,
    );
  }

  if (!blocks.length) {
    el.achievabilityText.innerHTML = "<p><strong>Goals summary</strong> — Set a <strong>weight goal</strong> and/or <strong>body fat % goal</strong>, plus <strong>weeks</strong>. Set <strong>steps average (per day)</strong> to include the steps line.</p>";
    return;
  }
  el.achievabilityText.innerHTML = blocks.join("") + `<p class="achiev-meta">${TARGETS_ACHIEV_FOOTER}</p>`;
}

function metaCell(text, rowSpan, extraClass = "") {
  const td = document.createElement("td");
  td.className = `week-cell ${extraClass}`.trim();
  td.rowSpan = rowSpan;
  td.textContent = text;
  return td;
}

function renderWeeklyTable(weekly) {
  el.weeklyTableBody.innerHTML = "";
  document.querySelectorAll("[data-resting-col]").forEach((node) => {
    node.classList.toggle("hidden", !showRestingHrColumn);
  });

  const d = computeDerivedTargets();
  const stepTargetWeek = Number(targets.stepsAvgTarget || 0) * 7;
  const kcalTargetWeek = d.kcalTarget * 7;

  weekly.forEach((w, idx) => {
    const prev = weekly[idx + 1];
    const changeW = percentChange(w.wAvg, prev?.wAvg);
    const changeBf = percentChange(w.bodyFatAvg, prev?.bodyFatAvg);
    const wGood = weightWowTrendGood(changeW, prev?.wAvg, w.wAvg);
    const bfGood = bfWowTrendGood(changeBf, prev?.bodyFatAvg, w.bodyFatAvg);
    const stepsRemaining = Number.isFinite(stepTargetWeek) && Number.isFinite(w.stepsTotal) ? stepTargetWeek - w.stepsTotal : null;
    const kcalRemaining = Number.isFinite(kcalTargetWeek) && Number.isFinite(w.kcalWeekSum)
      ? (kcalTargetWeek - w.kcalWeekSum)
      : null;

    const sortedRows = w.rows.slice().sort((a, b) => b.date.localeCompare(a.date));
    const rs = sortedRows.length;

    sortedRows.forEach((r, rowIdx) => {
      const tr = document.createElement("tr");
      if (rowIdx === 0) {
        tr.appendChild(metaCell(formatWeekDate(w.weekKey), rs));
        tr.appendChild(metaCell(changeW == null ? "—" : `${fmt1(changeW)}%`, rs, wowClass(wGood)));
        tr.appendChild(metaCell(changeBf == null ? "—" : `${fmt1(changeBf)}%`, rs, wowClass(bfGood)));
        tr.appendChild(metaCell(fmt0(stepsRemaining), rs, Number.isFinite(stepsRemaining) && stepsRemaining <= 0 ? "metric-positive" : "metric-warning"));
        tr.appendChild(metaCell(
          kcalRemaining == null || !Number.isFinite(kcalTargetWeek) ? "—" : fmt0(kcalToDisplay(kcalRemaining)),
          rs,
          Number.isFinite(kcalRemaining) && Math.abs(kcalRemaining) <= (kcalTargetWeek * 0.1) ? "metric-positive" : "metric-warning",
        ));
      }
      const training = r.trainingDay ? "Yes" : "No";
      const dayCells = document.createElement("template");
      dayCells.innerHTML = `
        <td class="date-cell">${formatDateCell(r.date)}</td>
        <td>${fmt1(kgToDisplay(r.weightKg))}</td>
        <td>${fmt0(r.steps)}</td>
        <td>${fmt0(r.proteinG)}</td>
        <td>${fmt0(kcalToDisplay(r.kcal))}</td>
        <td>${fmt1(r.bodyFatPct)}%</td>
        <td>${fmt1(kgToDisplay(r.leanMassKg))}</td>
        <td class="${r.trainingDay ? "training-yes" : "training-no"}">${training}</td>
      `.trim();
      tr.append(...dayCells.content.childNodes);
      if (rowIdx === 0 && showRestingHrColumn) {
        const restTd = metaCell(Number.isFinite(w.restingHrAvg) ? `${fmt0(w.restingHrAvg)} bpm` : "—", rs);
        restTd.classList.add("col-resting");
        tr.appendChild(restTd);
      }
      el.weeklyTableBody.appendChild(tr);
    });
  });
}

function renderInvestmentPanel() {
  const panel = document.getElementById("investmentPanel");
  if (!panel) return;
  const rows = dailyRows;
  if (!rows.length) {
    panel.innerHTML = "<p>No data available. Load your Apple Health export and refresh.</p>";
    return;
  }

  const totalDays = rows.length;
  const latestTs = new Date(rows[rows.length - 1].date).getTime();

  // Training consistency
  const trainingDaysTotal = rows.filter((r) => r.trainingDay).length;
  const last30Rows = rows.filter((r) => latestTs - new Date(r.date).getTime() <= 30 * ONE_DAY_MS);
  const last90Rows = rows.filter((r) => latestTs - new Date(r.date).getTime() <= 90 * ONE_DAY_MS);
  const training30 = last30Rows.filter((r) => r.trainingDay).length;
  const training90 = last90Rows.filter((r) => r.trainingDay).length;

  let currentStreak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trainingDay) currentStreak++;
    else break;
  }
  let longestStreak = 0;
  let tempStreak = 0;
  for (const row of rows) {
    if (row.trainingDay) {
      tempStreak++;
      if (tempStreak > longestStreak) longestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  // Body composition journey: first window vs last window (up to 28 days each)
  const windowSize = Math.min(28, Math.floor(totalDays / 2));
  const baselineRows = rows.slice(0, windowSize);
  const recentRows = rows.slice(rows.length - windowSize);
  const baselineWeight = averagePositiveMassKg(baselineRows.map((r) => r.weightKg));
  const recentWeight = averagePositiveMassKg(recentRows.map((r) => r.weightKg));
  const baselineBf = averageBodyFatPct(baselineRows.map((r) => r.bodyFatPct));
  const recentBf = averageBodyFatPct(recentRows.map((r) => r.bodyFatPct));
  const baselineLean = averagePositiveMassKg(baselineRows.map((r) => r.leanMassKg));
  const recentLean = averagePositiveMassKg(recentRows.map((r) => r.leanMassKg));
  const wDelta = Number.isFinite(baselineWeight) && Number.isFinite(recentWeight) ? recentWeight - baselineWeight : null;
  const bfDelta = Number.isFinite(baselineBf) && Number.isFinite(recentBf) ? recentBf - baselineBf : null;
  const leanDelta = Number.isFinite(baselineLean) && Number.isFinite(recentLean) ? recentLean - baselineLean : null;

  const wGoal = numTarget(targets.weightGoal);
  const bfGoalNum = numTarget(targets.bodyFatGoal);
  const refWeight = baselineWeight ?? recentWeight;
  const wTowardGoal = wDelta !== null && Number.isFinite(wGoal) && Number.isFinite(refWeight)
    ? (wGoal < refWeight ? wDelta < 0 : wDelta > 0)
    : null;
  const bfTowardGoal = bfDelta !== null && Number.isFinite(bfGoalNum)
    ? (bfGoalNum < (baselineBf ?? recentBf) ? bfDelta < 0 : bfDelta > 0)
    : (bfDelta !== null ? bfDelta < 0 : null);
  const wDeltaClass = wTowardGoal !== null ? (wTowardGoal ? " invest-pos" : " invest-neg") : "";
  const bfDeltaClass = bfTowardGoal !== null ? (bfTowardGoal ? " invest-pos" : " invest-neg") : "";
  const leanDeltaClass = leanDelta !== null ? (leanDelta >= 0 ? " invest-pos" : " invest-neg") : "";

  // Steps
  const daysWithSteps = rows.filter((r) => Number.isFinite(r.steps) && r.steps > 0);
  const totalSteps = sum(rows.map((r) => r.steps));
  const avgStepsPerDay = daysWithSteps.length ? totalSteps / daysWithSteps.length : null;
  const stepTarget = numTarget(targets.stepsAvgTarget);
  const daysHittingSteps = stepTarget > 0 ? daysWithSteps.filter((r) => r.steps >= stepTarget).length : null;

  // Nutrition
  const daysWithKcal = rows.filter((r) => Number.isFinite(r.kcal) && r.kcal > 0).length;
  const daysWithProtein = rows.filter((r) => Number.isFinite(r.proteinG) && r.proteinG > 0);
  const proteinTarget = numTarget(targets.minProtein);
  const daysHittingProtein = proteinTarget > 0 ? daysWithProtein.filter((r) => r.proteinG >= proteinTarget).length : null;

  const sign = (v) => (v >= 0 ? "+" : "");
  const windowLabel = windowSize >= 28 ? "4 wks" : `${windowSize} days`;

  const trainPctYear = totalDays > 0 ? Math.round((trainingDaysTotal / totalDays) * 100) : 0;
  const train90Pct = last90Rows.length > 0 ? Math.round((training90 / last90Rows.length) * 100) : 0;
  const train30Pct = last30Rows.length > 0 ? Math.round((training30 / last30Rows.length) * 100) : 0;

  const statCard = (val, label) =>
    `<div class="invest-stat"><div class="invest-stat-val">${val}</div><div class="invest-stat-label">${label}</div></div>`;

  const compRow = (label, from, to, delta, deltaClass) =>
    `<div class="invest-comp-row">`
    + `<div class="invest-comp-label">${label}</div>`
    + `<div class="invest-comp-from">${from}</div>`
    + `<div class="invest-comp-arrow">→</div>`
    + `<div class="invest-comp-to">${to}</div>`
    + `<div class="invest-comp-delta${deltaClass}">${delta}</div>`
    + `</div>`;

  const blocks = [];

  // Training block
  blocks.push(
    `<div class="invest-block">`
    + `<div class="achiev-h">Training consistency</div>`
    + `<div class="invest-stats">`
    + statCard(trainingDaysTotal, "sessions (year)")
    + statCard(`${trainPctYear}%`, "year rate")
    + statCard(`${train90Pct}%`, "last 90 days")
    + statCard(`${train30Pct}%`, "last 30 days")
    + statCard(currentStreak, "current streak")
    + statCard(longestStreak, "longest streak")
    + `</div>`
    + `</div>`,
  );

  // Body composition block
  blocks.push(
    `<div class="invest-block">`
    + `<div class="achiev-h">Body composition journey <span class="invest-window-label">(first ${windowLabel} vs last ${windowLabel} avg)</span></div>`
    + `<div class="invest-comp-grid">`
    + compRow(
      "Weight",
      Number.isFinite(baselineWeight) ? `${fmt1(kgToDisplay(baselineWeight))} ${displayWeightLabel()}` : "—",
      Number.isFinite(recentWeight) ? `${fmt1(kgToDisplay(recentWeight))} ${displayWeightLabel()}` : "—",
      wDelta !== null ? `${sign(wDelta)}${fmt1(kgToDisplay(wDelta))} ${displayWeightLabel()}` : "—",
      wDeltaClass,
    )
    + compRow(
      "Body fat",
      Number.isFinite(baselineBf) ? `${fmt1(baselineBf)}%` : "—",
      Number.isFinite(recentBf) ? `${fmt1(recentBf)}%` : "—",
      bfDelta !== null ? `${sign(bfDelta)}${fmt1(bfDelta)}%` : "—",
      bfDeltaClass,
    )
    + compRow(
      "Lean mass",
      Number.isFinite(baselineLean) ? `${fmt1(kgToDisplay(baselineLean))} ${displayWeightLabel()}` : "—",
      Number.isFinite(recentLean) ? `${fmt1(kgToDisplay(recentLean))} ${displayWeightLabel()}` : "—",
      leanDelta !== null ? `${sign(leanDelta)}${fmt1(kgToDisplay(leanDelta))} ${displayWeightLabel()}` : "—",
      leanDeltaClass,
    )
    + `</div>`
    + `<p class="achiev-meta">Averages exclude zero and missing values. Weight delta coloured toward/away from goal${Number.isFinite(wGoal) ? "" : " (no weight goal set — set one in Targets)"}. Lean mass: green = gained.</p>`
    + `</div>`,
  );

  // Steps block
  const stepsCards = [
    statCard(fmt0(totalSteps), "total steps (year)"),
    statCard(Number.isFinite(avgStepsPerDay) ? fmt0(avgStepsPerDay) : "—", "avg / logged day"),
  ];
  if (stepTarget > 0 && daysHittingSteps !== null) {
    stepsCards.push(statCard(`${daysHittingSteps} / ${daysWithSteps.length}`, "days hitting target"));
    stepsCards.push(statCard(
      daysWithSteps.length > 0 ? `${Math.round((daysHittingSteps / daysWithSteps.length) * 100)}%` : "—",
      "target success rate",
    ));
  }
  const stepsNote = stepTarget <= 0
    ? `<p class="achiev-meta" style="margin-top:8px">Set a <strong>steps target</strong> in the Targets tab to see daily compliance.</p>`
    : "";
  blocks.push(
    `<div class="invest-block">`
    + `<div class="achiev-h">Steps &amp; activity</div>`
    + `<div class="invest-stats">${stepsCards.join("")}</div>`
    + stepsNote
    + `</div>`,
  );

  // Nutrition block
  const nutritionCards = [
    statCard(`${daysWithKcal} / ${totalDays}`, "days with kcal"),
    statCard(totalDays > 0 ? `${Math.round((daysWithKcal / totalDays) * 100)}%` : "—", "kcal logging rate"),
    statCard(daysWithProtein.length, "days with protein"),
  ];
  if (proteinTarget > 0 && daysHittingProtein !== null) {
    nutritionCards.push(statCard(`${daysHittingProtein} / ${daysWithProtein.length}`, "days ≥ protein target"));
    nutritionCards.push(statCard(
      daysWithProtein.length > 0 ? `${Math.round((daysHittingProtein / daysWithProtein.length) * 100)}%` : "—",
      "protein hit rate",
    ));
  }
  const nutritionNote = proteinTarget <= 0
    ? `<p class="achiev-meta" style="margin-top:8px">Set a <strong>protein minimum</strong> in the Targets tab to see compliance.</p>`
    : "";
  blocks.push(
    `<div class="invest-block">`
    + `<div class="achiev-h">Nutrition logging</div>`
    + `<div class="invest-stats">${nutritionCards.join("")}</div>`
    + nutritionNote
    + `<p class="achiev-meta">${totalDays} days in dataset (last 1 year of export data).</p>`
    + `</div>`,
  );

  panel.innerHTML = blocks.join("");
}

/** Rebuild tables and achievability from in-memory `targets` (no DOM read). */
function renderCore() {
  if (targets.macroEnergyMode === "muscle" || targets.macroEnergyMode === "fat") {
    syncNutritionGramsFromTargets();
  }
  showRestingHrColumn = metricGateLastSixMonths(
    dailyRows,
    "restingHr",
    (v) => Number.isFinite(v) && v > 30 && v < 220,
  );
  syncAggregateRestingColumns(showRestingHrColumn);
  document.getElementById("sixMonthTable")?.classList.toggle("has-resting-col", showRestingHrColumn);
  document.getElementById("lastSixWeeksTable")?.classList.toggle("has-resting-col", showRestingHrColumn);
  const viewRows = maybeSmoothedRows(dailyRows);
  const weekly = buildWeeklySummaries(viewRows);
  renderSixMonthMonthly(weekly);
  renderLastSixWeeks(weekly);
  renderWeeklyTable(weekly);
  renderAchievability(weekly);
  renderInvestmentPanel();
  updateComputedFields();
}

function render() {
  readTargets();
  renderCore();
}

const ALL_TABS = ["overview", "targets", "investment"];

function setActiveTab(tabId) {
  const id = ALL_TABS.includes(tabId) ? tabId : "overview";
  prefs.activeTab = id;
  saveJson("replica_prefs", prefs);
  ALL_TABS.forEach((tid) => {
    const active = tid === id;
    const capitalized = tid.charAt(0).toUpperCase() + tid.slice(1);
    const btn = document.getElementById(`tabBtn${capitalized}`);
    const panel = document.getElementById(`tabPanel${capitalized}`);
    if (btn) {
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    if (panel) panel.classList.toggle("hidden", !active);
  });
  render();
}

function loadActiveTabFromPrefs() {
  const t = ALL_TABS.includes(prefs.activeTab) ? prefs.activeTab : "overview";
  setActiveTab(t);
}

function applyMacroPreset(which) {
  readTargets();
  targets.macroEnergyMode = which === "muscle" ? "muscle" : "fat";
  if (which === "muscle") {
    targets.proPct = 30;
    targets.carbPct = 45;
    targets.fatPct = 25;
  } else {
    targets.proPct = 35;
    targets.carbPct = 40;
    targets.fatPct = 25;
  }
  saveJson("replica_targets", targets);
  syncNutritionGramsFromTargets();
  loadStateToUi();
  render();
}

async function loadData() {
  if (isIosAppHost()) {
    postToIosBridge("load");
    return;
  }
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load data: ${res.status}`);
  dailyRows = filterLastYear(parseCsv(await res.text()));
  render();
}

async function refreshData() {
  setStatus("Refreshing...");
  try {
    if (isIosAppHost()) {
      postToIosBridge("refresh");
      return;
    }
    const res = await fetch(REFRESH_ENDPOINT, { method: "POST" });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || `Refresh failed (${res.status})`);
    await loadData();
    setStatus(`Updated at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    setStatus(`Refresh failed: ${err.message}`);
  }
}

function exportSnapshot() {
  const weekly = buildWeeklySummaries(maybeSmoothedRows(dailyRows));
  const header = showRestingHrColumn
    ? "week,avgWeight,avgBodyFat,avgKcal,totalSteps,avgProtein,trainingDays,kcalWeekSum,avgRestingHr"
    : "week,avgWeight,avgBodyFat,avgKcal,totalSteps,avgProtein,trainingDays,kcalWeekSum";
  const lines = [header];
  weekly.forEach((w) => {
    const base = [
      formatWeekDate(w.weekKey),
      fmt1(kgToDisplay(w.wAvg)),
      fmt1(w.bodyFatAvg),
      fmt1(kcalToDisplay(w.kcalAvg)),
      fmt0(w.stepsTotal),
      fmt1(w.proteinAvg),
      fmt0(w.trainingDays),
      fmt0(w.kcalWeekSum),
    ];
    if (showRestingHrColumn) base.push(Number.isFinite(w.restingHrAvg) ? fmt0(w.restingHrAvg) : "");
    lines.push(base.join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `health_dashboard_snapshot_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function wireEvents() {
  el.saveTargetsBtn.addEventListener("click", () => {
    readTargets();
    delete targets.macroEnergyMode;
    syncNutritionGramsFromTargets();
    loadStateToUi();
    render();
  });
  ["minProtein", "carbsTarget", "minFats", "proPct", "carbPct", "fatPct", "stepsAvgTarget", "weightGoal", "bodyFatGoal", "goalWeeks", "maintenanceKcal"].forEach((id) => {
    const node = el[id];
    if (!node) return;
    node.addEventListener("input", render);
    node.addEventListener("change", render);
  });
  el.prefillMaintenanceBtn?.addEventListener("click", prefillMaintenanceFromLogs);
  el.applyMuscleMacroBtn?.addEventListener("click", () => applyMacroPreset("muscle"));
  el.applyFatLossMacroBtn?.addEventListener("click", () => applyMacroPreset("fat"));
  el.refreshBtn.addEventListener("click", refreshData);
  el.exportBtn.addEventListener("click", exportSnapshot);
  el.weightUnit.addEventListener("change", () => {
    readPrefs();
    render();
  });
  el.energyUnit.addEventListener("change", () => {
    readPrefs();
    render();
  });
  el.trendMode.addEventListener("change", () => {
    readPrefs();
    render();
  });

  [["tabBtnOverview", "overview"], ["tabBtnTargets", "targets"], ["tabBtnInvestment", "investment"]].forEach(([bid, tab]) => {
    document.getElementById(bid)?.addEventListener("click", () => setActiveTab(tab));
  });
}

async function init() {
  loadStateToUi();
  wireEvents();
  loadActiveTabFromPrefs();
  if (isIosAppHost()) {
    postToIosBridge("load");
    return;
  }
  try {
    await loadData();
    setStatus(`Loaded ${fmt0(dailyRows.length)} days (last 1 year)`);
  } catch (err) {
    setStatus(`Load failed: ${err.message}`);
  }
}

init();
