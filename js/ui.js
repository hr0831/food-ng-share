/**
 * 画面描画とイベント処理（アプリのエントリポイント）。
 * DB へのアクセスは必ず data.js 経由。ここから supabase を直接触らない。
 */
import { IS_CONFIGURED } from "./supabase.js";
import * as Auth from "./auth.js";
import * as DB from "./data.js";
import { subscribeRoom } from "./realtime.js";

/* ================================================================== *
 * 小さなヘルパー
 * ================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** textContent で組み立てるので、食材名やメモに何が入っても HTML にならない */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const dtf = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : "―");

/** 重複判定用の正規化（全角半角・大文字小文字・空白のゆれを吸収） */
function normalizeFood(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

/* ================================================================== *
 * 状態
 * ================================================================== */

const state = {
  user: null,
  room: null,
  members: [],                    // [{room_id, user_id, joined_at}]
  profiles: new Map(),            // user_id -> profile
  restrictions: new Map(),        // id -> row（id をキーにするので冪等にマージできる）
  tab: "mine",
  filterNever: false,
  presenceOthers: [],
  sync: null,                     // realtime のハンドル
};

const myId = () => state.user?.id || "";
const nameOf = (uid) =>
  state.profiles.get(uid)?.display_name || (uid === myId() ? "あなた" : "相手");
const partnerId = () => state.members.find((m) => m.user_id !== myId())?.user_id || null;

/* ================================================================== *
 * 画面切り替え / トースト / ダイアログ
 * ================================================================== */

/**
 * 固定フッター（注記＋タブバー）の実高さを CSS 変数に反映する。
 * タブバーの表示/非表示や注記の折り返し行数で高さが変わるため、
 * 固定値にするとコンテンツの末尾がフッターに隠れてしまう。
 * ResizeObserver だけに頼らず、高さが変わり得る場面で明示的に呼ぶ。
 */
function applyFooterHeight() {
  const footer = $(".footerbar");
  if (!footer) return;
  document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
}

function showScreen(name) {
  $$(".screen").forEach((s) => (s.hidden = s.dataset.screen !== name));
  const inApp = name === "app";
  $("#tabbar").hidden = !inApp;
  $("#btn-settings").hidden = !inApp;
  // 接続状態はルームを購読している間しか意味を持たないので、それ以外では隠す
  $("#conn").hidden = !inApp;
  if (!inApp) $("#presence").hidden = true;
  applyFooterHeight();          // タブバーの出し入れで高さが変わる
}

function showError(title, body) {
  $("#error-title").textContent = title;
  $("#error-body").textContent = body;
  showScreen("error");
}

/**
 * トースト。action を渡すと右側にボタンが出る（削除の「元に戻す」用）。
 */
function toast(message, { error = false, action = null, duration = 3500 } = {}) {
  const box = el("div", `toast${error ? " toast--error" : ""}`);
  box.append(el("span", "toast__msg", message));

  let timer = null;
  const close = () => {
    clearTimeout(timer);
    box.remove();
  };

  if (action) {
    const btn = el("button", "toast__action", action.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      close();
      action.run();
    });
    box.append(btn);
  }
  $("#toasts").append(box);
  timer = setTimeout(close, duration);
  return close;
}

/** エラーを日本語化してトーストで出す */
async function toastError(err) {
  const { message, kind } = await DB.describeDbError(err);
  toast(message, { error: true, duration: kind === "paused" ? 9000 : 5000 });
  return kind;
}

/**
 * <dialog> を「どのボタンで閉じたか」を返す Promise として扱う。
 *
 * close イベントだけに頼らないのは、埋め込みブラウザ（アプリ内ブラウザ等）の
 * 一部で close イベントが飛ばないことがあり、そうなると Promise が永久に
 * 解決せずダイアログ操作が無反応になるため。ボタンの click を主、
 * close / cancel（Esc・バックドロップ）を従として二重に受ける。
 *
 * @param {HTMLDialogElement} dlg
 * @param {Array<{el: HTMLElement, value: string}>} buttons
 * @returns {Promise<string>} 押されたボタンの value（Esc 等なら "cancel"）
 */
function openDialog(dlg, buttons) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanups.forEach((fn) => fn());
      if (dlg.open) dlg.close(value);
      resolve(value);
    };

    for (const { el: btn, value } of buttons) {
      if (!btn) continue;
      const handler = (e) => {
        e.preventDefault();
        finish(value);
      };
      btn.addEventListener("click", handler);
      cleanups.push(() => btn.removeEventListener("click", handler));
    }

    const onClose = () => finish(dlg.returnValue || "cancel");
    const onCancel = () => finish("cancel");
    dlg.addEventListener("close", onClose);
    dlg.addEventListener("cancel", onCancel);
    cleanups.push(() => dlg.removeEventListener("close", onClose));
    cleanups.push(() => dlg.removeEventListener("cancel", onCancel));

    dlg.returnValue = "";
    dlg.showModal();
  });
}

async function confirmDialog({ title, body, okLabel = "削除する", danger = true }) {
  const dlg = $("#dlg-confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.className = danger ? "btn btn--danger" : "btn btn--primary";

  const result = await openDialog(dlg, [
    { el: $("#confirm-cancel"), value: "cancel" },
    { el: ok, value: "ok" },
  ]);
  return result === "ok";
}

/* ================================================================== *
 * セグメント（3択）とクイック追加チップ
 * ================================================================== */

const KIND_OPTIONS = [
  ["allergy", "⚠️ アレルギー"],
  ["belief", "🕊️ 宗教・信条"],
  ["dislike", "🥄 苦手・好み"],
];
const LEVEL_OPTIONS = [
  ["never", "絶対NG"],
  ["avoid", "できれば避けたい"],
  ["small_ok", "少量なら大丈夫"],
];

function buildSeg(container, groupName, options, checked) {
  container.textContent = "";
  for (const [value, label] of options) {
    const wrap = el("label", "seg__opt");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = groupName;
    input.value = value;
    input.checked = value === checked;
    wrap.append(input, el("span", null, label));
    container.append(wrap);
  }
}
const segValue = (container) => $("input:checked", container)?.value || null;

// アレルギー表示の対象になりやすいもの（既定: アレルギー / 絶対NG）
const CHIPS_ALLERGY = [
  "えび", "かに", "くるみ", "そば", "卵", "乳",
  "落花生", "小麦", "さば", "いか", "大豆", "キウイ",
];
// 苦手として挙がりやすいもの（既定: 苦手 / できれば避けたい）
const CHIPS_DISLIKE = [
  "パクチー", "セロリ", "なす", "ピーマン", "しいたけ", "ホルモン", "レバー",
  "生魚", "貝類", "羊肉", "わさび", "激辛", "パイナップル", "トマト",
];

function buildChips() {
  const make = (container, foods, kind, level, extraClass) => {
    container.textContent = "";
    for (const food of foods) {
      const b = el("button", `chip${extraClass}`, food);
      b.type = "button";
      b.addEventListener("click", () => addItem({ food, kind, level }));
      container.append(b);
    }
  };
  make($("#chips-allergy"), CHIPS_ALLERGY, "allergy", "never", " chip--allergy");
  make($("#chips-dislike"), CHIPS_DISLIKE, "dislike", "avoid", "");
}

/* ================================================================== *
 * データのマージ（Realtime と HTTP レスポンスの両方から呼ばれる）
 * ================================================================== */

function mergeRow(row) {
  if (!row?.id) return;
  const cur = state.restrictions.get(row.id);
  // 楽観行は常に上書きしてよい。確定行同士なら新しい updated_at を優先し、
  // 遅れて届いた古い Realtime イベントで巻き戻らないようにする。
  if (cur && !cur._pending && cur.updated_at && row.updated_at && cur.updated_at > row.updated_at) {
    return;
  }
  state.restrictions.set(row.id, row);
}

function sortedItems(list) {
  return list.slice().sort((a, b) => {
    const k = DB.KINDS[a.kind].order - DB.KINDS[b.kind].order;
    if (k) return k;
    const l = DB.LEVELS[a.level].order - DB.LEVELS[b.level].order;
    if (l) return l;
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
}

const allItems = () => Array.from(state.restrictions.values());
const myItems = () => allItems().filter((r) => r.user_id === myId());
const partnerItems = () => allItems().filter((r) => r.user_id !== myId());

/* ================================================================== *
 * 描画
 * ================================================================== */

function renderConn(connState) {
  const pill = $("#conn");
  const labels = {
    connecting: "接続しています…",
    online: "接続中",
    reconnecting: "再接続中…",
    offline: "オフライン",
  };
  pill.dataset.state = connState;
  pill.textContent = labels[connState] || connState;
}

function renderPresence() {
  const box = $("#presence");
  const others = state.presenceOthers;
  if (!others.length) {
    box.hidden = true;
    return;
  }
  const name = state.profiles.get(others[0].user_id)?.display_name || others[0].display_name || "相手";
  box.textContent = `${name}さんが表示中`;
  box.hidden = false;
}

/** 1項目を表す行。editable なら押すと編集ダイアログが開く。 */
function renderItem(row, { editable, showWho = false }) {
  const node = el("button", `item${editable ? "" : " item--readonly"}${row._pending ? " item--pending" : ""}`);
  node.type = "button";
  if (!editable) node.disabled = true;

  node.append(el("span", "item__ic", DB.KINDS[row.kind].icon));

  const body = el("div", "item__body");
  body.append(el("div", "item__food", row.food));

  const meta = el("div", "item__meta");
  // level: never は必ず「絶対NG」の明示ラベルを警告色で出す
  const levelClass = row.level === "never" ? "badge badge--never" : `badge badge--${row.level}`;
  meta.append(el("span", levelClass, DB.LEVELS[row.level].label));
  if (row.kind === "allergy") meta.append(el("span", "badge badge--allergy", "アレルギー"));
  if (showWho) meta.append(el("span", "badge badge--who", nameOf(row.user_id)));
  body.append(meta);

  if (row.note) body.append(el("div", "item__note", row.note));
  node.append(body);

  if (editable) node.append(el("span", "item__edit", "編集 ›"));
  if (editable) node.addEventListener("click", () => openEdit(row));
  return node;
}

/**
 * 区分ごとにセクション分けして描画する。
 * アレルギーは必ず最上部＋警告色にして、苦手と同じ見た目で並ばないようにする。
 */
function renderGroups(container, items, opts) {
  container.textContent = "";
  const order = ["allergy", "belief", "dislike"];
  let rendered = 0;

  for (const kind of order) {
    const list = sortedItems(items.filter((r) => r.kind === kind));
    if (!list.length) continue;
    rendered += list.length;

    const group = el("section", `group group--${kind}`);
    const head = el("div", "group__head");
    head.append(el("span", null, DB.KINDS[kind].icon));
    head.append(el("h2", "group__title", DB.KINDS[kind].label));
    head.append(el("span", "group__count", `${list.length}件`));
    group.append(head);

    const box = el("div", "items");
    for (const row of list) box.append(renderItem(row, opts));
    group.append(box);
    container.append(group);
  }

  if (!rendered) {
    const empty = el("div", "empty");
    empty.append(el("span", "empty__ic", opts.emptyIcon || "🍽"));
    for (const line of (opts.emptyText || "").split("\n")) {
      empty.append(el("div", null, line));
    }
    container.append(empty);
  }
}

function renderMine() {
  renderGroups($("#mine-list"), myItems(), {
    editable: true,
    emptyIcon: "📝",
    emptyText: "まだ登録がありません。\n上のフォームかクイック追加から、\n食べられないものを登録しましょう。",
  });
}

function renderPartner() {
  const pid = partnerId();
  const invitePanel = $("#invite-panel");
  const listBox = $("#partner-list");

  // 相手がまだ参加していないときは招待画面を出す
  invitePanel.hidden = Boolean(pid);
  if (!pid) {
    listBox.textContent = "";
    renderInvite();
    return;
  }

  const items = partnerItems();
  const latest = items.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), "");

  listBox.textContent = "";
  const head = el("div", "card card--tight");
  head.append(el("h2", null, `${nameOf(pid)}さんのリスト`));
  head.append(el("p", "note", `最終更新: ${latest ? fmtDateTime(latest) : "―"}／読み取り専用です`));
  listBox.append(head);

  const groups = el("div");
  renderGroups(groups, items, {
    editable: false,
    emptyIcon: "🫙",
    emptyText: `${nameOf(pid)}さんはまだ登録していません。`,
  });
  listBox.append(groups);
}

function renderInvite() {
  const room = state.room;
  if (!room) return;
  const revoked = Boolean(room.invite_revoked_at);
  const codeBox = $("#invite-code");
  codeBox.textContent = room.invite_code;
  codeBox.className = `invite-code${revoked ? " invite-code--revoked" : ""}`;
  $("#invite-status").textContent = revoked
    ? "このコードは無効化されています。招待するには再発行してください。"
    : "このコードを知っている人だけが参加できます。参加は1名までです。";
  $("#btn-share").disabled = revoked;
  $("#btn-copy-code").disabled = revoked;
  $("#btn-revoke").hidden = revoked;
}

function inviteUrl() {
  return `${location.origin}${location.pathname}?invite=${encodeURIComponent(state.room.invite_code)}`;
}

/* ---- まとめタブ -------------------------------------------------- */

function summaryItems() {
  let items = allItems();
  if (state.filterNever) items = items.filter((r) => r.level === "never");
  return sortedItems(items);
}

function renderSummary() {
  const items = summaryItems();
  renderGroups($("#summary-list"), items, {
    editable: false,
    showWho: true,
    emptyIcon: "📋",
    emptyText: state.filterNever
      ? "「絶対NG」の登録はありません。"
      : "2人ともまだ登録がありません。",
  });
  $("#share-text").textContent = buildShareText(items);
}

/**
 * 1項目を共有テキスト用の短い文字列にする。
 * 区分から自然に想像がつくレベル（アレルギー=絶対NG、苦手=避けたい）は
 * 書かない。全項目に注釈を付けると長くなり、肝心の食材名が埋もれるため。
 */
function itemText(r) {
  const bits = [];
  if (r.kind === "allergy") {
    if (r.level === "avoid") bits.push("できれば避けたい");
    if (r.level === "small_ok") bits.push("少量なら可");
  } else {
    if (r.level === "never") bits.push("絶対NG");
    if (r.level === "small_ok") bits.push("少量なら可");
  }
  if (r.note) bits.push(r.note);
  return r.food + (bits.length ? `（${bits.join("・")}）` : "");
}

function buildShareText(items) {
  if (!items.length) return "（登録がありません）";
  const lines = [];
  for (const kind of ["allergy", "belief", "dislike"]) {
    const list = items.filter((r) => r.kind === kind);
    if (!list.length) continue;
    lines.push(`${DB.KINDS[kind].short}: ${list.map(itemText).join("・")}`);
  }
  if (items.some((r) => r.kind === "allergy")) {
    lines.push("※アレルギーのため、微量の混入や調理器具の共用もご配慮ください。");
  }
  return lines.join("\n");
}

/* ---- 全体 -------------------------------------------------------- */

function renderAll() {
  renderMine();
  renderPartner();
  renderSummary();
  renderPresence();
}

function switchTab(tab) {
  state.tab = tab;
  $$(".tabpanel").forEach((p) => (p.hidden = p.dataset.tab !== tab));
  $$("[data-tabbtn]").forEach((b) => {
    if (b.dataset.tabbtn === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0 });
}

/* ================================================================== *
 * 追加・編集・削除（楽観的更新）
 * ================================================================== */

async function addItem({ food, kind, level, note = "" }) {
  const name = String(food || "").trim();
  if (!name) {
    toast("食べ物の名前を入力してください。", { error: true });
    return false;
  }
  if (!state.room) return false;

  // 同じ食材の重複を検知して確認する
  const dup = myItems().find((r) => normalizeFood(r.food) === normalizeFood(name));
  if (dup) {
    const ok = await confirmDialog({
      title: "すでに登録されています",
      body: `「${dup.food}」は ${DB.KINDS[dup.kind].label}／${DB.LEVELS[dup.level].label} として登録済みです。\nもう一度追加しますか？`,
      okLabel: "追加する",
      danger: false,
    });
    if (!ok) return false;
  }

  const id = DB.newId();
  const now = new Date().toISOString();
  // 楽観的更新: 先に画面へ出す。id はクライアント採番なので、
  // Realtime のエコーが先に来ても id が一致してマージされる（重複表示しない）。
  mergeRow({
    id, room_id: state.room.id, user_id: myId(),
    food: name, kind, level, note,
    created_at: now, updated_at: now, _pending: true,
  });
  renderAll();

  try {
    const saved = await DB.addRestriction({
      id, roomId: state.room.id, userId: myId(), food: name, kind, level, note,
    });
    mergeRow(saved);
    renderAll();
    return true;
  } catch (err) {
    state.restrictions.delete(id);           // 失敗したのでロールバック
    renderAll();
    await toastError(err);
    return false;
  }
}

async function saveEdit(id, patch) {
  const before = state.restrictions.get(id);
  if (!before) return;
  mergeRow({ ...before, ...patch, updated_at: new Date().toISOString(), _pending: true });
  renderAll();
  try {
    const saved = await DB.updateRestriction(id, patch);
    state.restrictions.set(id, saved);       // 確定値で置き換える
    renderAll();
  } catch (err) {
    state.restrictions.set(id, before);      // ロールバック
    renderAll();
    await toastError(err);
  }
}

async function removeItem(row) {
  const isAllergy = row.kind === "allergy";
  const ok = await confirmDialog({
    title: isAllergy ? "⚠️ アレルギー項目の削除" : "削除の確認",
    body: isAllergy
      ? `「${row.food}」はアレルギーとして登録されています。\n\n削除すると相手の画面からも消え、外食時に見落とす原因になります。\n本当に削除しますか？`
      : `「${row.food}」を削除します。よろしいですか？`,
    okLabel: isAllergy ? "理解のうえ削除する" : "削除する",
  });
  if (!ok) return;

  state.restrictions.delete(row.id);
  renderAll();

  try {
    await DB.deleteRestriction(row.id);
    // 削除後5秒間だけ「元に戻す」を出す
    toast(`「${row.food}」を削除しました`, {
      duration: 5000,
      action: { label: "元に戻す", run: () => undoDelete(row) },
    });
  } catch (err) {
    mergeRow(row);
    renderAll();
    await toastError(err);
  }
}

async function undoDelete(row) {
  const { _pending, ...clean } = row;
  mergeRow({ ...clean, _pending: true });
  renderAll();
  try {
    const saved = await DB.restoreRestriction(clean);
    mergeRow(saved);
    renderAll();
    toast(`「${clean.food}」を元に戻しました`);
  } catch (err) {
    state.restrictions.delete(clean.id);
    renderAll();
    await toastError(err);
  }
}

/* ---- 編集ダイアログ ---------------------------------------------- */

async function openEdit(row) {
  $("#edit-food").value = row.food;
  $("#edit-note").value = row.note || "";
  buildSeg($("#edit-kind"), "edit-kind", KIND_OPTIONS, row.kind);
  buildSeg($("#edit-level"), "edit-level", LEVEL_OPTIONS, row.level);

  const result = await openDialog($("#dlg-edit"), [
    { el: $("#edit-cancel"), value: "cancel" },
    { el: $("#edit-save"), value: "save" },
    { el: $("#edit-delete"), value: "delete" },
  ]);

  if (result === "delete") return void removeItem(row);
  if (result !== "save") return;

  const patch = {
    food: $("#edit-food").value,
    note: $("#edit-note").value,
    kind: segValue($("#edit-kind")) || row.kind,
    level: segValue($("#edit-level")) || row.level,
  };
  if (!patch.food.trim()) {
    toast("食べ物の名前は空にできません。", { error: true });
    return;
  }
  // 何も変わっていないなら通信しない
  const changed = ["food", "note", "kind", "level"].some(
    (k) => String(patch[k]).trim() !== String(row[k] ?? "").trim()
  );
  if (changed) saveEdit(row.id, patch);
}

/* ================================================================== *
 * コピー / 共有
 * ================================================================== */

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
    return;
  } catch {
    /* 非対応・権限拒否のときは下のフォールバックへ */
  }
  // 古い iOS Safari 等のフォールバック
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand?.("copy");
  ta.remove();
  toast(ok ? okMessage : "コピーできませんでした。長押しで選択してコピーしてください。", { error: !ok });
}

async function shareOrCopy(payload, fallbackText, okMessage) {
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;   // 利用者がキャンセルしただけ
    }
  }
  await copyText(fallbackText, okMessage);
}

/* ================================================================== *
 * IME 対策
 * ================================================================== */

/**
 * 日本語入力の変換確定 Enter で誤送信しないようにする。
 * isComposing に加えて keyCode 229 も見るのは、Android の一部 IME が
 * compositionend より先に keydown を投げてくるため。
 */
function guardIme(input, onEnter) {
  let composing = false;
  input.addEventListener("compositionstart", () => (composing = true));
  input.addEventListener("compositionend", () => (composing = false));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.isComposing || composing || e.keyCode === 229) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (onEnter) {
      e.preventDefault();
      onEnter();
    }
  });
}

/* ================================================================== *
 * 認証画面
 * ================================================================== */

let cooldownTimer = null;

function refreshCooldown() {
  const btn = $("#btn-send");
  const remaining = Auth.cooldownRemaining();
  if (remaining > 0) {
    btn.disabled = true;
    btn.textContent = `再送信まで ${remaining} 秒`;
  } else {
    btn.disabled = false;
    btn.textContent = "ログイン用メールを送る";
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}
function startCooldownTicker() {
  refreshCooldown();
  if (!cooldownTimer && Auth.cooldownRemaining() > 0) {
    cooldownTimer = setInterval(refreshCooldown, 1000);
  }
}

function setLoginNote(text, isError) {
  const note = $("#login-note");
  note.textContent = text || "";
  note.className = `note${isError ? " note--error" : ""}`;
  note.hidden = !text;
}

function initAuthScreen() {
  $("#login-email").value = Auth.lastEmail();
  if (Auth.linkError) setLoginNote(Auth.linkError, true);
  startCooldownTicker();

  guardIme($("#login-email"));
  $("#form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#btn-send");
    if (btn.disabled) return;
    btn.disabled = true;
    setLoginNote("送信しています…", false);

    const res = await Auth.sendMagicLink($("#login-email").value);
    if (res.ok) {
      setLoginNote(
        "メールを送りました。届いたリンクを開くか、6桁コードを下の欄に入力してください。" +
          "（届かない場合は迷惑メールもご確認ください）",
        false
      );
      $("#otp-card").open = true;
    } else {
      setLoginNote(res.message, true);
    }
    startCooldownTicker();
  });

  guardIme($("#otp-code"));
  $("#form-otp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value || Auth.lastEmail();
    const res = await Auth.verifyEmailOtp(email, $("#otp-code").value);
    if (!res.ok) setLoginNote(res.message, true);
    // 成功時は onAuthStateChange が拾って画面が切り替わる
  });
}

/* ================================================================== *
 * ルーム作成 / 参加
 * ================================================================== */

async function saveSetupName() {
  const name = $("#setup-name").value.trim();
  if (!name) return;
  try {
    const p = await DB.updateDisplayName(myId(), name);
    state.profiles.set(p.id, p);
  } catch (err) {
    await toastError(err);
  }
}

function initRoomScreen() {
  $("#setup-name").value = state.profiles.get(myId())?.display_name || "";
  guardIme($("#setup-name"));
  guardIme($("#join-code"));
}

async function handleCreateRoom() {
  const btn = $("#btn-create-room");
  btn.disabled = true;
  try {
    await saveSetupName();
    state.room = await DB.createRoom("");
    await enterRoom();
  } catch (err) {
    await toastError(err);
  } finally {
    btn.disabled = false;
  }
}

async function handleJoinRoom(code) {
  try {
    await saveSetupName();
    await DB.joinRoom(code);
    const ctx = await DB.fetchMyRoom();
    if (!ctx) throw new Error("参加後のルーム取得に失敗しました");
    state.room = ctx.room;
    state.members = ctx.members;
    await enterRoom();
    toast("ルームに参加しました");
  } catch (err) {
    await toastError(err);
  }
}

/* ================================================================== *
 * ルーム内のデータ読み込み・購読
 * ================================================================== */

/** メンバー・プロフィール・登録内容を取り直す（初回 / 再接続時の両方で使う） */
async function refreshRoomData() {
  const ctx = await DB.fetchMyRoom();
  if (!ctx) {
    // 相手に退出させられた等。ルーム選択画面へ戻す
    stopSync();
    state.room = null;
    state.members = [];
    state.restrictions.clear();
    showScreen("room");
    initRoomScreen();
    return;
  }
  state.room = ctx.room;
  state.members = ctx.members;

  const [profiles, rows] = await Promise.all([
    DB.fetchProfiles(state.members.map((m) => m.user_id)),
    DB.listRestrictions(ctx.room.id),
  ]);
  for (const p of profiles) state.profiles.set(p.id, p);

  // サーバを正とするので、確定済みの行はいったん捨てて入れ直す。
  // 送信中（_pending）の行だけは残し、二重送信・チラつきを避ける。
  const pending = allItems().filter((r) => r._pending);
  state.restrictions.clear();
  for (const r of rows) state.restrictions.set(r.id, r);
  for (const r of pending) if (!state.restrictions.has(r.id)) state.restrictions.set(r.id, r);

  renderAll();
}

function startSync() {
  stopSync();
  state.sync = subscribeRoom({
    roomId: state.room.id,
    userId: myId(),
    getDisplayName: () => nameOf(myId()),
    onRestriction: ({ eventType, new: nw, old }) => {
      if (eventType === "DELETE") {
        if (old?.id) state.restrictions.delete(old.id);
      } else if (nw) {
        mergeRow(nw);
      }
      renderAll();
    },
    onProfile: (row) => {
      state.profiles.set(row.id, row);
      renderAll();
    },
    onMembership: () => {
      // 相手が参加/退出した。メンバーとプロフィールを取り直して画面を作り直す
      refreshRoomData().catch((err) => toastError(err));
    },
    onPresence: (others) => {
      state.presenceOthers = others;
      renderPresence();
    },
    onState: (s) => renderConn(s),
    onResync: () => {
      refreshRoomData().catch(async (err) => {
        await toastError(err);
      });
    },
  });
}

async function handleLeaveRoom() {
  const ok = await confirmDialog({
    title: "ルームから退出",
    body: "あなたの登録内容はルームに残りますが、相手のリストは見られなくなります。\n再参加には招待コードが必要です。よろしいですか？",
    okLabel: "退出する",
  });
  if (!ok) return;
  try {
    await DB.leaveRoom(state.room.id, myId());
    stopSync();
    state.room = null;
    state.members = [];
    state.restrictions.clear();
    showScreen("room");
    initRoomScreen();
    toast("ルームから退出しました");
  } catch (err) {
    await toastError(err);
  }
}

function stopSync() {
  state.sync?.dispose();
  state.sync = null;
  state.presenceOthers = [];
}

async function enterRoom() {
  showScreen("loading");
  await refreshRoomData();
  if (!state.room) return;     // refreshRoomData がルーム画面へ戻した場合
  startSync();
  showScreen("app");
  switchTab(state.tab);
  renderAll();
}

/* ================================================================== *
 * ログイン後の初期化
 * ================================================================== */

/*
 * マジックリンクから戻ったときは boot() と onAuthStateChange の両方が
 * ログイン成立を検知する。二重初期化しないよう、処理中のユーザーIDで見張る。
 */
let loginInFlight = null;

async function afterLogin(session) {
  if (loginInFlight === session.user.id) return;
  loginInFlight = session.user.id;

  try {
    state.user = session.user;
    showScreen("loading");

    const profile = await DB.ensureProfile(session.user);
    state.profiles.set(profile.id, profile);

    // マジックリンクの往復で消えた招待コードを、ここで消化する
    const pending = Auth.takePendingInvite();
    if (pending) {
      try {
        await DB.joinRoom(pending);
        toast("ルームに参加しました");
      } catch (err) {
        const kind = await toastError(err);
        if (kind === "auth") return;
      }
    }

    const ctx = await DB.fetchMyRoom();
    if (!ctx) {
      showScreen("room");
      initRoomScreen();
      return;
    }
    state.room = ctx.room;
    state.members = ctx.members;
    await enterRoom();
  } catch (err) {
    loginInFlight = null;   // 失敗したら「再試行」でもう一度走れるようにする
    throw err;
  }
}

function toLoggedOut() {
  stopSync();
  loginInFlight = null;
  state.user = null;
  state.room = null;
  state.members = [];
  state.profiles.clear();
  state.restrictions.clear();
  showScreen("auth");
  startCooldownTicker();
}

/* ================================================================== *
 * イベント配線
 * ================================================================== */

function wireEvents() {
  // --- タブ ---
  $$("[data-tabbtn]").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tabbtn))
  );

  // --- 追加フォーム ---
  buildSeg($("#add-kind"), "add-kind", KIND_OPTIONS, "allergy");
  buildSeg($("#add-level"), "add-level", LEVEL_OPTIONS, "never");
  buildChips();
  guardIme($("#add-food"), () => $("#form-add").requestSubmit());
  guardIme($("#add-note"), () => $("#form-add").requestSubmit());

  // 区分を変えたら、その区分にありがちなレベルを既定に寄せる。
  // ただし利用者が自分でレベルを触ったあとは勝手に戻さない。
  let levelTouched = false;
  $("#add-level").addEventListener("change", () => (levelTouched = true));
  $("#add-kind").addEventListener("change", () => {
    if (levelTouched) return;
    const kind = segValue($("#add-kind"));
    buildSeg($("#add-level"), "add-level", LEVEL_OPTIONS, kind === "allergy" ? "never" : "avoid");
  });

  $("#form-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await addItem({
      food: $("#add-food").value,
      kind: segValue($("#add-kind")) || "dislike",
      level: segValue($("#add-level")) || "avoid",
      note: $("#add-note").value,
    });
    if (ok) {
      $("#add-food").value = "";
      $("#add-note").value = "";
      $("#add-food").focus();
    }
  });

  // --- 招待 ---
  $("#btn-share").addEventListener("click", () =>
    shareOrCopy(
      {
        title: "NGフード共有への招待",
        text: `「食べられないもの」を共有しましょう。招待コード: ${state.room.invite_code}`,
        url: inviteUrl(),
      },
      inviteUrl(),
      "招待リンクをコピーしました"
    )
  );
  $("#btn-copy-code").addEventListener("click", () =>
    copyText(state.room.invite_code, "招待コードをコピーしました")
  );
  $("#btn-revoke").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "招待コードを無効化",
      body: "現在のコードでは参加できなくなります。よろしいですか？",
      okLabel: "無効化する",
    });
    if (!ok) return;
    try {
      await DB.revokeInvite(state.room.id);
      state.room.invite_revoked_at = new Date().toISOString();
      renderInvite();
      toast("招待コードを無効化しました");
    } catch (err) {
      await toastError(err);
    }
  });
  $("#btn-regen").addEventListener("click", async () => {
    try {
      const code = await DB.regenerateInvite(state.room.id);
      state.room.invite_code = code;
      state.room.invite_revoked_at = null;
      renderInvite();
      toast("新しい招待コードを発行しました");
    } catch (err) {
      await toastError(err);
    }
  });

  // --- まとめ ---
  $("#filter-never").addEventListener("change", (e) => {
    state.filterNever = e.target.checked;
    renderSummary();
  });
  $("#btn-copy-share").addEventListener("click", () =>
    copyText($("#share-text").textContent, "共有用テキストをコピーしました")
  );
  $("#btn-share-text").addEventListener("click", () =>
    shareOrCopy(
      { title: "NG食材メモ", text: $("#share-text").textContent },
      $("#share-text").textContent,
      "共有用テキストをコピーしました"
    )
  );

  // --- ルーム画面 ---
  $("#btn-create-room").addEventListener("click", handleCreateRoom);
  $("#form-join").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("#join-code").value.trim();
    if (!code) return toast("招待コードを入力してください。", { error: true });
    handleJoinRoom(code);
  });
  $("#btn-signout-early").addEventListener("click", async () => {
    await Auth.signOut();
  });

  // --- 編集ダイアログ内の入力も IME 対策する ---
  guardIme($("#edit-food"));
  guardIme($("#edit-note"));
  guardIme($("#settings-name"));

  // --- 設定ダイアログ ---
  $("#btn-settings").addEventListener("click", async () => {
    $("#settings-name").value = state.profiles.get(myId())?.display_name || "";
    $("#settings-account").textContent = `ログイン中: ${state.user?.email || ""}`;

    const result = await openDialog($("#dlg-settings"), [
      { el: $("#settings-close"), value: "cancel" },
      { el: $("#settings-save"), value: "save" },
      { el: $("#btn-signout"), value: "signout" },
      { el: $("#btn-leave"), value: "leave" },
    ]);

    if (result === "signout") return void Auth.signOut();
    if (result === "leave") return void handleLeaveRoom();
    if (result !== "save") return;

    const name = $("#settings-name").value.trim();
    if (!name) return;
    try {
      const p = await DB.updateDisplayName(myId(), name);
      state.profiles.set(p.id, p);
      state.sync?.refreshPresence();
      renderAll();
      toast("表示名を保存しました");
    } catch (err) {
      await toastError(err);
    }
  });

  // --- エラー画面の再試行 ---
  $("#btn-retry").addEventListener("click", () => boot());

  // --- フッターの実高さを CSS 変数へ反映（注記が2行/3行になっても被らない） ---
  applyFooterHeight();
  window.addEventListener("resize", applyFooterHeight);
  window.addEventListener("orientationchange", () => setTimeout(applyFooterHeight, 200));
  // フォント読み込みやアドレスバーの伸縮でも高さが変わるので、保険として監視も張る
  if (window.ResizeObserver) new ResizeObserver(applyFooterHeight).observe($(".footerbar"));
}

/* ================================================================== *
 * 起動
 * ================================================================== */

async function boot() {
  if (!IS_CONFIGURED) {
    showScreen("config");
    return;
  }
  showScreen("loading");

  // 招待コードは ?invite=XXXX で渡ってくる。マジックリンクの往復で
  // URL が消えるので、セッション確定前に控えておく。
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) Auth.stashPendingInvite(invite);

  try {
    const session = await Auth.getSession();

    // トークン入りのハッシュや ?invite= が残らないよう、ここで URL を掃除する。
    // getSession() は内部の初期化（ハッシュ解析）を待ってから返るので、この順序が必要。
    if (location.search || location.hash) {
      history.replaceState(null, "", location.origin + location.pathname);
    }

    if (!session) {
      toLoggedOut();
      initAuthScreenOnce();
      return;
    }
    await afterLogin(session);
  } catch (err) {
    const { message } = await DB.describeDbError(err);
    showError("接続できませんでした", message);
  }
}

let authScreenReady = false;
function initAuthScreenOnce() {
  if (authScreenReady) return;
  authScreenReady = true;
  initAuthScreen();
}

function main() {
  wireEvents();

  // ログイン状態の変化を監視して画面を切り替える
  Auth.onAuthChange(async (event, session) => {
    if (event === "SIGNED_IN" && session && session.user.id !== state.user?.id) {
      try {
        await afterLogin(session);
      } catch (err) {
        const { message } = await DB.describeDbError(err);
        showError("読み込みに失敗しました", message);
      }
    } else if (event === "SIGNED_OUT") {
      toLoggedOut();
      initAuthScreenOnce();
    }
  });

  boot();
}

main();
