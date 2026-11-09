import {
  SyncState,
  setSyncStatusListener,
  syncRecordToCloud,
  deleteRecordFromCloud,
  syncSettingsToCloud,
  initSyncEngine,
  loginWithGoogle,
  logoutUser,
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
   LƯU TRỮ (localStorage)
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
/** Chuẩn hoá 1 bản ghi (dùng cả khi nhập JSON) */
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
function setTheme(t) { S.settings.theme = t; persist(); applyTheme(); syncSettingsToCloud(S.settings); }
mqDark.addEventListener?.("change", () => { if (S.settings.theme === "auto") applyTheme(); });

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  $(".t-ic", t).innerHTML = ico(bad ? "alert" : "check");
  $(".t-msg", t).textContent = msg;
  t.classList.toggle("bad", !!bad); t.classList.add("show");
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
  requestAnimationFrame(moveNavInd);
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
    formOthers = r.others.map(o => ({ name: o.name, amount: group(o.amount) }));
    $("#fNote").value = r.note;
    setPaid(r.paid, r.paidDate);
    banner.className = "edit-banner";
    banner.innerHTML = `${ico("edit")}<span>Đang sửa tháng ${monthLabel(key)} đã lưu</span>`;
  } else {
    // Tháng mới: tiền trọ tự điền từ tháng trước
    setMoney($("#fRent"), prev ? prev.rent : "");
    if (prev) $("#hRent").textContent = `Đã tự điền từ tháng ${monthLabel(prev.month)}`;
    $("#fElec").value = ""; $("#fWater").value = "";
    formOthers = [];
    $("#fNote").value = "";
    setPaid(false, "");
    banner.className = "edit-banner new";
    banner.innerHTML = `${ico("plus")}<span>Tháng ${monthLabel(key)} chưa có dữ liệu — nhập mới</span>`;
  }
  $("#entryExtra").hidden = !r;
  renderOthers(); updateTotal(false);
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
  const set = new Set();
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

/* ===== Tổng tiền trực tiếp ===== */
let lastTotal = null;
function formTotal() {
  const v = id => Math.max(0, parseMoney($(id).value).value);
  const others = formOthers.reduce((a, o) => a + Math.max(0, parseMoney(o.amount).value), 0);
  return { total: v("#fRent") + v("#fElec") + v("#fWater") + others, others };
}
function updateTotal(anim = true) {
  const { total, others } = formTotal();
  const el = $("#liveTotal");
  el.textContent = money(total);
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
  const electric = checkMoney("#fElec", "#eElec", "Tiền điện"); if (electric === null) ok = false;
  const water = checkMoney("#fWater", "#eWater", "Tiền nước"); if (water === null) ok = false;
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
  if (!ok) return null;
  const old = S.records[editKey];
  return {
    month: editKey, rent, electric, water, elecMeter: null, waterMeter: null,
    others, note: $("#fNote").value.trim(), people: old?.people || 1, paid, paidDate: paid ? paidDate : "",
    createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}
function saveForm(e) {
  e?.preventDefault();
  const rec = validateAndBuild();
  if (!rec) {
    toast("Chưa lưu được — kiểm tra các ô báo đỏ", true);
    const first = $(".input.err"); first?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const isNew = !S.records[editKey], newlyPaid = rec.paid && !S.records[editKey]?.paid;
  S.records[editKey] = rec;
  if (newlyPaid) confettiFrom($("#btnSave"));
  if (persist()) {
    syncRecordToCloud(rec);
    toast(isNew ? `Đã lưu chi phí tháng ${monthLabel(editKey)}` : `Đã cập nhật tháng ${monthLabel(editKey)}`);
    loadForm(editKey);
  }
}
async function deleteCurrent() {
  if (!S.records[editKey]) return;
  const ok = await confirmDanger("Xoá tháng này?", `Dữ liệu chi phí tháng <b>${monthLabel(editKey)}</b> (${money(totalOf(S.records[editKey]))}) sẽ bị xoá vĩnh viễn.`);
  if (!ok) return;
  const key = editKey;
  delete S.records[key]; persist();
  deleteRecordFromCloud(key);
  toast(`Đã xoá tháng ${monthLabel(key)}`); loadForm(key);
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

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e2) {}
    ta.remove(); return ok;
  }
}
/* ===== Gắn sự kiện form ===== */
function bindEntry() {
  const form = $("#entryForm");
  form.addEventListener("submit", saveForm);
  form.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "fMonth" || t.id === "fYear" || t.id === "aiInputText") return; // không tính là sửa dữ liệu
    dirty = true;
    if (t.matches("[data-money]")) formatMoneyInput(t);
    if (t.matches(".input.err")) t.classList.remove("err");
    const row = t.closest(".other-item");
    if (row) {
      const i = +row.dataset.i;
      if (t.matches("[data-oname]")) { formOthers[i].name = t.value; $("[data-oamt]", row).dataset.label = t.value || "Khoản khác"; }
      if (t.matches("[data-oamt]")) formOthers[i].amount = t.value;
    }
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
  const pick = () => openMonth(keyOf(+$("#fYear").value, +$("#fMonth").value), false);
  $("#fMonth").addEventListener("change", pick); $("#fYear").addEventListener("change", pick);
  $("#mPrev").addEventListener("click", () => openMonth(shiftKey(editKey, -1), false));
  $("#mNext").addEventListener("click", () => openMonth(shiftKey(editKey, 1), false));
  $("#btnDelete").addEventListener("click", deleteCurrent);
  window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
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
  $("#dashSub").textContent = `${WEEKDAYS[t.getDay()]}, ${fmtDate(isoDate(t))}`;
  renderHero(); renderDetail(); renderCompare(); renderChart(true); renderStats();
}
function renderHero() {
  const key = todayKey(), r = S.records[key], el = $("#heroCard");
  if (!r) {
    const p = prevRecord(key);
    el.innerHTML = `
      <div class="hero-top"><div class="hero-label">${ico("cal")}Tháng ${monthLabel(key)}</div>${statusBadge(null)}</div>
      <div class="empty"><div class="em-ic">${ico("edit")}</div><b>Chưa nhập chi phí tháng này</b>
        <p>${p ? `Tháng ${monthLabel(p.month)}: ${money(totalOf(p))}` : "Bắt đầu ghi chép tiền trọ, điện, nước của bạn."}</p>
        <button type="button" class="btn" data-act="open" data-key="${key}">${ico("plus")}Nhập chi phí tháng ${parseKey(key).m}</button>
      </div>`;
    return;
  }
  const total = totalOf(r);
  const acts = r.paid
    ? [`<button type="button" class="btn main" data-act="open" data-key="${key}">${ico("edit")}Sửa</button>`,
       `<button type="button" class="btn" data-act="pdf" data-key="${key}">${ico("pdf")}PDF</button>`]
    : [`<button type="button" class="btn main" data-act="markpaid" data-key="${key}">${ico("check")}Đánh dấu đã đóng</button>`,
       `<button type="button" class="btn" data-act="open" data-key="${key}">${ico("edit")}Sửa</button>`,
       `<button type="button" class="btn" data-act="pdf" data-key="${key}">${ico("pdf")}PDF</button>`];
  el.innerHTML = `
    <div class="hero-top"><div class="hero-label">${ico("wallet")}Tổng tiền tháng ${monthLabel(key)}</div>${statusBadge(r)}</div>
    <div class="hero-total"><span data-count="${total}">${group(total)}</span><small>đ</small></div>
    <div class="hero-meta">${r.paid ? `<span>${ico("check")}Đã đóng ngày ${fmtDate(r.paidDate)}</span>` : ""}</div>
    <div class="hero-actions" style="grid-template-columns:repeat(${acts.length},1fr)">${acts.join("")}</div>`;
  countUp($("[data-count]", el));
}
const CAT_IC = ["home", "bolt", "drop", "tag"];
function renderDetail() {
  const tk = todayKey(), key = S.records[tk] ? tk : sortedKeys().filter(k => k <= tk).pop(), el = $("#detailCard");
  if (!key) {
    el.innerHTML = `<div class="card-title">Chi tiết các khoản</div><div class="empty"><div class="em-ic">${ico("list")}</div><b>Chưa có dữ liệu</b><p>Các khoản trọ, điện, nước sẽ hiện ở đây sau khi bạn nhập.</p></div>`;
    return;
  }
  const r = S.records[key], total = totalOf(r), parts = partsOf(r);
  const pct = v => total > 0 ? `${numVN(v / total * 100, 0)}%` : "";
  const items = [
    { n: "Tiền trọ", v: r.rent, c: 0 }, { n: "Tiền điện", v: r.electric, c: 1 }, { n: "Tiền nước", v: r.water, c: 2 },
    ...r.others.map(o => ({ n: o.name, v: o.amount, c: 3 })),
  ];
  const seg = total > 0 ? parts.map((v, i) => v > 0 ? `<span style="width:${(v / total * 100).toFixed(2)}%;background:var(--${CAT[i].cls})" title="${CAT[i].name}: ${money(v)}"></span>` : "").join("") : "";
  el.innerHTML = `<div class="card-title"><div>Chi tiết tháng ${monthLabel(key)}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-act="open" data-key="${key}">${ico("edit")}Sửa</button></div>
    <div class="segbar" role="img" aria-label="Tỉ lệ các khoản">${seg}</div>
    <ul class="breakdown">${items.map((it, i) => `<li style="--i:${i}"><span class="cat-ic ${CAT[it.c].cls}">${ico(CAT_IC[it.c])}</span>
      <span class="nm">${esc(it.n)}</span>
      <span class="amt num">${money(it.v)}<small>${pct(it.v)}</small></span></li>`).join("")}</ul>
    ${r.note ? `<div class="note-box">${ico("note")}<span>${esc(r.note)}</span></div>` : ""}`;
}
function renderCompare() {
  const el = $("#cmpCard"), tk = todayKey();
  const baseKey = S.records[tk] ? tk : sortedKeys().filter(k => k <= tk).pop();
  const head = sub => `<div class="card-title">So với tháng trước<span class="sub">${sub}</span></div>`;
  if (!baseKey) { el.innerHTML = head("") + `<div class="empty" style="padding:6px">Chưa có dữ liệu để so sánh.</div>`; return; }
  const pk = shiftKey(baseKey, -1), a = S.records[baseKey], b = S.records[pk];
  if (!b) { el.innerHTML = head(`T${parseKey(baseKey).m} so với T${parseKey(pk).m}`) + `<div class="empty" style="padding:6px">Chưa có dữ liệu tháng ${monthLabel(pk)} để so sánh.</div>`; return; }
  const ta = totalOf(a), tb = totalOf(b), diff = ta - tb;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const pct = tb > 0 ? Math.abs(diff) / tb * 100 : 0;
  const pa = partsOf(a), pb = partsOf(b);
  const word = dir === "up" ? "Tăng" : dir === "down" ? "Giảm" : "Không đổi";
  el.innerHTML = head(`T${parseKey(baseKey).m}/${parseKey(baseKey).y} so với T${parseKey(pk).m}/${parseKey(pk).y}`) + `
    <div class="cmp-main">
      <div class="cmp-arrow ${dir}"><span class="${dir}">${ico(dir === "up" ? "trend-up" : dir === "down" ? "trend-down" : "minus")}</span></div>
      <div><div class="cmp-val ${dir}">${signed(diff)}</div>
      <div class="cmp-sub">${word}${dir !== "flat" && tb > 0 ? ` ${numVN(pct, 1)}%` : ""} · tháng trước ${money(tb)}</div></div>
    </div>
    <ul class="cmp-list">${CAT.map((c, i) => { const d = pa[i] - pb[i], k = d > 0 ? "up" : d < 0 ? "down" : "flat";
      return `<li><span class="cat-ic sm ${c.cls}">${ico(CAT_IC[i])}</span><div><div class="t">${c.name}</div><div class="v ${k}">${d === 0 ? "Không đổi" : signed(d)}</div></div></li>`; }).join("")}</ul>`;
}
/* ===== Biểu đồ cột chồng 12 tháng (SVG thuần) ===== */
function niceScale(max) {
  if (max <= 0) return { step: 500000, top: 2000000 };
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { step, top: Math.ceil(max / step) * step };
}
let tipIndex = -1, chartData = [];
function renderChart(anim = false) {
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
  let s = `<svg class="${anim ? "anim" : ""}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Biểu đồ cột chi phí các tháng năm ${dashYear}">`;
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
    s += `<g class="col" data-i="${i}" style="--i:${i}">`;
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
  let lastPointer = 0; // phân biệt focus do bàn phím (Tab) với focus do chạm/bấm chuột
  wrap.addEventListener("pointerdown", () => { lastPointer = Date.now(); });
  wrap.addEventListener("focusin", e => { const h = e.target.closest(".bar-hit"); if (h && Date.now() - lastPointer > 600) showTip(+h.dataset.i); });
  wrap.addEventListener("focusout", hideTip);
  wrap.addEventListener("keydown", e => { const h = e.target.closest(".bar-hit"); if (h && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMonth(chartData[+h.dataset.i].k); } });
  document.addEventListener("click", e => { if (!e.target.closest("#chartWrap")) hideTip(); });
  $("#chartPrev").addEventListener("click", () => { dashYear--; flipYear(); renderChart(true); renderStats(); });
  $("#chartNext").addEventListener("click", () => { dashYear++; flipYear(); renderChart(true); renderStats(); });
  function flipYear() { const e = $("#chartYear"); e.classList.remove("flip"); void e.offsetWidth; e.classList.add("flip"); }
  $("#tblToggle").addEventListener("click", e => {
    const t = $("#chartTable"), open = t.hidden; t.hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", open); e.currentTarget.textContent = open ? "Ẩn bảng" : "Xem dạng bảng";
  });
  let rt, lastW = 0; // chỉ vẽ lại khi chiều rộng đổi (thanh địa chỉ trên điện thoại co giãn cũng gây resize)
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
  const y = dashYear, recs = Object.values(S.records).filter(r => parseKey(r.month).y === y);
  const el = $("#statsCard");
  if (!recs.length) { el.innerHTML = `<div class="card-title">Năm ${y}</div><div class="empty" style="padding:6px">Chưa có dữ liệu năm ${y}.</div>`; return; }
  const sum = recs.reduce((a, r) => a + totalOf(r), 0), avg = Math.round(sum / recs.length);
  const cnt = v => `<span data-count="${v}">${group(v)}</span> đ`;
  el.innerHTML = `<div class="card-title">Năm ${y}<span class="sub">${recs.length} tháng đã nhập</span></div>
    <div class="stats">
      <div class="stat hl"><div class="l">Tổng chi cả năm</div><div class="v">${cnt(sum)}</div></div>
      <div class="stat hl"><div class="l">Trung bình mỗi tháng</div><div class="v">${cnt(avg)}</div></div>
    </div>`;
  $$("[data-count]", el).forEach(countUp);
}
function bindDash() {
  $("#page-dash").addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const key = b.dataset.key;
    if (b.dataset.act === "open") openMonth(key);
    if (b.dataset.act === "pdf") openPdf("month", key);
    if (b.dataset.act === "markpaid") {
      const r = S.records[key]; if (!r) return;
      confettiFrom(b);
      r.paid = true; r.paidDate = isoDate(today()); r.updatedAt = new Date().toISOString(); persist();
      syncRecordToCloud(r);
      if (editKey === key) { if (dirty) setPaid(true, r.paidDate); else loadForm(key); }
      toast(`Đã đánh dấu đóng tiền tháng ${monthLabel(key)}`);
      setTimeout(renderDash, 350);
    }
  });
}
/* =========================================================
   LỊCH NĂM
   ========================================================= */
let calYear = today().getFullYear();
function renderCal() {
  const t = today(), ty = t.getFullYear(), tm = t.getMonth() + 1, td = t.getDate();
  const ys = $("#calYear"); if (ys.textContent !== String(calYear)) { ys.textContent = calYear; ys.classList.remove("flip"); void ys.offsetWidth; ys.classList.add("flip"); }
  let paid = 0, unpaid = 0, none = 0, html = "";
  for (let m = 1; m <= 12; m++) {
    const k = keyOf(calYear, m), r = S.records[k];
    const st = !r ? "none" : r.paid ? "paid" : "unpaid";
    st === "paid" ? paid++ : st === "unpaid" ? unpaid++ : none++;
    const stTxt = st === "paid" ? "đã đóng" : st === "unpaid" ? "chưa đóng" : "chưa nhập";
    const offset = (new Date(calYear, m - 1, 1).getDay() + 6) % 7, dim = daysIn(calYear, m);
    const paidDay = r?.paid && r.paidDate?.startsWith(k) ? +r.paidDate.slice(8, 10) : 0;
    let days = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map(w => `<span class="wd">${w}</span>`).join("");
    days += "<span></span>".repeat(offset);
    for (let d = 1; d <= dim; d++) {
      const cls = ["d"];
      if ((offset + d - 1) % 7 === 6) cls.push("sun");
      if (calYear === ty && m === tm && d === td) cls.push("today");
      else if (d === paidDay) cls.push("paid-day");
      days += `<span class="${cls.join(" ")}">${d}</span>`;
    }
    const isCur = calYear === ty && m === tm;
    html += `<button type="button" class="mcal${isCur ? " current" : ""}" style="--i:${m - 1}" data-key="${k}" aria-label="Tháng ${m}/${calYear}, ${stTxt}${r ? ", " + money(totalOf(r)) : ""}">
      <div class="mcal-head"><b>Tháng ${m}</b><i class="sdot ${st}" title="${stTxt}"></i></div>
      <div class="mcal-amt num ${r ? "" : "none"}">${r ? money(totalOf(r)) : "Chưa nhập"}</div>
      <div class="mdays" aria-hidden="true">${days}</div>
    </button>`;
  }
  $("#calGrid").innerHTML = html;
  $("#calSub").textContent = `Bấm vào một tháng để xem hoặc nhập chi phí`;
  $("#calSum").innerHTML = `<div><b>${paid}</b><small><i class="sdot paid"></i>Đã đóng</small></div><div><b>${unpaid}</b><small><i class="sdot unpaid"></i>Chưa đóng</small></div><div><b>${none}</b><small><i class="sdot none"></i>Chưa nhập</small></div>`;
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
  const ySel = $("#hYear"), prevVal = ySel.value || "all";
  const ys = dataYears().reverse();
  ySel.innerHTML = `<option value="all">Tất cả các năm</option>` + ys.map(y => `<option value="${y}">Năm ${y}</option>`).join("");
  ySel.value = [...ySel.options].some(o => o.value === prevVal) ? prevVal : "all";
  const fy = ySel.value;
  const list = sortedKeys().reverse().map(k => S.records[k]).filter(r => fy === "all" || parseKey(r.month).y === +fy);
  const has = Object.keys(S.records).length;
  if (!list.length) {
    $("#histList").innerHTML = `<div class="card empty"><div class="em-ic">${ico("list")}</div><b>Chưa có dữ liệu</b>
      <p>Hãy nhập chi phí tháng đầu tiên của bạn.</p>
      <button type="button" class="btn btn-primary" id="histStart">${ico("plus")}Nhập chi phí</button></div>`;
  } else {
    const byYear = {}; list.forEach(r => (byYear[parseKey(r.month).y] ||= []).push(r));
    let i = 0;
    $("#histList").innerHTML = Object.keys(byYear).sort((a, b) => b - a).map(y => {
      const rs = byYear[y], ysum = rs.reduce((a, r) => a + totalOf(r), 0);
      return `<div class="year-group"><div class="year-head"><b>Năm ${y}</b><span>${rs.length} tháng · ${money(ysum)}</span></div>` + rs.map(r => {
        const { m } = parseKey(r.month), t = totalOf(r), parts = partsOf(r);
        const bar = t > 0 ? parts.map((v, j) => v > 0 ? `<span style="width:${(v / t * 100).toFixed(1)}%;background:var(--${CAT[j].cls})"></span>` : "").join("") : "";
        const extra = r.others.length ? ` · +${r.others.length} khoản` : "";
        return `<button type="button" class="hist-item ${r.paid ? "paid" : "unpaid"}" style="--i:${i++}" data-key="${r.month}">
          <div class="hist-month"><div><b>${pad(m)}</b><small>${y}</small></div></div>
          <div class="hist-body"><div class="t">${money(t)}</div>
            <div class="s">Trọ ${group(r.rent)} · Điện ${group(r.electric)} · Nước ${group(r.water)}${extra}</div>
            <div class="minibar" aria-hidden="true">${bar}</div>
            ${r.note ? `<div class="s">📝 ${esc(r.note)}</div>` : ""}</div>
          ${statusBadge(r)}
        </button>`;
      }).join("") + `</div>`;
    }).join("");
  }
  $("#dataCount").textContent = `${has} tháng đã lưu`;
  renderCloudUI();
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
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
  const head = ["Tháng", "Tiền trọ", "Tiền điện", "Tiền nước", "Khoản khác (chi tiết)", "Tiền khoản khác", "Tổng cộng", "Trạng thái", "Ngày đóng", "Ghi chú"];
  const rows = keys.map(k => {
    const r = S.records[k];
    return [`Tháng ${pad(parseKey(k).m)}/${parseKey(k).y}`, r.rent, r.electric, r.water,
      r.others.map(o => `${o.name}: ${o.amount}`).join(" | "), othersSum(r), totalOf(r),
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
  Object.values(S.records).forEach(r => syncRecordToCloud(r));
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
  const gone = Object.keys(S.records);
  S.records = {}; persist(); gone.forEach(k => deleteRecordFromCloud(k)); loadForm(todayKey()); renderHist();
  toast("Đã xoá toàn bộ dữ liệu");
}
function bindHist() {
  $("#hYear").addEventListener("change", renderHist);
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
}
/* =========================================================
   MÁY TÍNH BỎ TÚI
   Biểu thức lưu nội bộ dạng "1250000*3+10%" (dấu . là thập phân)
   ========================================================= */
const Calc = {
  expr: "", done: false, result: null, hist: [],
  load() { try { this.hist = JSON.parse(localStorage.getItem(CALC_KEY) || "[]").slice(0, 30); } catch (e) { this.hist = []; } },
  saveHist() { try { localStorage.setItem(CALC_KEY, JSON.stringify(this.hist.slice(0, 30))); } catch (e) {} },
};
const isOp = c => "+-*/".includes(c);
const lastNum = s => (s.match(/[\d.]*$/) || [""])[0];

/** Bộ phân tích biểu thức (không dùng eval). % kiểu máy tính điện thoại: 200+10% = 220 */
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
/** Hiển thị biểu thức: nhóm nghìn, dấu phẩy thập phân, ký hiệu × ÷ − */
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
    if (n === "0") s = s.slice(0, -1); // bỏ số 0 thừa ở đầu
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
  $("#fab").addEventListener("pointerdown", e => e.preventDefault()); // giữ nguyên ô đang chọn làm đích
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
   HIỆU ỨNG: đếm số, gợn sóng, thanh điều hướng, pháo giấy
   ========================================================= */
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function countUp(el) {
  if (!el) return;
  const to = +el.dataset.count || 0;
  if (reduceMotion() || to === 0) { el.textContent = group(to); return; }
  const t0 = performance.now(), dur = 750;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = group(Math.round(to * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function addRipple(e) {
  const b = e.target.closest(".btn, .nav button, .chip, .calc-keys button, .icon-btn, .seg button, .theme-seg button, .fab");
  if (!b || reduceMotion()) return;
  b.classList.add("rp");
  const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2;
  const sp = document.createElement("span");
  sp.className = "ripple";
  sp.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  b.appendChild(sp);
  sp.addEventListener("animationend", () => sp.remove());
}
function moveNavInd() {
  const ind = $(".nav-ind"), b = $(".nav button.active"); if (!ind || !b) return;
  if (matchMedia("(min-width: 960px)").matches) { ind.style.width = ""; ind.style.transform = `translateY(${b.offsetTop - 92}px)`; }
  else { ind.style.width = b.offsetWidth + "px"; ind.style.transform = `translateX(${b.offsetLeft - 6}px)`; }
}
function confettiFrom(el) {
  if (reduceMotion()) return;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const colors = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#6250d6", "#e87ba4"];
  for (let i = 0; i < 26; i++) {
    const c = document.createElement("span"), a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 110;
    c.className = "confetti";
    c.style.cssText = `left:${cx}px;top:${cy}px;background:${colors[i % colors.length]};--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 40}px;--r:${Math.random() * 720 - 360}deg;${i % 3 ? "" : "border-radius:50%"}`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 1000);
  }
}
function bindFx() {
  document.addEventListener("pointerdown", addRipple);
  window.addEventListener("resize", moveNavInd);
  const tb = $(".topbar");
  window.addEventListener("scroll", () => tb.classList.toggle("scrolled", window.scrollY > 4), { passive: true });
  $("#themeBtn").addEventListener("click", e => { const b = e.currentTarget; b.classList.add("spin"); setTimeout(() => b.classList.remove("spin"), 500); });
}


/* =========================================================
   XUẤT PDF — vẽ báo cáo A4 lên canvas rồi đóng gói thành PDF
   (không cần thư viện ngoài, hiển thị đúng tiếng Việt)
   ========================================================= */
const PW = 595.28, PH = 841.89, PX = 2, MG = 40;
const PDF_FONT = '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const PC = { ink: "#0f1420", ink2: "#4b5263", muted: "#7a8193", line: "#e3e6ee", soft: "#f3f5f9", s: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], good: "#0a8a0a", bad: "#c62f2f" };

class PdfDoc {
  constructor() { this.pages = []; this.addPage(); }
  addPage() {
    const c = document.createElement("canvas");
    c.width = Math.round(PW * PX); c.height = Math.round(PH * PX);
    const g = c.getContext("2d"); g.scale(PX, PX); g.fillStyle = "#fff"; g.fillRect(0, 0, PW, PH);
    this.c = c; this.g = g; this.pages.push(c); this.y = MG;
  }
  ensure(h) { if (this.y + h > PH - 54) { this.addPage(); return true; } return false; }
  font(size, w = 400) { this.g.font = `${w} ${size}px ${PDF_FONT}`; }
  text(s, x, y, { size = 10, w = 400, color = PC.ink, align = "left", maxW } = {}) {
    const g = this.g; this.font(size, w); g.fillStyle = color; g.textAlign = align; g.textBaseline = "alphabetic";
    s = String(s);
    if (maxW && g.measureText(s).width > maxW) { while (s.length > 1 && g.measureText(s + "…").width > maxW) s = s.slice(0, -1); s += "…"; }
    g.fillText(s, x, y);
  }
  rect(x, y, w, h, color, r = 0) { const g = this.g; g.fillStyle = color; g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); g.fill(); }
  line(x1, y1, x2, y2, color = PC.line, lw = 0.75) { const g = this.g; g.strokeStyle = color; g.lineWidth = lw; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
  wrap(s, maxW, size, w = 400) {
    this.font(size, w); const words = String(s).split(/\s+/), out = []; let cur = "";
    for (const wd of words) { const t = cur ? cur + " " + wd : wd; if (this.g.measureText(t).width > maxW && cur) { out.push(cur); cur = wd; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  header(title, sub) {
    const g = this.g, grd = g.createLinearGradient(0, 0, PW, 120);
    grd.addColorStop(0, "#2a78d6"); grd.addColorStop(.55, "#4f63e0"); grd.addColorStop(1, "#6250d6");
    g.fillStyle = grd; g.fillRect(0, 0, PW, 118);
    g.fillStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.arc(PW - 40, 10, 90, 0, Math.PI * 2); g.fill();
    this.text("SỔ TIỀN TRỌ", MG, 40, { size: 10, w: 700, color: "rgba(255,255,255,.85)" });
    this.text(title, MG, 70, { size: 22, w: 700, color: "#fff" });
    this.text(sub, MG, 94, { size: 10.5, color: "rgba(255,255,255,.85)" });
    this.y = 142;
  }
  section(t) { this.ensure(40); this.text(t, MG, this.y + 12, { size: 12.5, w: 700 }); this.y += 24; }
  boxes(items) {
    const n = items.length, gap = 10, w = (PW - MG * 2 - gap * (n - 1)) / n, h = 62; this.ensure(h + 10);
    items.forEach((it, i) => {
      const x = MG + i * (w + gap);
      this.rect(x, this.y, w, h, it.bg || PC.soft, 10);
      this.text(it.l, x + 12, this.y + 20, { size: 9, color: PC.ink2, maxW: w - 20 });
      this.text(it.v, x + 12, this.y + 42, { size: it.big ? 16 : 13, w: 700, color: it.color || PC.ink, maxW: w - 20 });
      if (it.s) this.text(it.s, x + 12, this.y + 55, { size: 8, color: PC.muted, maxW: w - 20 });
    });
    this.y += h + 18;
  }
  table(cols, rows, { totalRow, rowH = 24 } = {}) {
    const W = PW - MG * 2, drawHead = () => {
      this.rect(MG, this.y, W, rowH, PC.soft, 6);
      let x = MG; cols.forEach(c => { this.text(c.t, c.align === "right" ? x + c.w - 8 : x + 8, this.y + 16, { size: 9, w: 700, color: PC.ink2, align: c.align || "left" }); x += c.w; });
      this.y += rowH;
    };
    drawHead();
    const all = totalRow ? [...rows, { ...totalRow, _total: true }] : rows;
    all.forEach(r => {
      if (this.ensure(rowH)) drawHead();
      if (r._total) this.rect(MG, this.y + 2, W, rowH - 2, "#e4eefc", 6);
      let x = MG;
      cols.forEach((c, i) => {
        const v = r.cells[i];
        if (c.dot != null && r.dot != null) this.rect(x + 8, this.y + 9, 7, 7, PC.s[r.dot], 2);
        const tx = c.align === "right" ? x + c.w - 8 : x + 8 + (c.dot != null && r.dot != null ? 13 : 0);
        this.text(v ?? "", tx, this.y + 16, { size: 9.5, w: r._total || c.bold ? 700 : 400, color: (r.colors && r.colors[i]) || PC.ink, align: c.align || "left", maxW: c.w - 16 });
        x += c.w;
      });
      if (!r._total) this.line(MG, this.y + rowH, MG + W, this.y + rowH);
      this.y += rowH;
    });
    this.y += 14;
  }
  footer() {
    this.pages.forEach((c, i) => {
      const g = c.getContext("2d"); this.g = g;
      this.line(MG, PH - 38, PW - MG, PH - 38);
      this.text(`Sổ Tiền Trọ · Xuất ngày ${fmtDate(isoDate(new Date()))}`, MG, PH - 22, { size: 8.5, color: PC.muted });
      this.text(`Trang ${i + 1}/${this.pages.length}`, PW - MG, PH - 22, { size: 8.5, color: PC.muted, align: "right" });
    });
  }
}

function pdfMonthReport(key) {
  const r = S.records[key], doc = new PdfDoc(), total = totalOf(r), parts = partsOf(r), { m, y } = parseKey(key);
  doc.header(`Báo cáo chi phí tháng ${m}/${y}`, `Tiền trọ · điện · nước · các khoản khác`);
  doc.boxes([
    { l: "Tổng cộng", v: money(total), big: true, bg: "#e4eefc" },
    { l: "Trạng thái", v: r.paid ? "Đã đóng" : "Chưa đóng", color: r.paid ? PC.good : PC.bad, s: r.paid ? `Ngày ${fmtDate(r.paidDate)}` : "" },
  ]);
  doc.section("Tỉ lệ các khoản");
  let x = MG; const W = PW - MG * 2;
  parts.forEach((v, i) => { if (v > 0 && total > 0) { const w = v / total * W; doc.rect(x, doc.y, Math.max(2, w - 2), 10, PC.s[i], 3); x += w; } });
  doc.y += 22;
  let lx = MG; CAT.forEach((c, i) => { doc.rect(lx, doc.y - 7, 8, 8, PC.s[i], 2); doc.text(`${c.name} ${total ? numVN(parts[i] / total * 100, 0) : 0}%`, lx + 12, doc.y, { size: 9, color: PC.ink2 }); lx += 120; });
  doc.y += 22;
  doc.section("Chi tiết");
  const p100 = v => total ? numVN(v / total * 100, 0) + "%" : "";
  const rows = [
    { dot: 0, cells: ["Tiền trọ", p100(r.rent), money(r.rent)] },
    { dot: 1, cells: ["Tiền điện", p100(r.electric), money(r.electric)] },
    { dot: 2, cells: ["Tiền nước", p100(r.water), money(r.water)] },
    ...r.others.map(o => ({ dot: 3, cells: [o.name, p100(o.amount), money(o.amount)] })),
  ];
  doc.table([{ t: "Khoản", w: 300, dot: true }, { t: "Tỉ lệ", w: 80, align: "right" }, { t: "Số tiền", w: W - 380, align: "right" }], rows,
    { totalRow: { cells: ["Tổng cộng", "100%", money(total)] }, rowH: 26 });
  const pk = shiftKey(key, -1), p = S.records[pk];
  if (p) {
    doc.section(`So với tháng ${monthLabel(pk)}`);
    const pp = partsOf(p), d = total - totalOf(p);
    doc.table([{ t: "Khoản", w: 150, dot: true }, { t: `Tháng ${monthLabel(pk)}`, w: 125, align: "right" }, { t: `Tháng ${monthLabel(key)}`, w: 125, align: "right" }, { t: "Chênh lệch", w: W - 400, align: "right" }],
      CAT.map((c, i) => { const dd = parts[i] - pp[i]; return { dot: i, cells: [c.name, money(pp[i]), money(parts[i]), dd === 0 ? "Không đổi" : signed(dd)], colors: [null, null, null, dd > 0 ? PC.bad : dd < 0 ? PC.good : PC.muted] }; }),
      { totalRow: { cells: ["Tổng", money(totalOf(p)), money(total), d === 0 ? "Không đổi" : signed(d)], colors: [null, null, null, d > 0 ? PC.bad : d < 0 ? PC.good : null] } });
  }
  if (r.note) {
    doc.section("Ghi chú");
    const lines = doc.wrap(r.note, W - 24, 10);
    doc.ensure(lines.length * 15 + 20);
    doc.rect(MG, doc.y, W, lines.length * 15 + 16, PC.soft, 8);
    lines.forEach((ln, i) => doc.text(ln, MG + 12, doc.y + 20 + i * 15, { size: 10, color: PC.ink2 }));
    doc.y += lines.length * 15 + 26;
  }
  return doc;
}
function pdfYearReport(year) {
  const doc = new PdfDoc(), W = PW - MG * 2;
  const data = Array.from({ length: 12 }, (_, i) => { const k = keyOf(year, i + 1), r = S.records[k]; return { k, r, parts: partsOf(r), total: totalOf(r) }; });
  const recs = data.filter(d => d.r), sum = recs.reduce((a, d) => a + d.total, 0);
  doc.header(`Báo cáo chi phí năm ${year}`, `${recs.length}/12 tháng có dữ liệu`);
  doc.boxes([
    { l: "Tổng chi cả năm", v: money(sum), big: true, bg: "#e4eefc" },
    { l: "Trung bình mỗi tháng", v: money(recs.length ? Math.round(sum / recs.length) : 0) },
  ]);
  // biểu đồ cột chồng
  doc.section("Chi phí theo tháng");
  const ch = 150, top0 = doc.y + 6, base = top0 + ch, max = Math.max(0, ...data.map(d => d.total)), { step, top } = niceScale(max);
  const left = MG + 36, pw = W - 36, band = pw / 12, bw = Math.min(18, band * .6);
  for (let v = 0; v <= top + 1e-6; v += step) { const yy = base - v / top * ch; doc.line(left, yy, MG + W, yy, v === 0 ? "#c5cad6" : PC.line); doc.text(v ? compact(v) : "0", left - 6, yy + 3, { size: 7.5, color: PC.muted, align: "right" }); }
  data.forEach((d, i) => {
    const x = left + band * i + (band - bw) / 2; let cur = base;
    d.parts.forEach((v, j) => { if (v > 0) { const h = v / top * ch; doc.rect(x, cur - h + (cur === base ? 0 : 1.5), bw, h - (cur === base ? 0 : 1.5), PC.s[j], 0); cur -= h; } });
    doc.text(`T${i + 1}`, x + bw / 2, base + 13, { size: 8, color: PC.muted, align: "center" });
  });
  doc.y = base + 26;
  let lx = MG; CAT.forEach((c, i) => { doc.rect(lx, doc.y - 7, 8, 8, PC.s[i], 2); doc.text(c.name, lx + 12, doc.y, { size: 9, color: PC.ink2 }); lx += 95; });
  doc.y += 20;
  // bảng 12 tháng
  doc.section("Bảng chi tiết");
  const cw = [66, 76, 68, 64, 62, 80], st = W - cw.reduce((a, b) => a + b, 0);
  const rows = data.map((d, i) => d.r
    ? { cells: [`Tháng ${i + 1}`, group(d.parts[0]), group(d.parts[1]), group(d.parts[2]), group(d.parts[3]), group(d.total), d.r.paid ? "Đã đóng" : "Chưa đóng"], colors: [null, null, null, null, null, null, d.r.paid ? PC.good : PC.bad] }
    : { cells: [`Tháng ${i + 1}`, "—", "—", "—", "—", "—", "Chưa nhập"], colors: [PC.muted, PC.muted, PC.muted, PC.muted, PC.muted, PC.muted, PC.muted] });
  const s = j => group(recs.reduce((a, d) => a + d.parts[j], 0));
  doc.table([{ t: "Tháng", w: cw[0] }, { t: "Tiền trọ", w: cw[1], align: "right" }, { t: "Điện", w: cw[2], align: "right" }, { t: "Nước", w: cw[3], align: "right" }, { t: "Khác", w: cw[4], align: "right" }, { t: "Tổng (đ)", w: cw[5], align: "right", bold: true }, { t: "Trạng thái", w: st, align: "right" }],
    rows, { totalRow: { cells: ["Cả năm", s(0), s(1), s(2), s(3), group(sum), ""] }, rowH: 22 });
  return doc;
}

/** Đóng gói các trang canvas thành file PDF (ảnh JPEG mỗi trang) */
function canvasesToPdf(pages, title) {
  const enc = new TextEncoder(), chunks = [], offs = []; let len = 0;
  const push = d => { const b = typeof d === "string" ? enc.encode(d) : d; chunks.push(b); len += b.length; };
  const obj = (n, fn) => { offs[n] = len; push(`${n} 0 obj\n`); fn(); push("\nendobj\n"); };
  const hex = s => "<FEFF" + [...s].map(ch => { const c = ch.codePointAt(0); return c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)].map(x => x.toString(16).padStart(4, "0")).join("") : c.toString(16).padStart(4, "0"); }).join("").toUpperCase() + ">";
  const N = pages.length, total = 4 + N * 3;
  push(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10])); // %PDF-1.4 + byte nhị phân
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${N} /Kids [${pages.map((_, i) => `${4 + i * 3} 0 R`).join(" ")}] >>`));
  obj(3, () => push(`<< /Title ${hex(title)} /Producer (So Tien Tro) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}) >>`));
  pages.forEach((c, i) => {
    const pn = 4 + i * 3, cn = pn + 1, im = pn + 2;
    const b64 = c.toDataURL("image/jpeg", 0.9).split(",")[1], bin = atob(b64), jpg = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) jpg[k] = bin.charCodeAt(k);
    const cs = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(pn, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cn} 0 R >>`));
    obj(cn, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
    obj(im, () => { push(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push("\nendstream"); });
  });
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) x += String(offs[n]).padStart(10, "0") + " 00000 n \n";
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: "application/pdf" });
}

async function makePdf(mode, key) {
  try { await Promise.all(["400", "700"].map(w => document.fonts?.load(`${w} 16px "Be Vietnam Pro"`, "Ấ"))); } catch (e) {}
  const doc = mode === "year" ? pdfYearReport(parseKey(key).y) : pdfMonthReport(key);
  doc.footer();
  const { m, y } = parseKey(key);
  const name = mode === "year" ? `bao-cao-tien-tro-nam-${y}.pdf` : `bao-cao-tien-tro-thang-${pad(m)}-${y}.pdf`;
  const title = mode === "year" ? `Báo cáo chi phí năm ${y}` : `Báo cáo chi phí tháng ${m}/${y}`;
  return { blob: canvasesToPdf(doc.pages, title), name };
}

/* ===== Hộp thoại xuất PDF ===== */
let pdfMode = "month";
function pdfKey() { return keyOf(+$("#pdfYear").value, +$("#pdfMonth").value); }
function updatePdfUI() {
  $$("[data-pdf]").forEach(b => { const on = b.dataset.pdf === pdfMode; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  $("#pdfMonth").hidden = pdfMode === "year";
  $("#pdfMonthPick").style.gridTemplateColumns = pdfMode === "year" ? "1fr" : "minmax(0,1.25fr) minmax(0,1fr)";
  const k = pdfKey(), y = parseKey(k).y, info = $("#pdfInfo"), go = $("#pdfGo");
  if (pdfMode === "month") {
    const r = S.records[k];
    info.innerHTML = r ? `Tháng ${monthLabel(k)} · <b>${money(totalOf(r))}</b> · ${r.paid ? "đã đóng" : "chưa đóng"}` : `<span class="up">Tháng ${monthLabel(k)} chưa có dữ liệu.</span>`;
    go.disabled = !r;
  } else {
    const n = Object.keys(S.records).filter(x => parseKey(x).y === y).length;
    info.innerHTML = n ? `Năm ${y} · <b>${n} tháng</b> có dữ liệu` : `<span class="up">Năm ${y} chưa có dữ liệu.</span>`;
    go.disabled = !n;
  }
}
function openPdf(mode = "month", key = todayKey()) {
  pdfMode = mode;
  const { m, y } = parseKey(key);
  $("#pdfMonth").innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">Tháng ${i + 1}</option>`).join("");
  $("#pdfYear").innerHTML = yearRange().map(v => `<option value="${v}">${v}</option>`).join("");
  $("#pdfMonth").value = m; $("#pdfYear").value = y;
  updatePdfUI();
  const ov = $("#pdfOverlay"); ov.classList.add("show"); ov.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#pdfGo").focus({ preventScroll: true }), 60);
}
function closePdf() { const ov = $("#pdfOverlay"); ov.classList.remove("show"); ov.setAttribute("aria-hidden", "true"); }
async function runPdf() {
  const k = pdfKey(); closePdf();
  const busy = $("#busy"); busy.classList.add("show");
  await new Promise(r => setTimeout(r, 30));
  try {
    const { blob, name } = await makePdf(pdfMode, k);
    const file = typeof File === "function" ? new File([blob], name, { type: "application/pdf" }) : null;
    const inFrame = window.self !== window.top;
    if (inFrame && file && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); } catch (e) { download(name, blob); } }
    else download(name, blob);
    toast(`Đã tạo ${name}`);
  } catch (e) { console.error(e); toast("Không tạo được PDF: " + e.message, true); }
  finally { busy.classList.remove("show"); }
}
function bindPdf() {
  $("#pdfClose").addEventListener("click", closePdf);
  $("#pdfOverlay").addEventListener("click", e => { if (e.target.id === "pdfOverlay") closePdf(); });
  $$("[data-pdf]").forEach(b => b.addEventListener("click", () => { pdfMode = b.dataset.pdf; updatePdfUI(); }));
  $("#pdfMonth").addEventListener("change", updatePdfUI); $("#pdfYear").addEventListener("change", updatePdfUI);
  $("#pdfGo").addEventListener("click", runPdf);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#pdfOverlay").classList.contains("show")) closePdf(); });
  $("#btnPdf").addEventListener("click", () => openPdf("year", keyOf(+($("#hYear").value === "all" ? today().getFullYear() : $("#hYear").value), today().getMonth() + 1)));
  $("#btnPdfEntry").addEventListener("click", () => openPdf("month", editKey));
}

/* =========================================================
   ĐỒNG BỘ ĐÁM MÂY (Firestore + đăng nhập Google)
   ========================================================= */
function renderCloudUI() {
  const badge = $("#cloudBadge"), box = $("#cloudUserBox"), actions = $("#cloudActions"), top = $("#cloudTopBtn");
  if (!badge || !box || !actions) return;
  const u = SyncState.currentUser, st = SyncState.status;
  top?.classList.toggle("on", !!u); top?.classList.toggle("syncing", st === "syncing");
  if (u) {
    const name = u.displayName || u.email || "Người dùng";
    badge.className = `badge ${st === "syncing" ? "warn" : st === "error" ? "unpaid" : "paid"}`;
    badge.textContent = st === "syncing" ? "Đang đồng bộ…" : st === "error" ? "Lỗi kết nối" : "Đã kết nối";
    if (top) top.title = `Đồng bộ đám mây: ${u.email || name}`;
    box.innerHTML = `<div class="who">${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="av">${esc(name.slice(0, 1).toUpperCase())}</span>`}
        <div style="min-width:0"><div class="nm">${esc(name)}</div><div class="em">${esc(u.email || "")}</div></div></div>
      <div class="when">${st === "error" ? esc(SyncState.errorMessage || "Không kết nối được Firestore") : SyncState.lastSyncedAt ? `Đồng bộ lần cuối: ${SyncState.lastSyncedAt.toLocaleTimeString("vi-VN")} ${SyncState.lastSyncedAt.toLocaleDateString("vi-VN")}` : "Đang đồng bộ…"}</div>`;
    actions.innerHTML = `<button type="button" class="btn btn-primary" id="btnSyncNow">${ico("refresh")}Đồng bộ ngay</button>
      <button type="button" class="btn btn-ghost" id="btnLogoutCloud">Đăng xuất</button>`;
  } else {
    badge.className = "badge none"; badge.textContent = "Chưa kết nối";
    if (top) top.title = "Đồng bộ đám mây (chưa đăng nhập)";
    box.innerHTML = `Dữ liệu đang lưu trên trình duyệt này. Đăng nhập Google để lưu lên đám mây và dùng trên nhiều thiết bị.`;
    actions.innerHTML = `<button type="button" class="btn btn-primary" id="btnLoginCloud">${ico("cloud")}Đăng nhập Google</button>`;
  }
}
function bindCloud() {
  $("#cloudActions").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "btnLoginCloud") {
      try { await loginWithGoogle(); toast("Đăng nhập thành công, đang tải dữ liệu…"); }
      catch (err) { if (err?.code !== "auth/popup-closed-by-user") toast(`Không đăng nhập được: ${err?.message || err}`, true); }
    }
    if (b.id === "btnLogoutCloud") {
      const ok = await dialog({ title: "Đăng xuất?", message: "Dữ liệu trên máy này vẫn được giữ lại.",
        buttons: [{ text: "Huỷ", value: null }, { text: "Đăng xuất", value: true, cls: "btn-primary" }] });
      if (ok) { await logoutUser(); toast("Đã đăng xuất"); renderCloudUI(); }
    }
    if (b.id === "btnSyncNow") {
      b.disabled = true;
      for (const k of Object.keys(S.records)) await syncRecordToCloud(S.records[k]);
      await syncSettingsToCloud(S.settings);
      b.disabled = false;
      toast(SyncState.status === "error" ? "Đồng bộ lỗi, thử lại sau" : "Đã đồng bộ xong", SyncState.status === "error");
      renderCloudUI();
    }
  });
  $("#cloudTopBtn").addEventListener("click", () => { go("hist"); setTimeout(() => $("#cloudSyncCard")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); });
  setSyncStatusListener(() => renderCloudUI());
  initSyncEngine({
    getLocalState: () => S,
    onCloudUpdated: cloudRecords => {
      let changed = false;
      for (const [k, cloudRec] of Object.entries(cloudRecords)) {
        const norm = normRecord(cloudRec, k); if (!norm) continue;
        const cur = S.records[k];
        if (!cur || !cur.updatedAt || new Date(norm.updatedAt) >= new Date(cur.updatedAt)) {
          if (!cur || JSON.stringify(cur) !== JSON.stringify(norm)) { S.records[k] = norm; changed = true; }
        }
      }
      if (!changed) return;
      persist();
      if (currentPage === "dash") renderDash();
      if (currentPage === "cal") renderCal();
      if (currentPage === "hist") renderHist();
      if (!dirty) loadForm(editKey);
    },
  });
}

/* =========================================================
   AI ĐIỀN TỰ ĐỘNG (gõ hoặc nói → Gemini phân tích)
   ========================================================= */
function applyAIResult(data) {
  if (!data || typeof data !== "object") return;
  if (data.month && /^\d{4}-\d{2}$/.test(data.month) && data.month !== editKey) loadForm(data.month);
  const setIf = (id, v) => { if (v != null && isFinite(v) && v >= 0) { setMoney($(id), Math.round(v)); flashEl($(id)); } };
  setIf("#fRent", data.rent);
  setIf("#fElec", data.electric);
  setIf("#fWater", data.water);
  if (Array.isArray(data.others)) {
    for (const o of data.others) {
      const name = String(o?.name || "").trim(), amt = Math.round(Number(o?.amount));
      if (!name || !(amt >= 0)) continue;
      const ex = formOthers.find(f => f.name.trim().toLowerCase() === name.toLowerCase());
      if (ex) ex.amount = group(amt); else formOthers.push({ name, amount: group(amt) });
    }
    renderOthers();
  }
  if (data.paid === true) setPaid(true, /^\d{4}-\d{2}-\d{2}$/.test(data.paidDate || "") ? data.paidDate : isoDate(today()));
  else if (data.paid === false && !S.records[editKey]?.paid) setPaid(false, "");
  if (data.note && typeof data.note === "string") $("#fNote").value = data.note.slice(0, 500);
  dirty = true; updateTotal();
}
function flashEl(el) { if (!el) return; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
function bindAI() {
  const input = $("#aiInputText"), mic = $("#aiMicBtn"), fill = $("#aiFillBtn"), status = $("#aiVoiceStatus"), out = $("#aiResultSummary");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;
  if (SR) {
    rec = new SR(); rec.lang = "vi-VN"; rec.continuous = false; rec.interimResults = true;
    rec.onstart = () => { listening = true; mic.classList.add("listening"); status.hidden = false; };
    rec.onresult = e => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; input.value = t; };
    rec.onerror = e => { if (e.error === "not-allowed") toast("Hãy cho phép dùng micro trong trình duyệt", true); else if (e.error !== "no-speech" && e.error !== "aborted") toast(`Lỗi nhận giọng nói: ${e.error}`, true); };
    rec.onend = () => { listening = false; mic.classList.remove("listening"); status.hidden = true; if (input.value.trim()) fill.click(); };
  }
  mic.addEventListener("click", () => {
    if (!rec) { input.focus(); toast("Trình duyệt này chưa hỗ trợ nhập bằng giọng nói, bạn gõ vào ô nhé", true); return; }
    if (listening) rec.stop(); else { input.value = ""; try { rec.start(); } catch (e) {} }
  });
  fill.addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) { toast("Hãy gõ hoặc nói chi phí trước", true); input.focus(); return; }
    fill.disabled = true; fill.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px"></span><span>Đang phân tích…</span>`;
    out.hidden = true;
    try {
      const res = await fetch("/api/ai-fill", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, currentMonth: editKey, currentYear: parseKey(editKey).y }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `Máy chủ trả lỗi ${res.status}`);
      applyAIResult(data);
      if (data.summary) { out.hidden = false; out.innerHTML = `<b>AI đã điền:</b> ${esc(data.summary)} <span class="hint">— kiểm tra lại rồi bấm Lưu</span>`; }
      toast("AI đã điền, kiểm tra lại rồi bấm Lưu");
    } catch (err) {
      toast(`AI chưa xử lý được: ${err.message}`, true);
    } finally {
      fill.disabled = false; fill.innerHTML = `${ico("sparkles")}<span>AI điền</span>`;
    }
  });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); fill.click(); } });
}

/* =========================================================
   KHỞI ĐỘNG
   ========================================================= */
function init() {
  const t = today();
  $("#todayLabel").textContent = `${WEEKDAYS[t.getDay()]}, ${fmtDate(isoDate(t))}`;
  applyTheme(); fillSelects();
  bindEntry(); bindDash(); bindChart(); bindCal(); bindHist(); bindCalc(); bindFx(); bindPdf(); bindAI();
  $("#themeBtn").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));
  $$(".nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.nav)));
  // Theo dõi ô tiền đang chọn ở mọi trang để máy tính chèn kết quả
  document.addEventListener("focusin", e => { if (e.target.matches?.("[data-money]") && !e.target.readOnly) calcTarget = e.target; });
  loadForm(todayKey());
  go(location.hash.slice(1) || "dash", { push: false });
  document.fonts?.ready.then(moveNavInd);
  bindCloud();
}
init();
