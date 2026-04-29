const DATA_URL = "health_data_replica_daily.csv";
const REFRESH_ENDPOINT = "/api/refresh";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_YEAR_DAYS = 365;
const SIX_MONTH_DAYS = 183;

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
};

const defaultPrefs = {
  weightUnit: "kg",
  energyUnit: "kcal",
  trendMode: "raw",
};

const numFmt0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const numFmt1 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateCellFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short" });
const weekFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "2-digit" });

let dailyRows = [];
let targets = { ...defaultTargets, ...loadJson("replica_targets", {}) };
let prefs = { ...defaultPrefs, ...loadJson("replica_prefs", {}) };

const el = {
  refreshBtn: document.getElementById("refreshBtn"),
  refreshStatus: document.getElementById("refreshStatus"),
  weeklyTableBody: document.getElementById("weeklyTableBody"),
  sixMonthTableBody: document.getElementById("sixMonthTableBody"),
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
      weightKg: row.weightKg ? Number(row.weightKg) : null,
      steps: row.steps ? Number(row.steps) : null,
      proteinG: row.proteinG ? Number(row.proteinG) : null,
      kcal: row.kcal ? Number(row.kcal) : null,
      bodyFatPct: row.bodyFatPct ? Number(row.bodyFatPct) : null,
      leanMassKg: row.leanMassKg ? Number(row.leanMassKg) : null,
      trainingDay: row.trainingDay === "TRUE",
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

function smoothRows(rows, field, window = 7) {
  const out = rows.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    const vals = [];
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = out[j][field];
      if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length) out[i][field] = vals.reduce((a, v) => a + v, 0) / vals.length;
  }
  return out;
}

function maybeSmoothedRows(rows) {
  if (prefs.trendMode !== "smooth") return rows;
  let next = smoothRows(rows, "weightKg", 7);
  next = smoothRows(next, "bodyFatPct", 7);
  return next;
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
}

function sum(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((a, v) => a + v, 0) : null;
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
  return Number.isFinite(v) ? numFmt0.format(v) : "TBC";
}

function fmt1(v) {
  return Number.isFinite(v) ? numFmt1.format(v) : "TBC";
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

function updateComputedFields() {
  const d = computeDerivedTargets();
  el.kcalTarget.value = fmt0(kcalToDisplay(d.kcalTarget));
  el.totalPct.value = fmt0(d.totalPct);
}

function loadStateToUi() {
  Object.keys(defaultTargets).forEach((k) => { if (el[k]) el[k].value = targets[k]; });
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

function buildWeeklySummaries(rows) {
  const d = computeDerivedTargets();
  const stepTargetWeek = Number(targets.stepsAvgTarget || 0) * 7;
  return groupByWeek(rows).map(([weekKey, weekRows]) => {
    const wAvg = average(weekRows.map((r) => r.weightKg));
    const leanAvg = average(weekRows.map((r) => r.leanMassKg));
    const bodyFatAvg = average(weekRows.map((r) => r.bodyFatPct));
    const kcalAvg = average(weekRows.map((r) => r.kcal));
    const proteinAvg = average(weekRows.map((r) => r.proteinG));
    const stepsTotal = sum(weekRows.map((r) => r.steps));
    const trainingDays = weekRows.filter((r) => r.trainingDay).length;

    const scoreParts = [];
    if (Number.isFinite(stepTargetWeek) && stepTargetWeek > 0 && Number.isFinite(stepsTotal)) {
      scoreParts.push(clamp(stepsTotal / stepTargetWeek, 0, 1));
    }
    if (Number.isFinite(Number(targets.minProtein)) && Number(targets.minProtein) > 0 && Number.isFinite(proteinAvg)) {
      scoreParts.push(clamp(proteinAvg / Number(targets.minProtein), 0, 1));
    }
    if (Number.isFinite(d.kcalTarget) && d.kcalTarget > 0 && Number.isFinite(kcalAvg)) {
      scoreParts.push(clamp(1 - (Math.abs(kcalAvg - d.kcalTarget) / d.kcalTarget), 0, 1));
    }
    const consistencyScore = scoreParts.length ? (scoreParts.reduce((a, v) => a + v, 0) / scoreParts.length) * 100 : null;
    const completenessRatio = [wAvg, bodyFatAvg, proteinAvg, kcalAvg, stepsTotal].filter((v) => Number.isFinite(v)).length / 5;

    return {
      weekKey,
      rows: weekRows,
      wAvg,
      leanAvg,
      bodyFatAvg,
      kcalAvg,
      proteinAvg,
      stepsTotal,
      trainingDays,
      consistencyScore,
      completenessRatio,
    };
  });
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
    avgConsistencyScore: average(arr.map((w) => w.consistencyScore)),
    avgCompleteness: average(arr.map((w) => w.completenessRatio)),
    avgWeeklyTrainingDays: average(arr.map((w) => w.trainingDays)),
  }));

  monthRows.forEach((m) => {
    const [year, month] = m.key.split("-").map(Number);
    const monthDate = new Date(year, month - 1, 1);
    const monthLabel = monthDate.toLocaleString("en-GB", { month: "short", year: "2-digit" }).replace(" ", "-");
    const completenessClass = !Number.isFinite(m.avgCompleteness) ? "badge-low"
      : m.avgCompleteness >= 0.8 ? "badge-good"
      : m.avgCompleteness >= 0.5 ? "badge-partial"
      : "badge-low";
    const completenessText = !Number.isFinite(m.avgCompleteness) ? "Low"
      : m.avgCompleteness >= 0.8 ? "Good"
      : m.avgCompleteness >= 0.5 ? "Partial"
      : "Low";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${monthLabel}</td>
      <td>${fmt1(kgToDisplay(m.avgWeight))} ${displayWeightLabel()}</td>
      <td>${fmt1(m.avgBodyFat)}%</td>
      <td>${fmt0(m.avgSteps)}</td>
      <td>${fmt0(m.avgProtein)} g</td>
      <td>${fmt0(m.avgConsistencyScore)}%</td>
      <td><span class="badge ${completenessClass}">${completenessText}</span></td>
      <td>${fmt1(m.avgWeeklyTrainingDays)}</td>
    `;
    el.sixMonthTableBody.appendChild(tr);
  });

  const avgTraining = average(monthRows.map((m) => m.avgWeeklyTrainingDays));
  const avgWeight = average(monthRows.map((m) => m.avgWeight));
  const avgConsistency = average(monthRows.map((m) => m.avgConsistencyScore));
  el.sixMonthCommentary.textContent = `Last ${fmt0(monthRows.length)} months summary: average weight ${fmt1(kgToDisplay(avgWeight))} ${displayWeightLabel()}, average weekly training days ${fmt1(avgTraining)}, consistency score ${fmt0(avgConsistency)}%.`;
}

function renderAchievability(weekly) {
  const latest = weekly[0];
  const bfCurrent = latest?.bodyFatAvg;
  const bfGoal = Number(targets.bodyFatGoal);
  const goalWeeks = Math.max(1, Number(targets.goalWeeks || 12));
  const baseline = weekly.slice(0, 8).map((w) => w.bodyFatAvg).filter((v) => Number.isFinite(v));
  let observedDelta = null;
  if (baseline.length >= 2) observedDelta = (baseline[0] - baseline[baseline.length - 1]) / (baseline.length - 1);

  if (!Number.isFinite(bfCurrent) || !Number.isFinite(bfGoal)) {
    el.achievabilityText.textContent = "Enter Body Fat % Goal and Weeks to evaluate achievability.";
    return;
  }
  const requiredDelta = (bfGoal - bfCurrent) / goalWeeks;
  let status = "Tight";
  if (Number.isFinite(observedDelta)) {
    const gap = observedDelta - requiredDelta;
    if (Math.abs(gap) <= 0.08) status = "Likely";
    else if (gap < -0.08) status = "Unlikely";
  }
  el.achievabilityText.textContent =
    `Body fat is ${fmt1(bfCurrent)}%. Goal ${fmt1(bfGoal)}% in ${fmt0(goalWeeks)} weeks. `
    + `Required weekly change ${fmt1(requiredDelta)}%. Status: ${status}.`;
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
  const d = computeDerivedTargets();
  const stepTargetWeek = Number(targets.stepsAvgTarget || 0) * 7;
  const kcalTargetWeek = d.kcalTarget * 7;

  weekly.forEach((w, idx) => {
    const prev = weekly[idx + 1];
    const change = percentChange(w.wAvg, prev?.wAvg);
    const stepsRemaining = Number.isFinite(stepTargetWeek) && Number.isFinite(w.stepsTotal) ? stepTargetWeek - w.stepsTotal : null;
    const kcalRemaining = Number.isFinite(kcalTargetWeek) && Number.isFinite(w.kcalAvg)
      ? (kcalTargetWeek - (w.kcalAvg * 7))
      : 0;

    w.rows.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach((r, rowIdx) => {
      const tr = document.createElement("tr");
      if (rowIdx === 0) {
        tr.appendChild(metaCell(formatWeekDate(w.weekKey), w.rows.length));
        tr.appendChild(metaCell(change == null ? "0.0%" : `${fmt1(change)}%`, w.rows.length, change >= 0 ? "metric-positive" : "metric-warning"));
        tr.appendChild(metaCell(fmt0(stepsRemaining), w.rows.length, Number.isFinite(stepsRemaining) && stepsRemaining <= 0 ? "metric-positive" : "metric-warning"));
        tr.appendChild(metaCell(fmt0(kcalToDisplay(kcalRemaining)), w.rows.length, Math.abs(kcalRemaining) <= (kcalTargetWeek * 0.1) ? "metric-positive" : "metric-warning"));
      }
      const training = r.trainingDay ? "TRUE" : "FALSE";
      tr.innerHTML += `
        <td class="date-cell">${formatDateCell(r.date)}</td>
        <td>${fmt1(kgToDisplay(r.weightKg))}</td>
        <td>${fmt0(r.steps)}</td>
        <td>${fmt0(r.proteinG)}</td>
        <td>${fmt0(kcalToDisplay(r.kcal))}</td>
        <td>${fmt1(r.bodyFatPct)}%</td>
        <td>${fmt1(kgToDisplay(r.leanMassKg))}</td>
        <td class="${r.trainingDay ? "training-yes" : "training-no"}">${training}</td>
      `;
      if (rowIdx === 0) {
        const summary = document.createElement("td");
        summary.className = "week-summary";
        summary.rowSpan = w.rows.length;
        summary.innerHTML = `
          <div><b>Bodyweight</b> ${fmt1(kgToDisplay(w.wAvg))}</div>
          <div><b>${displayEnergyLabel()}</b> ${fmt0(kcalToDisplay(w.kcalAvg))}</div>
          <div><b>Steps</b> ${fmt0(w.stepsTotal)}</div>
          <div><b>Protein avg</b> ${fmt0(w.proteinAvg)}</div>
          <div><b>Body fat</b> ${fmt1(w.bodyFatAvg)}%</div>
          <div><b>Lean mass</b> ${fmt1(kgToDisplay(w.leanAvg))}</div>
        `;
        tr.appendChild(summary);
      }
      el.weeklyTableBody.appendChild(tr);
    });
  });
}

function render() {
  const viewRows = maybeSmoothedRows(dailyRows);
  const weekly = buildWeeklySummaries(viewRows);
  renderSixMonthMonthly(weekly);
  renderWeeklyTable(weekly);
  renderAchievability(weekly);
}

async function loadData() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load data: ${res.status}`);
  dailyRows = filterLastYear(parseCsv(await res.text()));
  render();
}

async function refreshData() {
  setStatus("Refreshing...");
  try {
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
  const lines = ["week,avgWeight,avgBodyFat,avgKcal,totalSteps,avgProtein,trainingDays"];
  weekly.forEach((w) => {
    lines.push([
      formatWeekDate(w.weekKey),
      fmt1(kgToDisplay(w.wAvg)),
      fmt1(w.bodyFatAvg),
      fmt1(kcalToDisplay(w.kcalAvg)),
      fmt0(w.stepsTotal),
      fmt1(w.proteinAvg),
      fmt0(w.trainingDays),
    ].join(","));
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
    render();
  });
  ["minProtein", "carbsTarget", "minFats", "proPct", "carbPct", "fatPct", "stepsAvgTarget"].forEach((id) => {
    el[id].addEventListener("input", () => {
      readTargets();
      updateComputedFields();
      render();
    });
  });
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
}

async function init() {
  loadStateToUi();
  wireEvents();
  try {
    await loadData();
    setStatus(`Loaded ${fmt0(dailyRows.length)} days (last 1 year)`);
  } catch (err) {
    setStatus(`Load failed: ${err.message}`);
  }
}

init();
