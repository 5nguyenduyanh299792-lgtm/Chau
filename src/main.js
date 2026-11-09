import {
  SyncState,
  setSyncStatusListener,
  syncRecordToCloud,
  deleteRecordFromCloud,
  syncSettingsToCloud,
  initSyncEngine,
  loginWithGoogle,
  logoutUser
} from './sync.js';

/* =========================================================
   TIỆN ÍCH CHUNG
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ico = (id, cls = "ic") => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

/** Nhóm hàng nghìn bằng dấu chấm: 1250000 -> "1.250.000" */
function group(n) {
  const neg = n < 0; n = Math.abs(Math.round(n));
  return (neg ? "-" : "") + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
/** Định dạng tiền Việt Nam: 1.250.000 đ */
const money = n => group(n || 0) + " đ";
/** Định dạng số có phần thập phân kiểu VN (dấu phẩy) */
function numVN(x, maxDec = 2) {
  if (!isFinite(x)) return "—";
  const neg = x < 0; x = Math.abs(x);
  const f = Math.pow(10, maxDec);
  x = Math.round(x * f) / f;
  const [i, d] = String(x).split(".");
  return (neg ? "-" : "") + group(Number(i)) + (d ? "," + d : "");
}
/** Dạng gọn cho trục biểu đồ: 2,5tr · 500k */
function compact(v) {
  if (v >= 1e6) return numVN(v / 1e6, 1) + "tr";
  if (v >= 1e3) return numVN(v / 1e3, 0) + "k";
  return String(v);
}
/** Đọc số tiền từ ô nhập -> {empty, neg, value} */
function parseMoney(str) {
  str = String(str ?? "").trim();
  if (!str) return { empty: true, neg: false, value: 0 };
  const neg = /^\s*-/.test(str);
  const digits = str.replace(/\D/g, "");
  if (!digits) return { empty: !neg, neg, value: 0 };
  const v = Number(digits);
  return { empty: false, neg, value: neg ? -v : v };
}
/** Đọc chỉ số công tơ (cho phép thập phân bằng , hoặc .) */
function parseMeter(str) {
  str = String(str ?? "").trim().replace(/\s/g, "");
  if (!str) return null;
  const v = Number(str.replace(",", "."));
  return isFinite(v) ? v : NaN;
}

const pad = n => String(n).padStart(2, "0");
const keyOf = (y, m) => `${y}-${pad(m)}`;
const parseKey = k => { const [y, m] = k.split("-").map(Number); return { y, m }; };
function shiftKey(k, d) { const { y, m } = parseKey(k); const t = y * 12 + (m - 1) + d; return keyOf(Math.floor(t / 12), (t % 12) + 1); }
const monthLabel = k => { const { y, m } = parseKey(k); return `${m}/${y}`; };
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = iso => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
const todayKey = () => { const t = today(); return keyOf(t.getFullYear(), t.getMonth() + 1); };

/* =========================================================
   LƯU TRỮ (localStorage + Firestore)
   ========================================================= */
const STORE_KEY = "sotientro.v1";
const CALC_KEY = "sotientro.calc.v1";
const defaultState = () => ({ version: 1, settings: { theme: "auto", dueDay: 5, people: 1 }, records: {} });

function nonNeg(v) { const n = Math.round(Number(v)); return isFinite(n) && n > 0 ? n : 0; }
function normMeter(m) {
  if (!m || typeof m !== "object") return null;
  const o = Number(m.old), n = Number(m.new), p = Number(m.price);
  return { on: !!m.on, old: isFinite(o) ? o : null, new: isFinite(n) ? n : null, price: isFinite(p) ? Math.max(0, Math.round(p)) : null };
}
/** Chuẩn hoá 1 bản ghi (dùng cả khi nhập JSON hoặc Firestore) */
function normRecord(r, key) {
  if (!r || typeof r !== "object") return null;
  key = key || r.month;
  if (!/^\d{4}-\d{2}$/.test(String(key))) return null;
  const { m } = parseKey(key); if (m < 1 || m > 12) return null;
  const others = Array.isArray(r.others) ? r.others
    .map(o => ({ name: String(o?.name ?? "").trim().slice(0, 60), amount: nonNeg(o?.amount) }))
    .filter(o => o.name) : [];
  const paid = !!r.paid;
  return {
    month: key,
    rent: nonNeg(r.rent), electric: nonNeg(r.electric), water: nonNeg(r.water),
    elecMeter: normMeter(r.elecMeter), waterMeter: normMeter(r.waterMeter),
    others, note: String(r.note ?? "").slice(0, 500),
    people: Math.min(20, Math.max(1, Math.round(Number(r.people)) || 1)),
    paid, paidDate: paid && /^\d{4}-\d{2}-\d{2}$/.test(r.paidDate || "") ? r.paidDate : (paid ? isoDate(today()) : ""),
    createdAt: r.createdAt || new Date().toISOString(), updatedAt: r.updatedAt || new Date().toISOString(),
  };
}
function normState(d) {
  const s = defaultState();
  if (!d || typeof d !== "object") return s;
  if (d.settings) {
    if (["light", "dark", "auto"].includes(d.settings.theme)) s.settings.theme = d.settings.theme;
    const dd = Math.round(Number(d.settings.dueDay)); if (dd >= 1 && dd <= 31) s.settings.dueDay = dd;
    const pp = Math.round(Number(d.settings.people)); if (pp >= 1 && pp <= 20) s.settings.people = pp;
  }
  const recs = Array.isArray(d.records) ? d.records : Object.entries(d.records || {}).map(([k, v]) => ({ ...v, month: v?.month || k }));
  for (const r of recs) { const n = normRecord(r); if (n) s.records[n.month] = n; }
  return s;
}
function loadState() {
  try { const raw = localStorage.getItem(STORE_KEY); return raw ? normState(JSON.parse(raw)) : defaultState(); }
  catch (e) { return defaultState(); }
}
let S = loadState();
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); return true; }
  catch (e) { toast("Không lưu được vào bộ nhớ trình duyệt!", true); return false; }
}

/* ===== Truy vấn dữ liệu ===== */
const othersSum = r => (r?.others || []).reduce((a, o) => a + o.amount, 0);
const totalOf = r => r ? r.rent + r.electric + r.water + othersSum(r) : 0;
const sortedKeys = () => Object.keys(S.records).sort();
function prevRecord(key) { const ks = sortedKeys().filter(k => k < key); return ks.length ? S.records[ks[ks.length - 1]] : null; }
function dataYears() { return [...new Set(Object.keys(S.records).map(k => parseKey(k).y))].sort((a, b) => a - b); }
function yearRange() {
  const ys = dataYears(), cy = today().getFullYear();
  const min = Math.min(cy - 3, ...ys), max = Math.max(cy + 1, ...ys);
  const out = []; for (let y = max; y >= min; y--) out.push(y); return out;
}
const usage = mt => (mt && mt.on && mt.old != null && mt.new != null && mt.new >= mt.old) ? Math.round((mt.new - mt.old) * 100) / 100 : null;

/** Trạng thái hạn đóng tiền của 1 tháng */
function dueInfo(key) {
  const r = S.records[key];
  if (r && r.paid) return { kind: "good", text: `Đã đóng ngày ${fmtDate(r.paidDate)}` };
  const { y, m } = parseKey(key);
  const due = new Date(y, m - 1, Math.min(S.settings.dueDay, daysIn(y, m)));
  const diff = Math.round((due - today()) / 86400000);
  const dueTxt = `${pad(due.getDate())}/${pad(m)}`;
  if (diff < 0) return { kind: "bad", text: `Quá hạn ${-diff} ngày (hạn ${dueTxt})` };
  if (diff === 0) return { kind: "warn", text: `Hôm nay là hạn đóng tiền (${dueTxt})` };
  if (diff <= 3) return { kind: "warn", text: `Sắp đến hạn: còn ${diff} ngày (${dueTxt})` };
  return { kind: "info", text: `Hạn đóng: ${dueTxt} (còn ${diff} ngày)` };
}
const statusBadge = r => !r ? `<span class="badge none">Chưa nhập</span>`
  : r.paid ? `<span class="badge paid">Đã đóng</span>` : `<span class="badge unpaid">Chưa đóng</span>`;

/* =========================================================
   GIAO DIỆN CHUNG: theme, toast, hộp thoại, điều hướng
   ========================================================= */
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => S.settings.theme === "dark" || (S.settings.theme === "auto" && mqDark.matches);
function applyTheme() {
  const t = S.settings.theme, root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
  const dark = isDark();
  $("#metaTheme").setAttribute("content", dark ? "#0d0d0d" : "#f4f4f1");
  $("#themeBtn").innerHTML = ico(dark ? "sun" : "moon");
  $("#themeBtn").setAttribute("aria-label", dark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối");
  $$("#themeSeg button").forEach(b => b.classList.toggle("on", b.dataset.themeSet === t));
}
function setTheme(t) {
  S.settings.theme = t;
  persist();
  applyTheme();
  syncSettingsToCloud(S.settings);
}
mqDark.addEventListener?.("change", () => { if (S.settings.theme === "auto") applyTheme(); });

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 3600 : 2400);
}

/** Hộp thoại chung. buttons: [{text, value, cls}] -> Promise(value | null) */
function dialog({ title, message, buttons, input }) {
  return new Promise(resolve => {
    const ov = $("#confirmOverlay"), row = $(".btn-row", ov), inp = $("#cfInput");
    $("#cfTitle").textContent = title; $("#cfMsg").innerHTML = message;
    $("#cfInputWrap").hidden = !input; inp.value = "";
    if (input) $("#cfInputLabel").textContent = input.label;
    buttons = buttons || [{ text: "Huỷ", value: null, cls: "btn-ghost" }, { text: "Đồng ý", value: true, cls: "btn-primary" }];
    row.innerHTML = buttons.map((b, i) => `<button type="button" class="btn ${b.cls || "btn-ghost"}" data-i="${i}">${esc(b.text)}</button>`).join("");
    const okBtns = buttons.map((b, i) => [b, row.children[i]]).filter(([b]) => b.value !== null);
    const check = () => okBtns.forEach(([, el]) => el.disabled = input ? !input.validate(inp.value) : false);
    inp.oninput = check; check();
    const close = v => { ov.classList.remove("show"); ov.setAttribute("aria-hidden", "true"); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
    document.addEventListener("keydown", onKey, true);
    row.onclick = e => { const b = e.target.closest("button"); if (b && !b.disabled) close(buttons[+b.dataset.i].value); };
    ov.onclick = e => { if (e.target === ov) close(null); };
    ov.classList.add("show"); ov.setAttribute("aria-hidden", "false");
    setTimeout(() => (input ? inp : row.lastElementChild).focus(), 60);
  });
}
const confirmDanger = (title, message, okText = "Xoá") => dialog({ title, message, buttons: [{ text: "Huỷ", value: null }, { text: okText, value: true, cls: "btn-danger-solid" }] });

/* Điều hướng */
const PAGES = ["dash", "entry", "cal", "hist"];
let currentPage = "dash";
function go(page, { push = true } = {}) {
  if (!PAGES.includes(page)) page = "dash";
  currentPage = page;
  $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + page));
  $$(".nav button").forEach(b => { const on = b.dataset.nav === page; b.classList.toggle("active", on); on ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"); });
  document.body.className = "page-" + page;
  if (page === "dash") renderDash();
  if (page === "cal") renderCal();
  if (page === "hist") renderHist();
  if (push && location.hash !== "#" + page) history.pushState(null, "", "#" + page);
  window.scrollTo({ top: 0 });
}
window.addEventListener("popstate", () => go(location.hash.slice(1) || "dash", { push: false }));

/* =========================================================
   TRANG NHẬP CHI PHÍ
   ========================================================= */
let editKey = todayKey();
let formOthers = [];   // [{name, amount(string)}]
let dirty = false;
let calcTarget = null; // ô tiền mà máy tính sẽ chèn kết quả

/** Định dạng ô tiền khi đang gõ, giữ nguyên vị trí con trỏ */
function formatMoneyInput(el) {
  const raw = el.value, caret = el.selectionStart ?? raw.length;
  const digitsRight = raw.slice(caret).replace(/\D/g, "").length;
  const neg = /^\s*-/.test(raw);
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const out = (neg ? "-" : "") + (digits ? group(Number(digits)) : "");
  if (out === raw) return;
  el.value = out;
  let pos = out.length, seen = 0;
  if (digitsRight > 0) {
    for (let i = out.length - 1; i >= 0; i--) { if (/\d/.test(out[i])) seen++; if (seen === digitsRight) { pos = i; break; } }
  }
  try { if (document.activeElement === el) el.setSelectionRange(pos, pos); } catch (e) {}
}
const setMoney = (el, v) => { el.value = v === "" || v == null ? "" : group(v); };

function fillSelects() {
  const fm = $("#fMonth"), fy = $("#fYear");
  fm.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">Tháng ${i + 1}</option>`).join("");
  fy.innerHTML = yearRange().map(y => `<option value="${y}">${y}</option>`).join("");
  const sd = $("#sDueDay");
  sd.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">Ngày ${i + 1}</option>`).join("");
}

function setMeterUI(kind, mt) {
  const K = kind === "elec" ? "Elec" : "Water";
  const on = !!(mt && mt.on);
  $(`#m${K}On`).checked = on;
  $(`#m${K}`).classList.toggle("show", on);
  $(`#m${K}Old`).value = mt?.old ?? "";
  $(`#m${K}New`).value = mt?.new ?? "";
  setMoney($(`#m${K}Price`), mt?.price ?? "");
  $(`#f${K}`).readOnly = on;
}

/** Nạp dữ liệu tháng `key` vào form */
function loadForm(key) {
  editKey = key;
  const { y, m } = parseKey(key);
  const fy = $("#fYear");
  if (![...fy.options].some(o => +o.value === y)) fy.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
  $("#fMonth").value = m; fy.value = y;
  $$(".err-msg").forEach(e => e.classList.remove("show"));
  $$(".input.err").forEach(e => e.classList.remove("err"));

  const r = S.records[key], prev = prevRecord(key);
  const banner = $("#entryBanner");
  $("#hRent").textContent = "";
  if (r) {
    setMoney($("#fRent"), r.rent); setMoney($("#fElec"), r.electric); setMoney($("#fWater"), r.water);
    setMeterUI("elec", r.elecMeter); setMeterUI("water", r.waterMeter);
    formOthers = r.others.map(o => ({ name: o.name, amount: group(o.amount) }));
    $("#fNote").value = r.note; $("#fPeople").value = r.people;
    setPaid(r.paid, r.paidDate);
    banner.className = "edit-banner";
    banner.innerHTML = `${ico("edit")}<span>Đang sửa tháng ${monthLabel(key)} đã lưu · cập nhật ${new Date(r.updatedAt).toLocaleDateString("vi-VN")}</span>`;
  } else {
    // Tháng mới: tự điền từ tháng trước
    setMoney($("#fRent"), prev ? prev.rent : "");
    if (prev) $("#hRent").textContent = `Đã tự điền từ tháng ${monthLabel(prev.month)} — sửa nếu có thay đổi`;
    $("#fElec").value = ""; $("#fWater").value = "";
    const carry = mt => mt && mt.on ? { on: true, old: mt.new, new: null, price: mt.price } : null;
    setMeterUI("elec", carry(prev?.elecMeter)); setMeterUI("water", carry(prev?.waterMeter));
    formOthers = [];
    $("#fNote").value = ""; $("#fPeople").value = prev?.people || S.settings.people;
    setPaid(false, "");
    banner.className = "edit-banner new";
    banner.innerHTML = `${ico("plus")}<span>Tháng ${monthLabel(key)} chưa có dữ liệu — nhập mới</span>`;
  }
  $("#copyPrevOthers").hidden = !(prev && prev.others.length && !r);
  $("#entryExtra").hidden = !r;
  renderOthers(); computeMeter("elec"); computeMeter("water"); updateTotal(false);
  dirty = false;
}

function setPaid(paid, date) {
  $("#stPaid").className = paid ? "on-paid" : ""; $("#stUnpaid").className = paid ? "" : "on-unpaid";
  $("#stPaid").setAttribute("aria-checked", paid); $("#stUnpaid").setAttribute("aria-checked", !paid);
  $("#paidDateField").hidden = !paid;
  $("#fPaidDate").value = paid ? (date || isoDate(today())) : "";
}
const formPaid = () => $("#stPaid").classList.contains("on-paid");

/* ===== Khoản khác ===== */
function otherNameSuggestions() {
  const set = new Set(["Wifi", "Tiền rác", "Gửi xe", "Truyền hình cáp", "Vệ sinh", "Thang máy", "Gas"]);
  Object.values(S.records).forEach(r => r.others.forEach(o => set.add(o.name)));
  return [...set];
}
function renderOthers() {
  const list = $("#otherList");
  if (!$("#otherNames")) document.body.insertAdjacentHTML("beforeend", `<datalist id="otherNames"></datalist>`);
  $("#otherNames").innerHTML = otherNameSuggestions().map(n => `<option value="${esc(n)}">`).join("");
  list.innerHTML = formOthers.map((o, i) => `
    <div class="other-item" data-i="${i}">
      <input class="input" data-oname placeholder="Tên khoản" list="otherNames" maxlength="60" value="${esc(o.name)}" aria-label="Tên khoản khác ${i + 1}">
      <div class="money"><input class="input" data-money data-oamt data-label="${esc(o.name || "Khoản khác")}" inputmode="numeric" placeholder="0" value="${esc(o.amount)}" aria-label="Số tiền khoản khác ${i + 1}"></div>
      <button type="button" class="del" data-odel aria-label="Xoá khoản này">${ico("trash")}</button>
    </div>`).join("");
}
function addOther(name = "", amount = "", focus = true) {
  formOthers.push({ name, amount }); renderOthers(); updateTotal(); dirty = true;
  if (focus) {
    const row = $("#otherList").lastElementChild;
    const target = name ? $("[data-oamt]", row) : $("[data-oname]", row);
    target?.focus();
  }
}

/* ===== Tính theo chỉ số công tơ ===== */
function computeMeter(kind) {
  const K = kind === "elec" ? "Elec" : "Water", unit = kind === "elec" ? "kWh" : "m³";
  const on = $(`#m${K}On`).checked, out = $(`#m${K}Calc`), amt = $(`#f${K}`);
  out.classList.toggle("show", on);
  if (!on) return { ok: true };
  const o = parseMeter($(`#m${K}Old`).value), n = parseMeter($(`#m${K}New`).value);
  const p = parseMoney($(`#m${K}Price`).value);
  if (o == null || n == null || p.empty) { out.innerHTML = `Nhập số cũ, số mới và giá để tự tính tiền`; amt.value = ""; return { ok: false, msg: `Nhập đủ số cũ, số mới và giá ${unit}` }; }
  if (isNaN(o) || isNaN(n) || o < 0 || n < 0) { out.innerHTML = `Chỉ số không hợp lệ`; amt.value = ""; return { ok: false, msg: "Chỉ số công tơ không hợp lệ" }; }
  if (p.neg) { out.innerHTML = `Giá không được âm`; amt.value = ""; return { ok: false, msg: "Đơn giá không được âm" }; }
  if (n < o) { out.innerHTML = `<span class="up">Số mới (${numVN(n)}) nhỏ hơn số cũ (${numVN(o)})</span>`; amt.value = ""; return { ok: false, msg: "Số mới phải lớn hơn hoặc bằng số cũ" }; }
  const used = Math.round((n - o) * 100) / 100, total = Math.round(used * p.value);
  setMoney(amt, total);
  out.innerHTML = `Dùng <b>${numVN(used)} ${unit}</b> × ${money(p.value)} = <b>${money(total)}</b>`;
  return { ok: true };
}
function readMeter(kind) {
  const K = kind === "elec" ? "Elec" : "Water";
  const on = $(`#m${K}On`).checked;
  const o = parseMeter($(`#m${K}Old`).value), n = parseMeter($(`#m${K}New`).value), p = parseMoney($(`#m${K}Price`).value);
  if (!on && o == null && n == null) return null;
  return { on, old: isFinite(o) ? o : null, new: isFinite(n) ? n : null, price: p.empty ? null : Math.max(0, p.value) };
}

/* ===== Tổng tiền trực tiếp ===== */
let lastTotal = null;
function formTotal() {
  const v = id => Math.max(0, parseMoney($(id).value).value);
  const others = formOthers.reduce((a, o) => a + Math.max(0, parseMoney(o.amount).value), 0);
  return { total: v("#fRent") + v("#fElec") + v("#fWater") + others, others };
}
function updateTotal(anim = true) {
  const { total, others } = formTotal();
  const people = Math.max(1, Math.round(+$("#fPeople").value) || 1);
  const el = $("#liveTotal");
  el.textContent = money(total);
  $("#livePer").textContent = people > 1 ? `Mỗi người (${people}): ${money(Math.round(total / people))}` : "";
  $("#otherSum").textContent = formOthers.length ? money(others) : "";
  if (anim && lastTotal !== null && lastTotal !== total) { el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); }
  lastTotal = total;
}

/* ===== Kiểm tra & lưu ===== */
function showErr(inputEl, errEl, msg) {
  if (inputEl) inputEl.classList.add("err");
  if (errEl) { errEl.textContent = msg; errEl.classList.add("show"); }
}
function checkMoney(id, errId, label) {
  const el = $(id), p = parseMoney(el.value);
  if (p.empty) { showErr(el, $(errId), `Vui lòng nhập ${label.toLowerCase()} (nhập 0 nếu không có)`); return null; }
  if (p.neg) { showErr(el, $(errId), `${label} không được âm`); return null; }
  return p.value;
}
function validateAndBuild() {
  $$(".err-msg").forEach(e => { e.classList.remove("show"); e.textContent = ""; });
  $$(".input.err").forEach(e => e.classList.remove("err"));
  let ok = true;
  const rent = checkMoney("#fRent", "#eRent", "Tiền trọ"); if (rent === null) ok = false;
  const meterRes = {};
  for (const [kind, K, label] of [["elec", "Elec", "Tiền điện"], ["water", "Water", "Tiền nước"]]) {
    const r = computeMeter(kind);
    if (!r.ok) { ok = false; showErr($(`#m${K}New`), $(`#e${K}`), r.msg); meterRes[kind] = null; continue; }
    meterRes[kind] = checkMoney(`#f${K}`, `#e${K}`, label); if (meterRes[kind] === null) ok = false;
  }
  const others = [];
  $$("#otherList .other-item").forEach((row, i) => {
    const nEl = $("[data-oname]", row), aEl = $("[data-oamt]", row);
    const name = nEl.value.trim(), p = parseMoney(aEl.value);
    if (!name && p.empty) return; // dòng trống -> bỏ qua
    if (!name) { ok = false; showErr(nEl, $("#eOther"), `Nhập tên cho khoản thứ ${i + 1}`); return; }
    if (p.empty) { ok = false; showErr(aEl, $("#eOther"), `Nhập số tiền cho “${name}”`); return; }
    if (p.neg) { ok = false; showErr(aEl, $("#eOther"), `Số tiền “${name}” không được âm`); return; }
    others.push({ name, amount: p.value });
  });
  const paid = formPaid(), paidDate = $("#fPaidDate").value;
  if (paid && !paidDate) { ok = false; showErr($("#fPaidDate"), $("#ePaidDate"), "Chọn ngày đóng tiền"); }
  const people = Math.round(+$("#fPeople").value);
  if (!(people >= 1 && people <= 20)) { ok = false; $("#fPeople").classList.add("err"); toast("Số người ở phải từ 1 đến 20", true); }
  if (!ok) return null;
  const old = S.records[editKey];
  return {
    month: editKey, rent, electric: meterRes.elec, water: meterRes.water,
    elecMeter: readMeter("elec"), waterMeter: readMeter("water"),
    others, note: $("#fNote").value.trim(), people, paid, paidDate: paid ? paidDate : "",
    createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}
async function saveForm(e) {
  e?.preventDefault();
  const rec = validateAndBuild();
  if (!rec) {
    toast("Chưa lưu được — kiểm tra các ô báo đỏ", true);
    const first = $(".input.err"); first?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const isNew = !S.records[editKey];
  S.records[editKey] = rec;
  if (persist()) {
    toast(isNew ? `Đã lưu chi phí tháng ${monthLabel(editKey)}` : `Đã cập nhật tháng ${monthLabel(editKey)}`);
    loadForm(editKey);
    // Đồng bộ lên Firestore
    syncRecordToCloud(rec);
  }
}
async function deleteCurrent() {
  if (!S.records[editKey]) return;
  const ok = await confirmDanger("Xoá tháng này?", `Dữ liệu chi phí tháng <b>${monthLabel(editKey)}</b> (${money(totalOf(S.records[editKey]))}) sẽ bị xoá vĩnh viễn.`);
  if (!ok) return;
  const delKey = editKey;
  delete S.records[delKey]; persist();
  toast(`Đã xoá tháng ${monthLabel(delKey)}`);
  loadForm(editKey);
  // Xoá trên Firestore
  deleteRecordFromCloud(delKey);
}

/** Mở trang nhập cho tháng `key` (hỏi nếu đang có thay đổi chưa lưu) */
async function openMonth(key, nav = true) {
  if (dirty && key !== editKey) {
    const v = await dialog({ title: "Bỏ thay đổi chưa lưu?", message: `Bạn đang sửa tháng <b>${monthLabel(editKey)}</b> nhưng chưa lưu.`,
      buttons: [{ text: "Ở lại", value: null }, { text: "Bỏ thay đổi", value: true, cls: "btn-danger-solid" }] });
    if (!v) { const { y, m } = parseKey(editKey); $("#fMonth").value = m; $("#fYear").value = y; if (nav) go("entry"); return; }
  }
  if (key !== editKey || !dirty) loadForm(key);
  if (nav) go("entry");
}

/* ===== Văn bản chia sẻ (Zalo, Messenger…) ===== */
function shareText(key) {
  const r = S.records[key]; if (!r) return "";
  const L = [`🏠 Chi phí phòng trọ tháng ${monthLabel(key)}`, `• Tiền trọ: ${money(r.rent)}`];
  const mline = (mt, unit) => { const u = usage(mt); return u != null ? ` (${numVN(u)} ${unit}: ${numVN(mt.old)} → ${numVN(mt.new)})` : ""; };
  L.push(`• Tiền điện: ${money(r.electric)}${mline(r.elecMeter, "kWh")}`);
  L.push(`• Tiền nước: ${money(r.water)}${mline(r.waterMeter, "m³")}`);
  r.others.forEach(o => L.push(`• ${o.name}: ${money(o.amount)}`));
  L.push("──────────", `Tổng cộng: ${money(totalOf(r))}`);
  if (r.people > 1) L.push(`Mỗi người (${r.people} người): ${money(Math.round(totalOf(r) / r.people))}`);
  L.push(`Trạng thái: ${r.paid ? "Đã đóng ngày " + fmtDate(r.paidDate) : "Chưa đóng"}`);
  if (r.note) L.push(`Ghi chú: ${r.note}`);
  return L.join("\n");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e2) {}
    ta.remove(); return ok;
  }
}
async function shareMonth(key) {
  const text = shareText(key); if (!text) return;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: `Tiền trọ tháng ${monthLabel(key)}`, text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  toast(await copyText(text) ? "Đã sao chép — dán vào Zalo/Messenger để gửi" : "Không sao chép được", false);
}

/* ===== Gắn sự kiện form ===== */
function bindEntry() {
  const form = $("#entryForm");
  form.addEventListener("submit", saveForm);
  form.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "fMonth" || t.id === "fYear") return; // đổi tháng không tính là sửa
    dirty = true;
    if (t.matches("[data-money], [data-money-lite]")) formatMoneyInput(t);
    if (t.matches(".input.err")) t.classList.remove("err");
    const row = t.closest(".other-item");
    if (row) {
      const i = +row.dataset.i;
      if (t.matches("[data-oname]")) { formOthers[i].name = t.value; $("[data-oamt]", row).dataset.label = t.value || "Khoản khác"; }
      if (t.matches("[data-oamt]")) formOthers[i].amount = t.value;
    }
    const mrow = t.closest("[data-meter]");
    if (mrow && t.closest(".meter")) computeMeter(mrow.dataset.meter);
    updateTotal();
  });
  form.addEventListener("focusin", e => { if (e.target.matches("[data-money]") && !e.target.readOnly) calcTarget = e.target; });
  form.addEventListener("click", e => {
    const del = e.target.closest("[data-odel]");
    if (del) { const i = +del.closest(".other-item").dataset.i; formOthers.splice(i, 1); renderOthers(); updateTotal(); dirty = true; calcTarget = null; }
    const q = e.target.closest("[data-quick]");
    if (q) addOther(q.dataset.quick);
    const st = e.target.closest("[data-paid]");
    if (st) { setPaid(st.dataset.paid === "1", $("#fPaidDate").value); dirty = true; }
  });
  for (const K of ["Elec", "Water"]) {
    $(`#m${K}On`).addEventListener("change", e => {
      const on = e.target.checked;
      $(`#m${K}`).classList.toggle("show", on); $(`#f${K}`).readOnly = on;
      if (on && !$(`#m${K}Old`).value) { const p = prevRecord(editKey), mt = p?.[K === "Elec" ? "elecMeter" : "waterMeter"]; if (mt?.new != null) $(`#m${K}Old`).value = mt.new; if (mt?.price && !$(`#m${K}Price`).value) setMoney($(`#m${K}Price`), mt.price); }
      if (on) setTimeout(() => $(`#m${K}${$(`#m${K}Old`).value ? "New" : "Old"}`).focus(), 30);
      computeMeter(K.toLowerCase() === "elec" ? "elec" : "water"); updateTotal(); dirty = true;
    });
  }
  $("#copyPrevOthers").addEventListener("click", () => {
    const p = prevRecord(editKey); if (!p) return;
    p.others.forEach(o => { if (!formOthers.some(f => f.name.trim().toLowerCase() === o.name.toLowerCase())) formOthers.push({ name: o.name, amount: group(o.amount) }); });
    renderOthers(); updateTotal(); dirty = true; $("#copyPrevOthers").hidden = true;
    toast(`Đã lấy ${p.others.length} khoản từ tháng ${monthLabel(p.month)}`);
  });
  const pick = () => openMonth(keyOf(+$("#fYear").value, +$("#fMonth").value), false);
  $("#fMonth").addEventListener("change", pick); $("#fYear").addEventListener("change", pick);
  $("#mPrev").addEventListener("click", () => openMonth(shiftKey(editKey, -1), false));
  $("#mNext").addEventListener("click", () => openMonth(shiftKey(editKey, 1), false));
  $("#btnDelete").addEventListener("click", deleteCurrent);
  $("#btnShareEntry").addEventListener("click", () => shareMonth(editKey));
  window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
}

/* =========================================================
   AI TRỢ LÝ TỰ ĐỘNG ĐIỀN (SPEECH-TO-TEXT & GEMINI AI)
   ========================================================= */
let speechRecog = null;
let isListening = false;

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const recog = new SpeechRecognition();
  recog.lang = "vi-VN";
  recog.continuous = false;
  recog.interimResults = true;
  return recog;
}

function flashField(el) {
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function applyAIResult(data) {
  if (!data || typeof data !== "object") return;

  // Nếu người dùng nói về tháng khác với tháng đang mở
  if (data.month && /^\d{4}-\d{2}$/.test(data.month) && data.month !== editKey) {
    openMonth(data.month, false);
  }

  dirty = true;

  // 1. Tiền trọ
  if (data.rent != null && data.rent >= 0) {
    setMoney($("#fRent"), data.rent);
    flashField($("#fRent"));
  }

  // 2. Tiền điện
  if (data.elecMeter && data.elecMeter.on) {
    $("#mElecOn").checked = true;
    $("#mElec").classList.add("show");
    $("#fElec").readOnly = true;
    if (data.elecMeter.old != null) $("#mElecOld").value = data.elecMeter.old;
    if (data.elecMeter.new != null) $("#mElecNew").value = data.elecMeter.new;
    if (data.elecMeter.price != null) setMoney($("#mElecPrice"), data.elecMeter.price);
    computeMeter("elec");
    flashField($("#fElec"));
  } else if (data.electric != null && data.electric >= 0) {
    $("#mElecOn").checked = false;
    $("#mElec").classList.remove("show");
    $("#fElec").readOnly = false;
    setMoney($("#fElec"), data.electric);
    flashField($("#fElec"));
  }

  // 3. Tiền nước
  if (data.waterMeter && data.waterMeter.on) {
    $("#mWaterOn").checked = true;
    $("#mWater").classList.add("show");
    $("#fWater").readOnly = true;
    if (data.waterMeter.old != null) $("#mWaterOld").value = data.waterMeter.old;
    if (data.waterMeter.new != null) $("#mWaterNew").value = data.waterMeter.new;
    if (data.waterMeter.price != null) setMoney($("#mWaterPrice"), data.waterMeter.price);
    computeMeter("water");
    flashField($("#fWater"));
  } else if (data.water != null && data.water >= 0) {
    $("#mWaterOn").checked = false;
    $("#mWater").classList.remove("show");
    $("#fWater").readOnly = false;
    setMoney($("#fWater"), data.water);
    flashField($("#fWater"));
  }

  // 4. Khoản khác
  if (Array.isArray(data.others) && data.others.length > 0) {
    data.others.forEach(item => {
      if (!item || !item.name) return;
      const existing = formOthers.find(o => o.name.trim().toLowerCase() === String(item.name).trim().toLowerCase());
      if (existing) {
        existing.amount = group(item.amount || 0);
      } else {
        formOthers.push({ name: String(item.name).trim(), amount: group(item.amount || 0) });
      }
    });
    renderOthers();
  }

  // 5. Số người ở
  if (data.people != null && data.people >= 1 && data.people <= 20) {
    $("#fPeople").value = Math.round(data.people);
    flashField($("#fPeople"));
  }

  // 6. Trạng thái thanh toán
  if (data.paid != null) {
    setPaid(Boolean(data.paid), data.paidDate || isoDate(today()));
  }

  // 7. Ghi chú
  if (data.note) {
    const curNote = $("#fNote").value.trim();
    if (!curNote) {
      $("#fNote").value = data.note;
    } else if (!curNote.includes(data.note)) {
      $("#fNote").value = `${curNote}\n${data.note}`;
    }
    flashField($("#fNote"));
  }

  updateTotal(true);
}

function bindAIAssistant() {
  const inputEl = $("#aiInputText");
  const micBtn = $("#aiMicBtn");
  const fillBtn = $("#aiFillBtn");
  const statusBadge = $("#aiVoiceStatus");
  const summaryBox = $("#aiResultSummary");

  if (!inputEl || !micBtn || !fillBtn) return;

  speechRecog = setupSpeechRecognition();

  if (speechRecog) {
    speechRecog.onstart = () => {
      isListening = true;
      micBtn.classList.add("listening");
      if (statusBadge) {
        statusBadge.style.display = "inline-flex";
        statusBadge.textContent = "Đang lắng nghe tiếng Việt…";
      }
    };

    speechRecog.onresult = e => {
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      inputEl.value = transcript;
    };

    speechRecog.onerror = e => {
      console.warn("Speech error:", e.error);
      isListening = false;
      micBtn.classList.remove("listening");
      if (statusBadge) statusBadge.style.display = "none";
      if (e.error === "not-allowed") {
        toast("Vui lòng cho phép quyền truy cập micro trong trình duyệt", true);
      } else if (e.error !== "no-speech") {
        toast(`Lỗi nhận giọng nói: ${e.error}`, true);
      }
    };

    speechRecog.onend = () => {
      isListening = false;
      micBtn.classList.remove("listening");
      if (statusBadge) statusBadge.style.display = "none";
      if (inputEl.value.trim()) {
        toast("Đã ghi nhận giọng nói! Bấm 'AI Điền' để tự động hoàn tất.");
      }
    };

    micBtn.addEventListener("click", () => {
      if (isListening) {
        speechRecog.stop();
      } else {
        try {
          inputEl.value = "";
          speechRecog.start();
        } catch (err) {
          console.warn("Speech start error:", err);
        }
      }
    });
  } else {
    micBtn.title = "Trình duyệt chưa hỗ trợ micro trực tiếp - vui lòng gõ nội dung";
    micBtn.addEventListener("click", () => {
      inputEl.focus();
      toast("Trình duyệt chưa hỗ trợ Web Speech API, bạn có thể gõ nội dung vào ô nhé!");
    });
  }

  // Xử lý gửi cho Gemini AI phân tích
  fillBtn.addEventListener("click", async () => {
    const text = inputEl.value.trim();
    if (!text) {
      toast("Vui lòng nói hoặc nhập thông tin chi phí trước khi bấm Điền", true);
      inputEl.focus();
      return;
    }

    fillBtn.disabled = true;
    fillBtn.innerHTML = `<svg class="ic" style="width:18px;height:18px;animation:pulse .6s infinite"><use href="#i-sparkles"/></svg><span>Đang tính…</span>`;
    if (summaryBox) summaryBox.style.display = "none";

    try {
      const res = await fetch("/api/ai-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          currentMonth: editKey,
          currentYear: parseKey(editKey).y,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Không thể phân tích dữ liệu");
      }

      applyAIResult(data);

      if (summaryBox && data.summary) {
        summaryBox.style.display = "block";
        summaryBox.innerHTML = `<b>✨ AI đã nhận diện:</b> ${esc(data.summary)}`;
      }

      toast("AI đã phân tích và tự động điền các khoản chi phí!");
    } catch (err) {
      console.error("AI fill error:", err);
      toast(`Lỗi AI: ${err.message}`, true);
    } finally {
      fillBtn.disabled = false;
      fillBtn.innerHTML = `<svg class="ic" style="width:18px;height:18px"><use href="#i-sparkles"/></svg><span>AI Điền</span>`;
    }
  });

  // Enter trong ô textarea để kích hoạt AI điền
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      fillBtn.click();
    }
  });
}

/* =========================================================
   TRANG TỔNG QUAN
   ========================================================= */
let dashYear = today().getFullYear();
const CAT = [
  { key: "rent", name: "Tiền trọ", cls: "s1" },
  { key: "electric", name: "Tiền điện", cls: "s2" },
  { key: "water", name: "Tiền nước", cls: "s3" },
  { key: "other", name: "Khoản khác", cls: "s4" },
];
const partsOf = r => r ? [r.rent, r.electric, r.water, othersSum(r)] : [0, 0, 0, 0];
const signed = v => v > 0 ? "+" + money(v) : v < 0 ? "−" + money(-v) : "0 đ";

function renderDash() {
  const t = today();
  $("#dashSub").textContent = `Hôm nay: ${WEEKDAYS[t.getDay()]}, ${fmtDate(isoDate(t))}`;
  renderHero(); renderCompare(); renderChart(); renderStats();
}

function renderHero() {
  const key = todayKey(), r = S.records[key], el = $("#heroCard");
  if (!r) {
    const p = prevRecord(key), d = dueInfo(key);
    el.innerHTML = `
      <div class="hero-top"><div class="hero-label">Tháng ${monthLabel(key)}</div>${statusBadge(null)}</div>
      <div class="empty">${ico("edit")}<b>Chưa nhập chi phí tháng này</b>
        <p>${p ? `Tháng ${monthLabel(p.month)} bạn đã chi ${money(totalOf(p))}. Tiền trọ sẽ được tự điền sẵn.` : "Bắt đầu ghi chép tiền trọ, điện, nước của bạn."}</p>
        <button type="button" class="btn btn-primary" data-act="open" data-key="${key}">${ico("plus")}Nhập chi phí tháng ${parseKey(key).m}</button>
      </div>
      <div class="alert ${d.kind === "bad" ? "bad" : d.kind === "warn" ? "warn" : "warn"}" style="${d.kind === "info" ? "background:var(--surface-2);color:var(--text-2)" : ""}">${ico("clock")}<span>${d.text}</span></div>`;
    return;
  }
  const total = totalOf(r), parts = partsOf(r), d = dueInfo(key);
  const items = [
    { n: "Tiền trọ", v: r.rent, c: "s1" },
    { n: "Tiền điện", v: r.electric, c: "s2", s: usage(r.elecMeter) != null ? `${numVN(usage(r.elecMeter))} kWh · ${numVN(r.elecMeter.old)} → ${numVN(r.elecMeter.new)}` : "" },
    { n: "Tiền nước", v: r.water, c: "s3", s: usage(r.waterMeter) != null ? `${numVN(usage(r.waterMeter))} m³ · ${numVN(r.waterMeter.old)} → ${numVN(r.waterMeter.new)}` : "" },
    ...r.others.map(o => ({ n: o.name, v: o.amount, c: "s4" })),
  ];
  const seg = total > 0 ? parts.map((v, i) => v > 0 ? `<span style="width:${(v / total * 100).toFixed(2)}%;background:var(--${CAT[i].cls})" title="${CAT[i].name}: ${money(v)}"></span>` : "").join("") : "";
  const [intPart] = [group(total)];
  el.innerHTML = `
    <div class="hero-top"><div class="hero-label">Tháng ${monthLabel(key)} · tổng cộng</div>${statusBadge(r)}</div>
    <div class="hero-total">${intPart}<small>đ</small></div>
    <div class="hero-meta">${r.people > 1 ? `<span>${ico("users", "ic")} Mỗi người (${r.people}): <b>${money(Math.round(total / r.people))}</b></span>` : ""}</div>
    <div class="segbar" role="img" aria-label="Tỉ lệ các khoản">${seg}</div>
    <ul class="breakdown">${items.map(it => `<li><i class="dot ${it.c}"></i><span class="nm">${esc(it.n)}${it.s ? `<small>${it.s}</small>` : ""}</span><span class="amt num">${money(it.v)}</span></li>`).join("")}</ul>
    ${r.note ? `<div class="hint" style="margin-top:4px">📝 ${esc(r.note)}</div>` : ""}
    <div class="alert ${d.kind === "good" ? "good" : d.kind === "bad" ? "bad" : "warn"}">${ico(d.kind === "good" ? "check" : d.kind === "bad" ? "alert" : "clock")}<span>${d.text}</span></div>
    <div class="hero-actions">
      ${!r.paid ? `<button type="button" class="btn btn-good" data-act="markpaid" data-key="${key}">${ico("check")}Đánh dấu đã đóng</button>` : ""}
      <button type="button" class="btn btn-ghost" data-act="open" data-key="${key}">${ico("edit")}Sửa</button>
      <button type="button" class="btn btn-ghost" data-act="share" data-key="${key}">${ico("share")}Chia sẻ</button>
    </div>`;
  $$(".hero-meta svg", el).forEach(s => { s.style.width = "16px"; s.style.height = "16px"; s.style.verticalAlign = "-3px"; });
}

function renderCompare() {
  const el = $("#cmpCard"), tk = todayKey();
  let baseKey = S.records[tk] ? tk : sortedKeys().filter(k => k <= tk).pop();
  const head = sub => `<div class="card-title">So với tháng trước<span class="sub">${sub}</span></div>`;
  if (!baseKey) { el.innerHTML = head("") + `<div class="empty" style="padding:10px">Chưa có dữ liệu để so sánh.</div>`; return; }
  const pk = shiftKey(baseKey, -1), a = S.records[baseKey], b = S.records[pk];
  if (!b) { el.innerHTML = head(`T${parseKey(baseKey).m} so với T${parseKey(pk).m}`) + `<div class="empty" style="padding:10px">Chưa có dữ liệu tháng ${monthLabel(pk)} để so sánh.</div>`; return; }
  const ta = totalOf(a), tb = totalOf(b), diff = ta - tb;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const pct = tb > 0 ? Math.abs(diff) / tb * 100 : 0;
  const pa = partsOf(a), pb = partsOf(b);
  const word = dir === "up" ? "Tăng" : dir === "down" ? "Giảm" : "Không đổi";
  const ue = usage(a.elecMeter), ub = usage(b.elecMeter);
  el.innerHTML = head(`T${parseKey(baseKey).m}/${parseKey(baseKey).y} so với T${parseKey(pk).m}/${parseKey(pk).y}`) + `
    <div class="cmp-main">
      <div class="cmp-arrow ${dir}"><span class="${dir}">${ico(dir === "up" ? "trend-up" : dir === "down" ? "trend-down" : "minus")}</span></div>
      <div><div class="cmp-val ${dir}">${signed(diff)}</div>
      <div class="cmp-sub">${word}${dir !== "flat" && tb > 0 ? ` ${numVN(pct, 1)}%` : ""} · tháng trước ${money(tb)}</div></div>
    </div>
    <ul class="cmp-list">${CAT.map((c, i) => { const d = pa[i] - pb[i], k = d > 0 ? "up" : d < 0 ? "down" : "flat";
      return `<li><div class="t"><i class="dot ${c.cls}"></i>${c.name}</div><div class="v ${k}">${d === 0 ? "Không đổi" : signed(d)}</div></li>`; }).join("")}</ul>
    ${ue != null && ub != null ? `<div class="hint" style="margin-top:10px">${ico("bolt")} Điện dùng ${numVN(ue)} kWh, ${ue === ub ? "bằng tháng trước" : (ue > ub ? "nhiều hơn " : "ít hơn ") + numVN(Math.abs(ue - ub)) + " kWh"}</div>` : ""}`;
  $$(".hint svg", el).forEach(s => { s.style.width = "15px"; s.style.height = "15px"; s.style.verticalAlign = "-3px"; });
}

/* ===== Biểu đồ cột chồng 12 tháng (SVG thuần) ===== */
function niceScale(max) {
  if (max <= 0) return { step: 500000, top: 2000000 };
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { step, top: Math.ceil(max / step) * step };
}
let tipIndex = -1, chartData = [];
function renderChart() {
  const wrap = $("#chartWrap");
  let holder = $("#chartSvg");
  if (!holder) { holder = document.createElement("div"); holder.id = "chartSvg"; wrap.prepend(holder); }
  $("#chartYear").textContent = dashYear;
  const W = Math.max(280, Math.round(wrap.clientWidth || 320)), H = 230, M = { l: 40, r: 6, t: 18, b: 28 };
  const cy = today().getFullYear(), cm = today().getMonth() + 1;
  chartData = Array.from({ length: 12 }, (_, i) => { const k = keyOf(dashYear, i + 1), r = S.records[k]; return { k, r, parts: partsOf(r), total: totalOf(r) }; });
  const max = Math.max(0, ...chartData.map(d => d.total));
  const { step, top } = niceScale(max);
  const pw = W - M.l - M.r, ph = H - M.t - M.b, base = M.t + ph, band = pw / 12, bw = Math.min(24, band * 0.62);
  const sy = v => base - v / top * ph;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Biểu đồ cột chi phí các tháng năm ${dashYear}">`;
  // nền tháng hiện tại
  if (dashYear === cy) s += `<rect class="ch-band" x="${M.l + band * (cm - 1) + 1}" y="${M.t - 10}" width="${band - 2}" height="${ph + 10}" rx="8" opacity=".7"/>`;
  // lưới + nhãn trục Y
  for (let v = 0; v <= top + 1e-6; v += step) {
    const y = Math.round(sy(v)) + .5;
    s += `<line class="${v === 0 ? "ch-base" : "ch-grid"}" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/>`;
    s += `<text class="ch-tick num" x="${M.l - 6}" y="${y + 4}" text-anchor="end">${v === 0 ? "0" : compact(v)}</text>`;
  }
  // cột
  const maxIdx = max > 0 ? chartData.findIndex(d => d.total === max) : -1;
  chartData.forEach((d, i) => {
    const x = M.l + band * i + (band - bw) / 2;
    s += `<g class="col" data-i="${i}">`;
    if (d.total > 0) {
      let cur = base; const segs = [];
      d.parts.forEach((v, j) => { if (v > 0) { const h = v / top * ph; segs.push({ j, y0: cur - h, y1: cur }); cur -= h; } });
      segs.forEach((g, n) => {
        const isTop = n === segs.length - 1;
        const y0 = isTop ? g.y0 : Math.min(g.y1, g.y0 + 2); // khe 2px giữa các phần
        const h = g.y1 - y0; if (h <= 0.3) return;
        if (isTop) {
          const r = Math.min(4, h, bw / 2);
          s += `<path class="c${g.j + 1}" d="M${x},${g.y1} V${y0 + r} A${r},${r} 0 0 1 ${x + r},${y0} H${x + bw - r} A${r},${r} 0 0 1 ${x + bw},${y0 + r} V${g.y1} Z"/>`;
        } else s += `<rect class="c${g.j + 1}" x="${x}" y="${y0}" width="${bw}" height="${h}"/>`;
      });
      if (i === maxIdx) s += `<text class="ch-tick num" x="${x + bw / 2}" y="${sy(d.total) - 5}" text-anchor="middle" style="fill:var(--text-2);font-weight:600">${compact(d.total)}</text>`;
    }
    s += `</g>`;
    const lbl = band < 26 ? String(i + 1) : "T" + (i + 1);
    s += `<text class="ch-x${dashYear === cy && i + 1 === cm ? " cur" : ""}" x="${M.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
  });
  if (max === 0) s += `<text class="ch-empty" x="${M.l + pw / 2}" y="${M.t + ph / 2}" text-anchor="middle">Chưa có dữ liệu năm ${dashYear}</text>`;
  // vùng bấm (lớn hơn cột)
  chartData.forEach((d, i) => {
    const lab = `Tháng ${i + 1}/${dashYear}: ${d.r ? money(d.total) + (d.r.paid ? ", đã đóng" : ", chưa đóng") : "chưa nhập"}`;
    s += `<rect class="bar-hit" data-i="${i}" x="${M.l + band * i}" y="${M.t - 10}" width="${band}" height="${ph + M.b + 10}" tabindex="0" role="button" aria-label="${lab}"/>`;
  });
  s += `</svg>`;
  holder.innerHTML = s;
  holder._geo = { M, band, bw, sy, W };
  hideTip();
  renderChartTable();
}
function showTip(i) {
  const d = chartData[i], tip = $("#chartTip"), g = $("#chartSvg")._geo; if (!d) return;
  tipIndex = i;
  $$("#chartSvg .col").forEach(c => c.classList.toggle("dim", +c.dataset.i !== i));
  tip.innerHTML = `<b>Tháng ${i + 1}/${dashYear}</b>` + (d.r
    ? CAT.map((c, j) => d.parts[j] > 0 ? `<div class="r"><span><i class="dot ${c.cls}"></i>${c.name}</span><span class="num">${money(d.parts[j])}</span></div>` : "").join("")
      + `<div class="r tot"><span>Tổng</span><span class="num">${money(d.total)}</span></div>`
      + `<div class="r" style="margin-top:4px"><span>${d.r.paid ? "✓ Đã đóng" : "• Chưa đóng"}</span></div>`
    : `<div class="r">Chưa nhập dữ liệu</div>`)
    + `<div class="hint" style="margin-top:4px">Bấm lần nữa để mở</div>`;
  tip.classList.add("show");
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const cx = g.M.l + g.band * i + g.band / 2;
  let left = Math.max(0, Math.min(g.W - tw, cx - tw / 2));
  let top = Math.max(-8, g.sy(d.total) - th - 12);
  tip.style.left = left + "px"; tip.style.top = top + "px";
}
function hideTip() { tipIndex = -1; $("#chartTip")?.classList.remove("show"); $$("#chartSvg .col").forEach(c => c.classList.remove("dim")); }
function bindChart() {
  const wrap = $("#chartWrap");
  wrap.addEventListener("pointerover", e => { const h = e.target.closest(".bar-hit"); if (h && e.pointerType === "mouse") showTip(+h.dataset.i); });
  wrap.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") hideTip(); });
  wrap.addEventListener("click", e => {
    const h = e.target.closest(".bar-hit"); if (!h) return;
    const i = +h.dataset.i;
    if (tipIndex === i) openMonth(chartData[i].k); else showTip(i);
  });
  let lastPointer = 0;
  wrap.addEventListener("pointerdown", () => { lastPointer = Date.now(); });
  wrap.addEventListener("focusin", e => { const h = e.target.closest(".bar-hit"); if (h && Date.now() - lastPointer > 600) showTip(+h.dataset.i); });
  wrap.addEventListener("focusout", hideTip);
  wrap.addEventListener("keydown", e => { const h = e.target.closest(".bar-hit"); if (h && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMonth(chartData[+h.dataset.i].k); } });
  document.addEventListener("click", e => { if (!e.target.closest("#chartWrap")) hideTip(); });
  $("#chartPrev").addEventListener("click", () => { dashYear--; renderChart(); renderStats(); });
  $("#chartNext").addEventListener("click", () => { dashYear++; renderChart(); renderStats(); });
  $("#tblToggle").addEventListener("click", e => {
    const t = $("#chartTable"), open = t.hidden; t.hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", open); e.currentTarget.textContent = open ? "Ẩn bảng" : "Xem dạng bảng";
  });
  let rt, lastW = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => {
    const w = $("#chartWrap").clientWidth; if (currentPage === "dash" && w !== lastW) { lastW = w; renderChart(); }
  }, 150); });
}
function renderChartTable() {
  const rows = chartData.filter(d => d.r);
  const sum = j => rows.reduce((a, d) => a + d.parts[j], 0);
  $("#chartTable").innerHTML = rows.length ? `<table class="data num"><thead><tr><th>Tháng</th><th>Trọ</th><th>Điện</th><th>Nước</th><th>Khác</th><th>Tổng</th></tr></thead><tbody>
    ${rows.map(d => `<tr><td>T${parseKey(d.k).m}</td>${d.parts.map(v => `<td>${group(v)}</td>`).join("")}<td><b>${group(d.total)}</b></td></tr>`).join("")}
    </tbody><tfoot><tr><td><b>Cả năm</b></td>${[0, 1, 2, 3].map(j => `<td><b>${group(sum(j))}</b></td>`).join("")}<td><b>${group(rows.reduce((a, d) => a + d.total, 0))}</b></td></tr></tfoot></table>`
    : `<div class="hint">Chưa có dữ liệu năm ${dashYear}.</div>`;
}

function renderStats() {
  const y = dashYear, recs = Object.values(S.records).filter(r => parseKey(r.month).y === y).sort((a, b) => a.month < b.month ? -1 : 1);
  const el = $("#statsCard");
  if (!recs.length) { el.innerHTML = `<div class="card-title">Thống kê năm ${y}</div><div class="empty" style="padding:10px">Chưa có dữ liệu năm ${y}.</div>`; return; }
  const totals = recs.map(totalOf), sum = totals.reduce((a, b) => a + b, 0), avg = Math.round(sum / recs.length);
  const maxR = recs[totals.indexOf(Math.max(...totals))], minR = recs[totals.indexOf(Math.min(...totals))];
  const sumK = k => recs.reduce((a, r) => a + r[k], 0);
  const kwh = recs.reduce((a, r) => a + (usage(r.elecMeter) || 0), 0), m3 = recs.reduce((a, r) => a + (usage(r.waterMeter) || 0), 0);
  const unpaid = recs.filter(r => !r.paid), unpaidSum = unpaid.reduce((a, r) => a + totalOf(r), 0);
  el.innerHTML = `<div class="card-title">Thống kê năm ${y}<span class="sub">${recs.length}/12 tháng đã nhập</span></div>
    <div class="stats">
      <div class="stat"><div class="l">Tổng chi cả năm</div><div class="v">${money(sum)}</div><div class="s">${recs.length} tháng</div></div>
      <div class="stat"><div class="l">Trung bình mỗi tháng</div><div class="v">${money(avg)}</div><div class="s">Ước cả năm ≈ ${compact(avg * 12)}</div></div>
      <div class="stat"><div class="l">Tháng cao nhất</div><div class="v">${money(totalOf(maxR))}</div><div class="s">Tháng ${parseKey(maxR.month).m}</div></div>
      <div class="stat"><div class="l">Tháng thấp nhất</div><div class="v">${money(totalOf(minR))}</div><div class="s">Tháng ${parseKey(minR.month).m}</div></div>
      <div class="stat"><div class="l"><i class="dot s2"></i> Tổng tiền điện</div><div class="v">${money(sumK("electric"))}</div><div class="s">${kwh ? numVN(kwh) + " kWh" : "TB " + money(Math.round(sumK("electric") / recs.length)) + "/tháng"}</div></div>
      <div class="stat"><div class="l"><i class="dot s3"></i> Tổng tiền nước</div><div class="v">${money(sumK("water"))}</div><div class="s">${m3 ? numVN(m3) + " m³" : "TB " + money(Math.round(sumK("water") / recs.length)) + "/tháng"}</div></div>
      <div class="stat wide" style="${unpaid.length ? "background:var(--bad-soft)" : "background:var(--good-soft)"}">
        <div class="l">${unpaid.length ? "Còn chưa đóng" : "Tình trạng thanh toán"}</div>
        <div class="v ${unpaid.length ? "up" : "down"}">${unpaid.length ? `${unpaid.length} tháng · ${money(unpaidSum)}` : "✓ Đã đóng đủ"}</div>
        ${unpaid.length ? `<div class="s">${unpaid.map(r => "T" + parseKey(r.month).m).join(", ")}</div>` : ""}
      </div>
    </div>`;
}

function bindDash() {
  $("#page-dash").addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const key = b.dataset.key;
    if (b.dataset.act === "open") openMonth(key);
    if (b.dataset.act === "share") shareMonth(key);
    if (b.dataset.act === "markpaid") {
      const r = S.records[key]; if (!r) return;
      r.paid = true; r.paidDate = isoDate(today()); r.updatedAt = new Date().toISOString(); persist();
      syncRecordToCloud(r);
      if (editKey === key) { if (dirty) setPaid(true, r.paidDate); else loadForm(key); }
      toast(`Đã đánh dấu đóng tiền tháng ${monthLabel(key)}`); renderDash();
    }
  });
}

/* =========================================================
   LỊCH NĂM
   ========================================================= */
let calYear = today().getFullYear();
function renderCal() {
  const t = today(), ty = t.getFullYear(), tm = t.getMonth() + 1, td = t.getDate();
  $("#calYear").textContent = calYear;
  let paid = 0, unpaid = 0, none = 0, html = "";
  for (let m = 1; m <= 12; m++) {
    const k = keyOf(calYear, m), r = S.records[k];
    const st = !r ? "none" : r.paid ? "paid" : "unpaid";
    st === "paid" ? paid++ : st === "unpaid" ? unpaid++ : none++;
    const stTxt = st === "paid" ? "đã đóng" : st === "unpaid" ? "chưa đóng" : "chưa nhập";
    const offset = (new Date(calYear, m - 1, 1).getDay() + 6) % 7, dim = daysIn(calYear, m);
    const due = Math.min(S.settings.dueDay, dim);
    const paidDay = r?.paid && r.paidDate?.startsWith(k) ? +r.paidDate.slice(8, 10) : 0;
    let days = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map(w => `<span class="wd">${w}</span>`).join("");
    days += "<span></span>".repeat(offset);
    for (let d = 1; d <= dim; d++) {
      const cls = ["d"];
      if ((offset + d - 1) % 7 === 6) cls.push("sun");
      if (calYear === ty && m === tm && d === td) cls.push("today");
      else if (d === paidDay) cls.push("paid-day");
      if (d === due && st !== "paid") cls.push("due");
      days += `<span class="${cls.join(" ")}">${d}</span>`;
    }
    const isCur = calYear === ty && m === tm;
    html += `<button type="button" class="mcal${isCur ? " current" : ""}" data-key="${k}" aria-label="Tháng ${m}/${calYear}, ${stTxt}${r ? ", " + money(totalOf(r)) : ""}">
      <div class="mcal-head"><b>Tháng ${m}</b><i class="sdot ${st}" title="${stTxt}"></i></div>
      <div class="mcal-amt num ${r ? "" : "none"}">${r ? money(totalOf(r)) : "Chưa nhập"}</div>
      <div class="mdays" aria-hidden="true">${days}</div>
    </button>`;
  }
  $("#calGrid").innerHTML = html;
  $("#calSub").textContent = `Đã đóng ${paid} · Chưa đóng ${unpaid} · Chưa nhập ${none}`;
}
function bindCal() {
  $("#calGrid").addEventListener("click", e => { const b = e.target.closest(".mcal"); if (b) openMonth(b.dataset.key); });
  $("#calPrev").addEventListener("click", () => { calYear--; renderCal(); });
  $("#calNext").addEventListener("click", () => { calYear++; renderCal(); });
  $("#calToday").addEventListener("click", () => { calYear = today().getFullYear(); renderCal(); });
}

/* =========================================================
   LỊCH SỬ & DỮ LIỆU
   ========================================================= */
function renderHist() {
  const ySel = $("#hYear"), prevVal = ySel.value || String(today().getFullYear());
  const ys = dataYears().reverse();
  ySel.innerHTML = `<option value="all">Tất cả các năm</option>` + ys.map(y => `<option value="${y}">Năm ${y}</option>`).join("");
  ySel.value = [...ySel.options].some(o => o.value === prevVal) ? prevVal : "all";
  const fy = ySel.value, fs = $("#hStatus").value;
  const list = sortedKeys().reverse().map(k => S.records[k])
    .filter(r => (fy === "all" || parseKey(r.month).y === +fy) && (fs === "all" || (fs === "paid") === r.paid));
  const sum = list.reduce((a, r) => a + totalOf(r), 0);
  $("#histSum").innerHTML = list.length ? `<span>${list.length} tháng</span><span>Tổng: <b class="num">${money(sum)}</b></span><span>TB: <b class="num">${money(Math.round(sum / list.length))}</b>/tháng</span>` : "";
  $("#histList").innerHTML = list.length ? list.map(r => {
    const { y, m } = parseKey(r.month);
    const extra = r.others.length ? ` · +${r.others.length} khoản khác` : "";
    return `<button type="button" class="hist-item" data-key="${r.month}">
      <div class="hist-month"><div><b>${pad(m)}</b><small>${y}</small></div></div>
      <div class="hist-body"><div class="t">${money(totalOf(r))}</div>
        <div class="s">Trọ ${group(r.rent)} · Điện ${group(r.electric)} · Nước ${group(r.water)}${extra}</div>
        ${r.note ? `<div class="s">📝 ${esc(r.note)}</div>` : ""}</div>
      ${statusBadge(r)}
    </button>`;
  }).join("") : `<div class="card empty">${ico("list")}<b>${Object.keys(S.records).length ? "Không có tháng nào khớp bộ lọc" : "Chưa có dữ liệu"}</b>
      <p>${Object.keys(S.records).length ? "Thử đổi năm hoặc trạng thái." : "Hãy nhập chi phí tháng đầu tiên của bạn."}</p>
      ${Object.keys(S.records).length ? "" : `<button type="button" class="btn btn-primary" id="histStart">${ico("plus")}Nhập chi phí</button>`}</div>`;
  $("#dataCount").textContent = `${Object.keys(S.records).length} tháng đã lưu`;
  $("#sDueDay").value = S.settings.dueDay;
  $("#sPeople").value = S.settings.people;
  renderCloudUI();
}

function renderCloudUI() {
  const badge = $("#cloudBadge");
  const userBox = $("#cloudUserBox");
  const actions = $("#cloudActions");
  const topBtn = $("#cloudTopBtn");
  const topIco = $("#cloudTopIco");

  if (!badge || !userBox || !actions) return;

  if (SyncState.currentUser) {
    const u = SyncState.currentUser;
    const name = u.displayName || u.email || "Người dùng";
    const statusText = SyncState.status === 'syncing' ? 'Đang đồng bộ…' : SyncState.status === 'error' ? 'Lỗi kết nối' : 'Đã kết nối';
    const badgeClass = SyncState.status === 'syncing' ? 'warn' : SyncState.status === 'error' ? 'unpaid' : 'paid';

    badge.className = `badge ${badgeClass}`;
    badge.textContent = statusText;

    userBox.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0">
        ${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">` : `<div class="brand-logo" style="width:36px;height:36px;border-radius:50%;font-size:15px;font-weight:700">${esc(name.slice(0, 1).toUpperCase())}</div>`}
        <div style="min-width:0;flex:1">
          <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
          <div style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.email || "")}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">
        ${SyncState.lastSyncedAt ? `Đã đồng bộ lúc: ${SyncState.lastSyncedAt.toLocaleTimeString('vi-VN')} · ${SyncState.lastSyncedAt.toLocaleDateString('vi-VN')}` : 'Đang thiết lập đồng bộ thời gian thực qua Firestore...'}
      </div>
    `;

    actions.innerHTML = `
      <button type="button" class="btn btn-primary" id="btnSyncNow"><svg class="ic"><use href="#i-refresh"/></svg>Đồng bộ ngay</button>
      <button type="button" class="btn btn-ghost" id="btnLogoutCloud">Đăng xuất</button>
    `;

    if (topBtn) {
      topBtn.title = `Firestore: Đã kết nối (${u.email})`;
      topBtn.style.color = "var(--accent)";
    }
  } else {
    badge.className = "badge none";
    badge.textContent = "Chưa kết nối";

    userBox.innerHTML = `
      <div style="padding:4px 0">
        Dữ liệu hiện đang lưu cục bộ trên trình duyệt. Kết nối tài khoản Google để lưu trữ đám mây và đồng bộ nhiều thiết bị.
      </div>
    `;

    actions.innerHTML = `
      <button type="button" class="btn btn-primary full" id="btnLoginCloud">
        <svg class="ic" viewBox="0 0 24 24"><path fill="currentColor" d="M21.35 11.1h-9.17v2.73h5.27c-.23 1.2-1.37 3.53-5.27 3.53-3.17 0-5.76-2.58-5.76-5.76s2.59-5.76 5.76-5.76c1.8 0 3.01.77 3.7 1.43l2.16-2.08C21.94 3.73 19.34 2.5 15.68 2.5 9.77 2.5 5 7.27 5 13.18s4.77 10.68 10.68 10.68c6.16 0 10.25-4.33 10.25-10.43 0-.7-.08-1.22-.18-1.73z"/></svg>
        Đăng nhập Google để đồng bộ
      </button>
    `;

    if (topBtn) {
      topBtn.title = "Đồng bộ Firestore (Chưa kết nối)";
      topBtn.style.color = "";
    }
  }

  // Bind cloud action buttons
  const btnLogin = $("#btnLoginCloud");
  if (btnLogin) {
    btnLogin.onclick = async () => {
      try {
        toast("Đang mở đăng nhập Google…");
        await loginWithGoogle();
        toast("Đăng nhập thành công! Đang tải dữ liệu từ Firestore…");
      } catch (err) {
        toast(`Lỗi đăng nhập: ${err.message || "Không thể đăng nhập"}`, true);
      }
    };
  }

  const btnLogout = $("#btnLogoutCloud");
  if (btnLogout) {
    btnLogout.onclick = async () => {
      const ok = await dialog({
        title: "Đăng xuất tài khoản?",
        message: "Dữ liệu hiện tại trên máy vẫn sẽ được giữ lại trong bộ nhớ trình duyệt.",
        buttons: [{ text: "Huỷ", value: null }, { text: "Đăng xuất", value: true, cls: "btn-ghost" }]
      });
      if (ok) {
        await logoutUser();
        toast("Đã đăng xuất");
        renderCloudUI();
      }
    };
  }

  const btnSyncNow = $("#btnSyncNow");
  if (btnSyncNow) {
    btnSyncNow.onclick = async () => {
      toast("Đang đồng bộ dữ liệu lên Firestore…");
      const keys = Object.keys(S.records);
      for (const k of keys) {
        await syncRecordToCloud(S.records[k]);
      }
      await syncSettingsToCloud(S.settings);
      toast("Đã đồng bộ xong toàn bộ dữ liệu!");
      renderCloudUI();
    };
  }
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const stamp = () => isoDate(new Date());
function exportCSV() {
  const keys = sortedKeys();
  if (!keys.length) return toast("Chưa có dữ liệu để xuất", true);
  const q = v => { const s = String(v ?? ""); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["Tháng", "Tiền trọ", "Tiền điện", "Số điện cũ", "Số điện mới", "Số kWh", "Tiền nước", "Số nước cũ", "Số nước mới", "Số m³", "Khoản khác (chi tiết)", "Tiền khoản khác", "Tổng cộng", "Số người", "Mỗi người", "Trạng thái", "Ngày đóng", "Ghi chú"];
  const rows = keys.map(k => {
    const r = S.records[k], e = r.elecMeter?.on ? r.elecMeter : null, w = r.waterMeter?.on ? r.waterMeter : null, t = totalOf(r);
    return [`Tháng ${pad(parseKey(k).m)}/${parseKey(k).y}`, r.rent, r.electric, e?.old ?? "", e?.new ?? "", usage(e) ?? "", r.water, w?.old ?? "", w?.new ?? "", usage(w) ?? "",
      r.others.map(o => `${o.name}: ${o.amount}`).join(" | "), othersSum(r), t, r.people, Math.round(t / r.people),
      r.paid ? "Đã đóng" : "Chưa đóng", fmtDate(r.paidDate), r.note];
  });
  const csv = "﻿" + [head, ...rows].map(r => r.map(q).join(",")).join("\r\n");
  download(`so-tien-tro-${stamp()}.csv`, csv, "text/csv;charset=utf-8");
  toast("Đã xuất file CSV");
}
function exportJSON() {
  if (!Object.keys(S.records).length) return toast("Chưa có dữ liệu để xuất", true);
  const data = { app: "so-tien-tro", exportedAt: new Date().toISOString(), ...S };
  download(`so-tien-tro-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
  toast("Đã xuất file JSON");
}
async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { return toast("File không phải JSON hợp lệ", true); }
  const incoming = normState(data), n = Object.keys(incoming.records).length;
  if (!n) return toast("Không tìm thấy dữ liệu chi phí trong file", true);
  const have = Object.keys(S.records).length, dup = Object.keys(incoming.records).filter(k => S.records[k]).length;
  const choice = have ? await dialog({
    title: "Nhập dữ liệu từ file",
    message: `File có <b>${n} tháng</b>. Máy này đang có <b>${have} tháng</b>${dup ? ` (trùng ${dup} tháng)` : ""}.<br>Gộp: giữ dữ liệu hiện tại, tháng trùng lấy theo file. Thay thế: xoá dữ liệu hiện tại.`,
    buttons: [{ text: "Huỷ", value: null }, { text: "Thay thế", value: "replace", cls: "btn-danger" }, { text: "Gộp", value: "merge", cls: "btn-primary" }],
  }) : "replace";
  if (!choice) return;
  if (choice === "replace") S = incoming; else { Object.assign(S.records, incoming.records); }
  persist(); applyTheme(); fillSelects(); loadForm(editKey); renderHist();
  // Upload to cloud if signed in
  if (SyncState.currentUser) {
    for (const r of Object.values(incoming.records)) {
      syncRecordToCloud(r);
    }
  }
  toast(`Đã nhập ${n} tháng từ file`);
}
async function wipeAll() {
  const n = Object.keys(S.records).length;
  if (!n) return toast("Không có dữ liệu để xoá");
  const ok = await dialog({
    title: "Xoá toàn bộ dữ liệu?",
    message: `Toàn bộ <b>${n} tháng</b> đã ghi sẽ bị xoá vĩnh viễn khỏi trình duyệt này và không thể khôi phục. Nên <b>Xuất JSON</b> để sao lưu trước.`,
    input: { label: "Gõ XOA để xác nhận", validate: v => /^xo[aá]$/i.test(v.trim()) },
    buttons: [{ text: "Huỷ", value: null }, { text: "Xoá tất cả", value: true, cls: "btn-danger-solid" }],
  });
  if (!ok) return;
  const oldKeys = Object.keys(S.records);
  S.records = {}; persist(); loadForm(todayKey()); renderHist();
  if (SyncState.currentUser) {
    for (const k of oldKeys) {
      deleteRecordFromCloud(k);
    }
  }
  toast("Đã xoá toàn bộ dữ liệu");
}
function bindHist() {
  $("#hYear").addEventListener("change", renderHist);
  $("#hStatus").addEventListener("change", renderHist);
  $("#histList").addEventListener("click", e => {
    const b = e.target.closest(".hist-item"); if (b) return openMonth(b.dataset.key);
    if (e.target.closest("#histStart")) openMonth(todayKey());
  });
  $("#btnCsv").addEventListener("click", exportCSV);
  $("#btnJson").addEventListener("click", exportJSON);
  $("#btnImport").addEventListener("click", () => $("#fileImport").click());
  $("#fileImport").addEventListener("change", e => { const f = e.target.files[0]; if (f) importJSON(f); e.target.value = ""; });
  $("#btnWipe").addEventListener("click", wipeAll);
  $("#themeSeg").addEventListener("click", e => { const b = e.target.closest("[data-theme-set]"); if (b) setTheme(b.dataset.themeSet); });
  $("#sDueDay").addEventListener("change", e => {
    S.settings.dueDay = +e.target.value;
    persist();
    syncSettingsToCloud(S.settings);
    toast(`Hạn đóng tiền: ngày ${e.target.value} hằng tháng`);
  });
  $("#sPeople").addEventListener("change", e => {
    const v = Math.round(+e.target.value);
    if (v >= 1 && v <= 20) {
      S.settings.people = v;
      persist();
      syncSettingsToCloud(S.settings);
      toast("Đã lưu số người mặc định");
    } else {
      e.target.value = S.settings.people;
      toast("Số người phải từ 1 đến 20", true);
    }
  });
}

/* =========================================================
   MÁY TÍNH BỎ TÚI
   ========================================================= */
const Calc = {
  expr: "", done: false, result: null, hist: [],
  load() { try { this.hist = JSON.parse(localStorage.getItem(CALC_KEY) || "[]").slice(0, 30); } catch (e) { this.hist = []; } },
  saveHist() { try { localStorage.setItem(CALC_KEY, JSON.stringify(this.hist.slice(0, 30))); } catch (e) {} },
};
const isOp = c => "+-*/".includes(c);
const lastNum = s => (s.match(/[\d.]*$/) || [""])[0];

function evaluate(src) {
  const toks = src.match(/\d+\.?\d*|\.\d+|[+\-*/%]/g) || [];
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  function factor() {
    let sign = 1;
    while (peek() === "-" || peek() === "+") { if (next() === "-") sign = -sign; }
    const t = next();
    if (t == null || isNaN(Number(t))) throw new Error("Biểu thức chưa đúng");
    let v = sign * Number(t), pct = false;
    while (peek() === "%") { next(); v /= 100; pct = true; }
    return { v, pct };
  }
  function term() {
    let f = factor(), v = f.v, pctOnly = f.pct;
    while (peek() === "*" || peek() === "/") {
      const op = next(), r = factor().v; pctOnly = false;
      if (op === "/") { if (r === 0) throw new Error("Không thể chia cho 0"); v /= r; } else v *= r;
    }
    return { v, pctOnly };
  }
  let left = term().v;
  while (peek() === "+" || peek() === "-") {
    const op = next(), r = term();
    const val = r.pctOnly ? left * r.v : r.v;
    left = op === "+" ? left + val : left - val;
  }
  if (p < toks.length) throw new Error("Biểu thức chưa đúng");
  if (!isFinite(left)) throw new Error("Kết quả quá lớn");
  return Math.round(left * 1e8) / 1e8;
}
function prettyExpr(s) {
  return s.replace(/\d+(\.\d*)?|\.\d+/g, m => {
    const [i, d] = m.split(".");
    return (i ? group(Number(i)) : "0") + (d !== undefined ? "," + d : "");
  }).replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\+/g, " + ").replace(/-/g, " − ");
}
const fmtCalc = v => numVN(v, 8);

function calcPress(k) {
  let s = Calc.expr;
  if (/^\d$/.test(k) || k === "000") {
    if (Calc.done) s = "";
    const n = lastNum(s);
    if (k === "000") { if (!n || /^0*$/.test(n.replace(".", ""))) return calcRender(); }
    if (n === "0") s = s.slice(0, -1);
    if (n.replace(".", "").length >= 15) return calcRender();
    s += k;
  } else if (k === "," || k === ".") {
    if (Calc.done) s = "";
    const n = lastNum(s);
    if (n.includes(".")) return calcRender();
    s += n ? "." : "0.";
  } else if (isOp(k)) {
    if (Calc.done && Calc.result != null) s = String(Calc.result);
    if (!s) { if (k === "-") s = "-"; else s = "0" + k; }
    else {
      if (s.endsWith(".")) s = s.slice(0, -1);
      if (isOp(s.slice(-1))) s = s.length === 1 && k !== "-" ? "" : s.slice(0, -1) + k;
      else s += k;
    }
  } else if (k === "%") {
    if (Calc.done && Calc.result != null) s = String(Calc.result);
    if (/[\d.]$/.test(s) || s.endsWith("%")) s += "%";
  } else if (k === "back") {
    if (Calc.done) { s = Calc.result != null ? String(Calc.result) : ""; }
    s = s.slice(0, -1);
  } else if (k === "C") {
    s = ""; Calc.result = null;
  } else if (k === "=") {
    if (!s) return calcRender();
    try {
      const v = evaluate(s.replace(/[+\-*/.]+$/, ""));
      if (/[+\-*/%]/.test(s.replace(/^-/, ""))) { Calc.hist.unshift({ e: prettyExpr(s.replace(/[+\-*/.]+$/, "")), r: v }); Calc.hist = Calc.hist.slice(0, 30); Calc.saveHist(); renderCalcHist(); }
      Calc.result = v; Calc.expr = String(v); Calc.done = true;
      $("#calcExpr").textContent = prettyExpr(s.replace(/[+\-*/.]+$/, "")) + " =";
      $("#calcRes").className = "calc-res"; $("#calcRes").textContent = fmtCalc(v);
      return updateCalcUse();
    } catch (e) {
      $("#calcRes").className = "calc-res error"; $("#calcRes").textContent = e.message; return;
    }
  }
  Calc.expr = s; Calc.done = false;
  calcRender();
}
function calcRender() {
  const s = Calc.expr, res = $("#calcRes"), ex = $("#calcExpr");
  if (Calc.done) return;
  ex.textContent = prettyExpr(s);
  const body = s.replace(/[+\-*/.]+$/, "");
  let v = null;
  try { v = body && body !== "-" ? evaluate(body) : null; } catch (e) { v = null; }
  Calc.result = v;
  if (!s) { res.className = "calc-res"; res.textContent = "0"; ex.textContent = ""; }
  else if (/[+\-*/%]/.test(body.replace(/^-/, ""))) { res.className = "calc-res preview"; res.textContent = v != null ? "= " + fmtCalc(v) : ""; }
  else { res.className = "calc-res"; res.textContent = v != null ? fmtCalc(v) : "0"; ex.textContent = ""; }
  updateCalcUse();
}
function renderCalcHist() {
  $("#calcHistList").innerHTML = Calc.hist.length
    ? Calc.hist.map((h, i) => `<li><button type="button" data-h="${i}"><span class="e">${esc(h.e)} =</span><span class="r">${fmtCalc(h.r)}</span></button></li>`).join("")
    : `<li class="none">Chưa có phép tính nào</li>`;
}
const targetOk = () => calcTarget && document.body.contains(calcTarget) && calcTarget.offsetParent !== null && !calcTarget.readOnly;
function updateCalcUse() {
  const btn = $("#calcUse"), info = $("#calcTarget");
  if (targetOk()) {
    btn.innerHTML = `${ico("check")}Dùng kết quả`;
    info.textContent = `Sẽ chèn vào ô: ${calcTarget.dataset.label || "số tiền"}`;
  } else {
    btn.innerHTML = `${ico("copy")}Sao chép kết quả`;
    info.textContent = "Mẹo: chạm vào một ô số tiền trước khi mở máy tính để chèn kết quả trực tiếp";
  }
  btn.disabled = Calc.result == null;
}
function useCalcResult() {
  if (Calc.result == null) return;
  const v = Calc.result, rounded = Math.round(v);
  if (!targetOk()) { copyText(String(rounded === v ? v : v).replace(".", ",")).then(ok => toast(ok ? `Đã sao chép ${fmtCalc(v)}` : "Không sao chép được", !ok)); return; }
  const el = calcTarget;
  el.value = (rounded < 0 ? "-" : "") + group(Math.abs(rounded));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  closeCalc();
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  toast(rounded !== v ? `Đã làm tròn và chèn ${money(rounded)}` : rounded < 0 ? "Kết quả âm — số tiền không được âm" : `Đã chèn ${money(rounded)} vào ${el.dataset.label || "ô"}`, rounded < 0);
}

let calcOpenerFocus = null;
function openCalc() {
  calcOpenerFocus = document.activeElement;
  if (calcOpenerFocus?.blur) calcOpenerFocus.blur();
  const ov = $("#calcOverlay"); ov.classList.add("show"); ov.setAttribute("aria-hidden", "false");
  calcRender(); updateCalcUse(); renderCalcHist();
  setTimeout(() => $("#calcSheet").focus({ preventScroll: true }), 50);
}
function closeCalc() {
  const ov = $("#calcOverlay"); ov.classList.remove("show"); ov.setAttribute("aria-hidden", "true");
  $("#fab").focus({ preventScroll: true });
}
const calcIsOpen = () => $("#calcOverlay").classList.contains("show");
function flashKey(k) { const b = $(`#calcKeys [data-k="${CSS.escape(k)}"]`); if (b) { b.classList.add("pressed"); setTimeout(() => b.classList.remove("pressed"), 110); } }

function bindCalc() {
  Calc.load();
  $("#fab").addEventListener("pointerdown", e => e.preventDefault());
  $("#fab").addEventListener("click", () => calcIsOpen() ? closeCalc() : openCalc());
  $("#calcClose").addEventListener("click", closeCalc);
  $("#calcOverlay").addEventListener("click", e => { if (e.target.id === "calcOverlay") closeCalc(); });
  $("#calcKeys").addEventListener("click", e => { const b = e.target.closest("[data-k]"); if (b) { const k = b.dataset.k; calcPress(k === "×" ? "*" : k === "÷" ? "/" : k === "−" ? "-" : k); } });
  $("#calcUse").addEventListener("click", useCalcResult);
  $("#calcHistBtn").addEventListener("click", e => { const h = $("#calcHist"), open = !h.classList.contains("open"); h.classList.toggle("open", open); e.currentTarget.setAttribute("aria-expanded", open); });
  $("#calcHistClear").addEventListener("click", () => { Calc.hist = []; Calc.saveHist(); renderCalcHist(); });
  $("#calcHistList").addEventListener("click", e => {
    const b = e.target.closest("[data-h]"); if (!b) return;
    const h = Calc.hist[+b.dataset.h]; Calc.expr = String(h.r); Calc.result = h.r; Calc.done = true;
    $("#calcExpr").textContent = h.e + " ="; $("#calcRes").className = "calc-res"; $("#calcRes").textContent = fmtCalc(h.r); updateCalcUse();
  });
  document.addEventListener("keydown", e => {
    if (e.altKey && (e.key === "m" || e.key === "M" || e.code === "KeyM")) { e.preventDefault(); return calcIsOpen() ? closeCalc() : openCalc(); }
    if (!calcIsOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { "*": "*", "x": "*", "X": "*", "/": "/", ":": "/", "+": "+", "-": "-", "%": "%", ",": ",", ".": ",", "Enter": "=", "=": "=", "Backspace": "back", "Delete": "C", "c": "C", "C": "C" };
    let k = /^\d$/.test(e.key) ? e.key : map[e.key];
    if (e.key === "Escape") { e.preventDefault(); return closeCalc(); }
    if (e.key === "h" || e.key === "H") { e.preventDefault(); return $("#calcHistBtn").click(); }
    if (e.key === "Enter" && document.activeElement?.closest?.("#calcUse, #calcClose, #calcHistBtn, #calcHistList, #calcHistClear")) return;
    if (!k) return;
    e.preventDefault(); calcPress(k);
    flashKey(k === "*" ? "×" : k === "/" ? "÷" : k === "-" ? "−" : k);
  });
}

/* =========================================================
   KHỞI ĐỘNG
   ========================================================= */
function init() {
  const t = today();
  $("#todayLabel").textContent = `${WEEKDAYS[t.getDay()]}, ${fmtDate(isoDate(t))}`;
  applyTheme(); fillSelects();
  bindEntry(); bindAIAssistant(); bindDash(); bindChart(); bindCal(); bindHist(); bindCalc();
  $("#themeBtn").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));
  $$(".nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.nav)));
  
  // Cloud button in header -> go to cloud sync section
  const cloudTopBtn = $("#cloudTopBtn");
  if (cloudTopBtn) {
    cloudTopBtn.addEventListener("click", () => {
      go("hist");
      setTimeout(() => {
        $("#cloudSyncCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    });
  }

  document.addEventListener("focusin", e => { if (e.target.matches?.("[data-money]") && !e.target.readOnly) calcTarget = e.target; });
  loadForm(todayKey());
  go(location.hash.slice(1) || "dash", { push: false });

  // Thiết lập đồng bộ Firestore
  setSyncStatusListener(() => {
    renderCloudUI();
  });

  initSyncEngine({
    getLocalState: () => S,
    onCloudUpdated: (cloudRecords) => {
      let changed = false;
      for (const [k, cloudRec] of Object.entries(cloudRecords)) {
        const norm = normRecord(cloudRec, k);
        if (norm) {
          const current = S.records[k];
          if (!current || !current.updatedAt || new Date(norm.updatedAt) >= new Date(current.updatedAt)) {
            S.records[k] = norm;
            changed = true;
          }
        }
      }
      if (changed) {
        persist();
        if (currentPage === "dash") renderDash();
        if (currentPage === "cal") renderCal();
        if (currentPage === "hist") renderHist();
        if (currentPage === "entry" && !dirty) loadForm(editKey);
      }
    }
  });
}

init();
