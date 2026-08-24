/**
 * 画面描画とイベント処理（アプリのエントリポイント）。
 * DB へのアクセスは必ず data.js 経由。ここから supabase を直接触らない。
 */
import { IS_CONFIGURED } from "./supabase.js";
import * as Auth from "./auth.js";
import * as DB from "./data.js";
import { subscribeRoom } from "./realtime.js";
import { icon, mountIcons } from "./icons.js";

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
  /*
   * 表示モード。"avoid" = にがて（アレルギー・苦手）/ "like" = すき。
   * 起動時は必ず "avoid" から始める。アレルギーの確認がこのアプリの主目的で、
   * 前回すきモードだったからといって食べられないものが隠れた状態で開くのは避けたい。
   */
  mode: "avoid",
  filterLv3: false,               // まとめ画面「レベル3／大好き だけ表示」
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
 */
function applyFooterHeight() {
  const footer = $(".footerbar");
  if (!footer) return;
  const set = () => {
    /*
     * 極端な値はレイアウト途中の誤計測（画面回転直後など）。
     * 実機で取り得ない範囲に丸めておかないと、画面下に巨大な空白ができる。
     */
    const h = Math.max(44, Math.min(240, footer.offsetHeight || 108));
    document.documentElement.style.setProperty("--footer-h", `${h}px`);
  };
  set();
  // レイアウトが落ち着いてからもう一度測る
  requestAnimationFrame(set);
}

function showScreen(name) {
  $$(".screen").forEach((s) => (s.hidden = s.dataset.screen !== name));
  const inApp = name === "app";
  $("#tabbar").hidden = !inApp;
  $("#modebar").hidden = !inApp;
  $("#btn-settings").hidden = !inApp;
  // 接続状態はルームを購読している間しか意味を持たないので、それ以外では隠す
  $("#conn").hidden = !inApp;
  if (!inApp) $("#presence").hidden = true;
  applyFooterHeight();          // タブバーの出し入れで高さが変わる
  applyModebarOffset();
}

function showError(title, body) {
  $("#error-title").textContent = title;
  $("#error-body").textContent = body;
  showScreen("error");
}

/**
 * トースト。action を渡すと右側にボタンが出る（削除の「元に戻す」用）。
 */
function toast(message, { error = false, danger = false, action = null, duration = 3500 } = {}) {
  const variant = error ? " toast--error" : danger ? " toast--danger" : "";
  const box = el("div", `toast${variant}`);
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
  toast(message, { error: true, duration: kind === "auth" || kind === "paused" ? 9000 : 5000 });

  // セッション切れの状態で操作を続けても必ず同じ失敗を繰り返す。
  // 壊れたセッションを捨ててログイン画面へ戻し、やり直せるようにする。
  if (kind === "auth") {
    try {
      await Auth.signOut();
    } catch {
      /* 既に無効なセッションなら signOut 自体が失敗することがある。無視してよい */
    }
    toLoggedOut();
    initAuthScreenOnce();
  }
  return kind;
}

/**
 * <dialog> を「どのボタンで閉じたか」を返す Promise として扱う。
 *
 * close イベントだけに頼らないのは、埋め込みブラウザ（アプリ内ブラウザ等）の
 * 一部で close イベントが飛ばないことがあり、そうなると Promise が永久に
 * 解決せずダイアログ操作が無反応になるため。ボタンの click を主、
 * close / cancel（Esc・バックドロップ）を従として二重に受ける。
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
 * セグメント（選択肢）
 * ================================================================== */

const KIND_OPTIONS = [
  ["allergy", "アレルギー"],
  ["dislike", "苦手・好み"],
];
const CATEGORY_OPTIONS = [
  ["ingredient", "食材"],
  ["dish", "料理"],
];

/**
 * レベルの選択肢。「数字＋短い説明」の縦積みで見せる。
 * 意味がモードで変わる（にがて=重さ／すき=好き度）ので data.js から引く。
 */
const levelOptions = (polarity) =>
  [1, 2, 3].map((n) => [String(n), DB.LEVELS[polarity][n].seg]);

/** そのモードで使う区分（すき側は like ひとつだけ） */
const kindsOf = (polarity) => DB.POLARITIES[polarity].kinds;

/**
 * ラジオボタンのセグメントを組み立てる。
 * checked に null を渡すと「未選択」で始まる（区分・レベルは必須なのでこれを使う）。
 */
function buildSeg(container, groupName, options, checked, { stacked = false, withIcon = null } = {}) {
  container.textContent = "";
  for (const [value, label] of options) {
    const wrap = el("label", "seg__opt");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = groupName;
    input.value = value;
    input.checked = checked != null && String(value) === String(checked);

    const face = el("span", stacked ? "seg__lv" : null);
    if (stacked) {
      face.append(el("b", null, value), el("small", null, label));
    } else {
      if (withIcon) face.append(icon(withIcon(value), { size: 16 }));
      face.append(el("span", null, label));
    }
    wrap.append(input, face);
    container.append(wrap);
  }
  markSegFilled(container);
}

const segValue = (container) => $("input:checked", container)?.value || null;

/** 選択済みなら「※選んでください」を隠す */
function markSegFilled(container) {
  container.closest(".seg")?.classList.toggle("seg--filled", Boolean(segValue(container)));
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

/** 区分（アレルギー→苦手）、レベル（3→2→1）、登録順 で並べる */
function sortedItems(list) {
  return list.slice().sort((a, b) => {
    const k = DB.KINDS[a.kind].order - DB.KINDS[b.kind].order;
    if (k) return k;
    const l = DB.levelInfo(a.kind, a.level).order - DB.levelInfo(b.kind, b.level).order;
    if (l) return l;
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
}

const allItems = () => Array.from(state.restrictions.values());
/** いま表示しているモード（にがて／すき）の行だけ */
const modeItems = () => allItems().filter((r) => DB.polarityOf(r.kind) === state.mode);
const myItems = () => modeItems().filter((r) => r.user_id === myId());
const partnerItems = () => modeItems().filter((r) => r.user_id !== myId());

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

/** 1項目のカード本体 */
function renderItem(row, { showWho = false, editable = false }) {
  const node = el("button", `item${editable ? "" : " item--readonly"}${row._pending ? " item--pending" : ""}`);
  node.type = "button";
  if (!editable) node.disabled = true;

  const ic = el("span", "item__ic");
  ic.append(icon(DB.KINDS[row.kind].icon, { size: 19 }));
  node.append(ic);

  const body = el("div", "item__body");
  body.append(el("div", "item__food", row.food));

  const meta = el("div", "item__meta");

  // レベル: 数字を主、短い説明を従にする（意味はモードで変わる）
  const lvInfo = DB.levelInfo(row.kind, row.level);
  const lv = el("span", `badge badge--lv${row.level}`);
  lv.append(el("b", null, String(row.level)), el("span", null, lvInfo.short));
  meta.append(lv);

  // 分類（食材／料理）はバッジで添えるだけ
  const cat = DB.CATEGORIES[row.category] || DB.CATEGORIES.ingredient;
  const catBadge = el("span", "badge badge--cat");
  catBadge.append(icon(cat.icon, { size: 13 }), el("span", null, cat.label));
  meta.append(catBadge);

  if (showWho) meta.append(el("span", "badge badge--who", nameOf(row.user_id)));
  body.append(meta);

  if (row.note) body.append(el("div", "item__note", row.note));
  node.append(body);

  if (editable) {
    const chev = el("span", "item__edit");
    chev.append(icon("chevron", { size: 18 }));
    node.append(chev);
    node.addEventListener("click", () => openEdit(row));
  }
  return node;
}

/**
 * 1行（スワイプ削除の受け皿つき）。
 * 自分の登録だけスワイプ・編集ができる。相手の行は読み取り専用。
 */
function renderRow(row, opts) {
  const mine = row.user_id === myId() && !row._pending;
  const wrap = el("div", "row");

  if (mine) {
    const bg = el("div", "row__bg");
    bg.append(icon("trash", { size: 18 }), el("span", null, "削除"));
    wrap.append(bg);
  }

  const item = renderItem(row, { ...opts, editable: mine });
  wrap.append(item);
  if (mine) attachSwipe(wrap, item, () => removeItem(row));
  return wrap;
}

/**
 * 左スワイプで削除。
 *
 * 縦スクロールを邪魔しないよう、最初の数pxで縦横どちらの操作かを判定し、
 * 横と判定したときだけ指を追わせる（CSS の touch-action: pan-y と対で機能する）。
 */
function attachSwipe(rowEl, itemEl, onDelete) {
  let startX = 0, startY = 0, dx = 0, axis = null, active = false;

  const reset = () => {
    active = false;
    axis = null;
    rowEl.classList.remove("row--dragging");
  };

  itemEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    axis = null;
    active = true;
  });

  itemEl.addEventListener("pointermove", (e) => {
    if (!active) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;

    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // 縦寄りならスクロール操作とみなして手を引く
      if (Math.abs(mx) <= Math.abs(my) * 1.3) { active = false; return; }
      axis = "x";
      rowEl.classList.add("row--dragging");
      try { itemEl.setPointerCapture(e.pointerId); } catch { /* 一部環境で未対応 */ }
    }
    dx = Math.min(0, mx);                       // 左方向だけ受け付ける
    itemEl.style.transform = `translateX(${dx}px)`;
  });

  const finish = () => {
    if (!active) return;
    reset();
    /*
     * 行幅の35%（最大120px）引いたら削除。
     * ただし下限を64pxで固定する。レイアウト計算前などで offsetWidth が 0 を
     * 返すことがあり、そのまま割合で決めると閾値が0になって「ほんの少し指が
     * 横に流れただけで消える」という事故になるため。
     */
    const width = rowEl.offsetWidth || window.innerWidth || 320;
    const threshold = Math.max(64, Math.min(120, width * 0.35));
    if (dx < -threshold) {
      itemEl.style.transform = "translateX(-100%)";
      onDelete();
    } else {
      itemEl.style.transform = "";
    }
  };
  itemEl.addEventListener("pointerup", finish);
  itemEl.addEventListener("pointercancel", () => { reset(); itemEl.style.transform = ""; });

  // スワイプ直後の click で編集ダイアログが開かないようにする
  itemEl.addEventListener("click", (e) => {
    if (dx < -6) {
      e.preventDefault();
      e.stopPropagation();
      dx = 0;
    }
  }, true);
}

/**
 * 区分ごとにセクション分けして描画する。
 * アレルギーは必ず最上部＋警告色にして、苦手と同じ見た目で並ばないようにする。
 */
function renderGroups(container, items, opts) {
  container.textContent = "";
  const order = opts.kinds || kindsOf(state.mode);
  let rendered = 0;

  for (const kind of order) {
    const list = sortedItems(items.filter((r) => r.kind === kind));
    if (!list.length) continue;
    rendered += list.length;

    const group = el("section", `group group--${kind}`);
    const head = el("div", "group__head");
    head.append(icon(DB.KINDS[kind].icon, { size: 17 }));
    head.append(el("h2", "group__title", DB.KINDS[kind].label));
    head.append(el("span", "group__count", `${list.length}件`));
    group.append(head);

    const box = el("div", "items");
    for (const row of list) box.append(renderRow(row, opts));
    group.append(box);
    container.append(group);
  }

  if (!rendered) {
    const empty = el("div", "empty");
    const ic = el("span", "empty__ic");
    ic.append(icon(opts.emptyIcon || "empty", { size: 34 }));
    empty.append(ic);
    for (const line of (opts.emptyText || "").split("\n")) {
      empty.append(el("div", null, line));
    }
    container.append(empty);
  }
}

function renderMine() {
  const like = state.mode === "like";
  renderGroups($("#mine-list"), myItems(), {
    emptyIcon: like ? "like" : "mine",
    emptyText: like
      ? "好きなものはまだありません。\n上のフォームから、\n好きな食べ物を登録しましょう。"
      : "まだ登録がありません。\n上のフォームから、\n食べられないものを登録しましょう。",
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

  const like = state.mode === "like";
  listBox.textContent = "";
  const head = el("div", "card card--tight");
  head.append(el("h2", null, like ? `${nameOf(pid)}さんの好きなもの` : `${nameOf(pid)}さんのリスト`));
  head.append(el("p", "note", `最終更新: ${latest ? fmtDateTime(latest) : "―"}／読み取り専用です`));
  listBox.append(head);

  const groups = el("div");
  renderGroups(groups, items, {
    emptyIcon: like ? "like" : "partner",
    emptyText: like
      ? `${nameOf(pid)}さんはまだ好きなものを登録していません。`
      : `${nameOf(pid)}さんはまだ登録していません。`,
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
  let items = modeItems();
  if (state.filterLv3) items = items.filter((r) => Number(r.level) === 3);
  return sortedItems(items);
}

/**
 * 「すき」のまとめを、ふたりの重なりで組み替える。
 *   1) ふたりとも好き（名前が一致するもの）
 *   2) 自分だけが好き
 *   3) 相手だけが好き
 * お店選びのとき「どこなら2人とも嬉しいか」が最初に目に入るようにするため。
 */
function groupLikes(items) {
  const mine = items.filter((r) => r.user_id === myId());
  const theirs = items.filter((r) => r.user_id !== myId());
  const theirKeys = new Set(theirs.map((r) => normalizeFood(r.food)));
  const myKeys = new Set(mine.map((r) => normalizeFood(r.food)));

  const both = [];
  const seen = new Set();
  for (const r of mine) {
    const k = normalizeFood(r.food);
    if (theirKeys.has(k) && !seen.has(k)) {
      seen.add(k);
      /*
       * 好き度は2人のうち「低い方」を代表値にする。
       * 高い方にすると、片方が「まあ好き」でも「大好き」と表示されて実態より強く見える。
       * 低い方なら「ふたりとも少なくともこのくらいは好き」という読み方になり、
       * 並び順としても「2人とも大好きなもの」が自然に上に来る。
       */
      const partner = theirs.find((x) => normalizeFood(x.food) === k);
      both.push({ ...r, level: Math.min(Number(r.level), Number(partner.level)) });
    }
  }
  return {
    both,
    mine: mine.filter((r) => !theirKeys.has(normalizeFood(r.food))),
    theirs: theirs.filter((r) => !myKeys.has(normalizeFood(r.food))),
  };
}

/**
 * すきモードのまとめ用グループ。
 *
 * 絞り込みは「組にしたあと」に掛ける。先に絞ってしまうと、
 * 片方だけが大好きな品が「ふたりとも好き」から外れて
 * 「その人だけが好き」に移ってしまい、事実と違う表示になる。
 */
function likeGroups() {
  const g = groupLikes(modeItems());
  if (!state.filterLv3) return g;
  const keep = (list) => list.filter((r) => Number(r.level) === 3);
  return { both: keep(g.both), mine: keep(g.mine), theirs: keep(g.theirs) };
}

/** すきモードのまとめ描画（区分が1つしかないので独自に組む） */
function renderLikeSummary(container) {
  container.textContent = "";
  const g = likeGroups();
  const pid = partnerId();

  const section = (titleText, iconName, list, opts = {}) => {
    if (!list.length) return;
    const wrap = el("section", `group group--${opts.cls || "like"}`);
    const head = el("div", "group__head");
    head.append(icon(iconName, { size: 17 }));
    head.append(el("h2", "group__title", titleText));
    head.append(el("span", "group__count", `${list.length}件`));
    wrap.append(head);
    const box = el("div", "items");
    for (const row of sortedItems(list)) box.append(renderRow(row, { showWho: false }));
    wrap.append(box);
    container.append(wrap);
  };

  section("ふたりとも好き", "bothLike", g.both, { cls: "both" });
  section(`${nameOf(myId())}さんが好き`, "like", g.mine);
  if (pid) section(`${nameOf(pid)}さんが好き`, "like", g.theirs);

  if (!g.both.length && !g.mine.length && !g.theirs.length) {
    const empty = el("div", "empty");
    const ic = el("span", "empty__ic");
    ic.append(icon("like", { size: 34 }));
    empty.append(ic);
    const msg = state.filterLv3
      ? "「大好き」の登録はありません。"
      : "2人ともまだ好きなものを登録していません。";
    empty.append(el("div", null, msg));
    container.append(empty);
  }
}

function renderSummary() {
  if (state.mode === "like") {
    renderLikeSummary($("#summary-list"));
    return;
  }
  const items = summaryItems();
  renderGroups($("#summary-list"), items, {
    showWho: true,
    emptyIcon: "summary",
    emptyText: state.filterLv3
      ? "レベル3の登録はありません。"
      : "2人ともまだ登録がありません。",
  });
}

/**
 * 共有用テキストのダイアログ。
 *
 * 以前はまとめ画面に常置していたが、縦を大きく占有して一覧の邪魔になるため
 * ボタン→ダイアログに移した。コピー／共有を押したら一度閉じるのは、
 * モーダルは最前面に出るため、閉じないと完了トーストが背後に隠れてしまうから。
 */
async function openShareDialog() {
  const like = state.mode === "like";
  $("#dlg-share h2").textContent = like ? "好きなものを共有" : "お店に伝える";
  $("#share-text").textContent = buildShareText();
  $("#share-scope").textContent = state.filterLv3
    ? `「${like ? "大好き" : "レベル3（食べられない）"}だけ」で絞り込んだ内容です。`
    : "登録されているものを、すべて載せています。";

  const result = await openDialog($("#dlg-share"), [
    { el: $("#share-close"), value: "cancel" },
    { el: $("#btn-copy-share"), value: "copy" },
    { el: $("#btn-share-text"), value: "share" },
  ]);

  const text = $("#share-text").textContent;
  if (result === "copy") {
    await copyText(text, "共有用テキストをコピーしました");
  } else if (result === "share") {
    await shareOrCopy({ title: "ふたりごはん", text }, text, "共有用テキストをコピーしました");
  }
}

/**
 * 1項目を共有テキスト用の短い文字列にする。
 * 区分から自然に想像がつくこと（アレルギー＝食べられない）は書かない。
 * 全項目に注釈を付けると長くなり、肝心の名前が埋もれるため。
 */
function itemText(r) {
  /*
   * すき側は「どれが好きか」が伝わればよいので、名前とメモだけにする。
   * にがて側と同じ密度で注釈を付けると、ほとんどが「大好き」になって
   * かえって読みにくくなるため。
   */
  if (r.kind === "like") {
    return r.food + (r.note ? `（${r.note}）` : "");
  }
  const bits = [];
  if (r.category === "dish") bits.push("料理");
  if (r.kind === "allergy" && Number(r.level) < 3) bits.push(DB.levelInfo(r.kind, r.level).short);
  if (r.kind === "dislike" && Number(r.level) === 3) bits.push("食べられない");
  if (r.note) bits.push(r.note);
  return r.food + (bits.length ? `（${bits.join("・")}）` : "");
}

function buildShareText() {
  // すき側は「ふたりとも好き」を先頭に出す（お店選びに一番効く情報のため）
  if (state.mode === "like") {
    const g = likeGroups();
    const pid = partnerId();
    const lines = [];
    // 画面と同じ「好き度の高い順」で並べる
    const list = (arr) => sortedItems(arr).map(itemText).join("・");
    if (g.both.length) lines.push(`ふたりとも好き: ${list(g.both)}`);
    if (g.mine.length) lines.push(`${nameOf(myId())}が好き: ${list(g.mine)}`);
    if (pid && g.theirs.length) lines.push(`${nameOf(pid)}が好き: ${list(g.theirs)}`);
    return lines.length ? lines.join("\n") : "（登録がありません）";
  }

  const items = summaryItems();
  if (!items.length) return "（登録がありません）";
  const lines = [];
  for (const kind of ["allergy", "dislike"]) {
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

/**
 * にがて／すき の切り替え。
 * 配色は <html data-mode> を見て CSS 側がまるごと入れ替える。
 * ブラウザのUI（アドレスバー等）の色も追随させるため theme-color も差し替える。
 */
function setMode(mode) {
  if (!DB.POLARITIES[mode]) return;
  state.mode = mode;
  document.documentElement.dataset.mode = mode;

  $$("[data-mode]", $("#modebar")).forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode))
  );

  // ブラウザのテーマ色（実際の背景色をそのまま渡す）
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));

  // モードで意味が変わる文言
  const like = mode === "like";
  $("#filter-lv3-label").textContent = like ? "「大好き」だけ表示" : "レベル3だけ表示";
  $("#btn-open-share-label").textContent = like ? "共有する" : "お店に伝える";

  resetAddForm();
  renderAll();
}

/** モード切替バーが appbar の真下に貼り付くよう、実測した高さを top に入れる */
function applyModebarOffset() {
  const bar = $("#modebar");
  const appbar = $(".appbar");
  if (bar && appbar) bar.style.top = `${appbar.offsetHeight}px`;
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

async function addItem({ food, kind, level, category, note = "" }) {
  const name = String(food || "").trim();
  if (!name) {
    toast("名前を入力してください。", { error: true });
    return false;
  }
  if (!kind || !level) {
    toast("区分とレベルを選んでください。", { error: true });
    return false;
  }
  if (!state.room) return false;

  /*
   * 重複の検知は「にがて／すき」をまたいで行う。
   * 同じものを両方に入れてしまうと、相手から見たときにどちらを信じるべきか
   * 分からなくなるため、特に反対側に既にある場合ははっきり伝える。
   */
  const dup = allItems()
    .filter((r) => r.user_id === myId())
    .find((r) => normalizeFood(r.food) === normalizeFood(name));
  if (dup) {
    const dupPolarity = DB.polarityOf(dup.kind);
    const opposite = dupPolarity !== DB.polarityOf(kind);
    const where = DB.POLARITIES[dupPolarity].label;
    const lv = DB.levelInfo(dup.kind, dup.level).label;
    const ok = await confirmDialog({
      title: opposite ? "反対側に登録されています" : "すでに登録されています",
      body: opposite
        ? `「${dup.food}」は「${where}」に ${lv} として登録済みです。\n両方に入れると、相手からどちらか分からなくなります。\nこのまま追加しますか？`
        : `「${dup.food}」は ${DB.KINDS[dup.kind].label}／${lv} として登録済みです。\nもう一度追加しますか？`,
      okLabel: "追加する",
      danger: opposite,
    });
    if (!ok) return false;
  }

  const id = DB.newId();
  const now = new Date().toISOString();
  // 楽観的更新: 先に画面へ出す。id はクライアント採番なので、
  // Realtime のエコーが先に来ても id が一致してマージされる（重複表示しない）。
  mergeRow({
    id, room_id: state.room.id, user_id: myId(),
    food: name, kind, level: Number(level), category, note,
    created_at: now, updated_at: now, _pending: true,
  });
  renderAll();

  try {
    const saved = await DB.addRestriction({
      id, roomId: state.room.id, userId: myId(),
      food: name, kind, level, category, note,
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

/**
 * 削除。確認ダイアログは出さず、即削除して5秒間「元に戻す」を出す。
 * アレルギー項目のときは、その帯を警告色にして見逃しにくくする。
 */
async function removeItem(row) {
  state.restrictions.delete(row.id);
  renderAll();

  try {
    await DB.deleteRestriction(row.id);
    toast(`「${row.food}」を削除しました`, {
      duration: 5000,
      danger: row.kind === "allergy",
      action: { label: "元に戻す", run: () => undoDelete(row) },
    });
  } catch (err) {
    mergeRow(row);                            // 消せなかったので戻す
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
  const polarity = DB.polarityOf(row.kind);
  $("#edit-food").value = row.food;
  $("#edit-note").value = row.note || "";
  $("#edit-level-legend").textContent = DB.POLARITIES[polarity].levelLabel;
  // すき側に区分は無いので隠す（にがて⇄すき の付け替えは編集では行わない）
  $("#edit-kind-field").hidden = polarity === "like";

  buildSeg($("#edit-category"), "edit-category", CATEGORY_OPTIONS, row.category || "ingredient",
    { withIcon: (v) => DB.CATEGORIES[v].icon });
  buildSeg($("#edit-kind"), "edit-kind", KIND_OPTIONS, row.kind,
    { withIcon: (v) => DB.KINDS[v].icon });
  buildSeg($("#edit-level"), "edit-level", levelOptions(polarity), String(row.level), { stacked: true });

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
    level: Number(segValue($("#edit-level")) || row.level),
    category: segValue($("#edit-category")) || row.category || "ingredient",
  };
  if (!patch.food.trim()) {
    toast("名前は空にできません。", { error: true });
    return;
  }
  // 何も変わっていないなら通信しない
  const changed = ["food", "note", "kind", "level", "category"].some(
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

  /*
   * ホーム画面から起動している場合、マジックリンクは必ず Safari 側で開いてしまい
   * このアプリには戻ってこられない（保存領域が別のため）。
   * その環境ではコード入力を主役に切り替える。
   */
  if (Auth.isStandalone()) {
    $("#standalone-note").hidden = false;
    $("#otp-card").open = true;
    $("#otp-summary").textContent = "コードでログイン";
    $("#otp-help").textContent =
      "「ログイン用メールを送る」を押したあと、届いたメールの数字のコードをここに入力してください。リンクの方はタップしないでください。";
  }

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
        Auth.isStandalone()
          ? "メールを送りました。リンクはタップせず、本文の数字のコードを下の欄に入力してください。（届かない場合は迷惑メールもご確認ください）"
          : "メールを送りました。届いたリンクを開くか、コードを下の欄に入力してください。（届かない場合は迷惑メールもご確認ください）",
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
  setMode(state.mode);         // 配色・文言・フォームをモードに合わせて初期化（内部で描画まで行う）
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
 * 追加フォーム
 * ================================================================== */

/**
 * 追加ボタンの活性判定。
 * にがて側は「区分＋レベル」、すき側は区分が無いので「好き度」だけが必須。
 */
function refreshAddButton() {
  const needKind = state.mode === "avoid";
  if (needKind) markSegFilled($("#add-kind"));
  markSegFilled($("#add-level"));
  const kindOk = !needKind || Boolean(segValue($("#add-kind")));
  $("#btn-add").disabled = !(kindOk && segValue($("#add-level")));
}

/** フォームを初期状態（区分・レベルは未選択、分類は食材）に戻す */
function resetAddForm() {
  const like = state.mode === "like";
  $("#add-food").value = "";
  $("#add-note").value = "";
  $("#add-food").placeholder = like ? "例: ハンバーグ／いちご" : "例: えび／エビチリ";
  $("#add-title").textContent = like ? "好きなものを追加する" : "にがてを追加する";
  $("#add-level-legend").textContent = DB.POLARITIES[state.mode].levelLabel;
  $("#add-level-help").textContent = like
    ? "1 まあ好き ／ 2 好き ／ 3 大好き"
    : "1 好んでは食べない ／ 2 食べられるが極力避けたい ／ 3 食べられない・苦手";

  // すきモードに区分は無いので、まるごと隠す
  $("#add-kind-field").hidden = like;

  buildSeg($("#add-category"), "add-category", CATEGORY_OPTIONS, "ingredient",
    { withIcon: (v) => DB.CATEGORIES[v].icon });
  buildSeg($("#add-kind"), "add-kind", KIND_OPTIONS, null,
    { withIcon: (v) => DB.KINDS[v].icon });
  buildSeg($("#add-level"), "add-level", levelOptions(state.mode), null, { stacked: true });
  refreshAddButton();
}

/* ================================================================== *
 * イベント配線
 * ================================================================== */

function wireEvents() {
  mountIcons();               // HTML に置いたプレースホルダをSVGに差し替える

  // --- タブ ---
  $$("[data-tabbtn]").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tabbtn))
  );

  // --- にがて／すき の切り替え ---
  $$("[data-mode]", $("#modebar")).forEach((b) =>
    b.addEventListener("click", () => {
      if (state.mode === b.dataset.mode) return;
      setMode(b.dataset.mode);
      window.scrollTo({ top: 0 });
    })
  );

  // --- 追加フォーム ---
  resetAddForm();
  guardIme($("#add-food"), () => $("#form-add").requestSubmit());
  guardIme($("#add-note"), () => $("#form-add").requestSubmit());
  $("#add-kind").addEventListener("change", refreshAddButton);
  $("#add-level").addEventListener("change", refreshAddButton);

  $("#form-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await addItem({
      food: $("#add-food").value,
      // すきモードに区分の選択肢は無いので固定
      kind: state.mode === "like" ? "like" : segValue($("#add-kind")),
      level: segValue($("#add-level")),
      category: segValue($("#add-category")) || "ingredient",
      note: $("#add-note").value,
    });
    // 選び忘れによる誤登録を防ぐため、追加後は必ず未選択に戻す
    if (ok) {
      resetAddForm();
      $("#add-food").focus();
    }
  });

  // --- 招待 ---
  $("#btn-share").addEventListener("click", () =>
    shareOrCopy(
      {
        title: "ふたりごはん への招待",
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
  $("#filter-lv3").addEventListener("change", (e) => {
    state.filterLv3 = e.target.checked;
    renderSummary();
  });
  $("#btn-open-share").addEventListener("click", openShareDialog);

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
  const remeasure = () => { applyFooterHeight(); applyModebarOffset(); };
  remeasure();
  window.addEventListener("resize", remeasure);
  window.addEventListener("orientationchange", () => setTimeout(remeasure, 200));
  // フォント読み込みやアドレスバーの伸縮でも高さが変わるので、保険として監視も張る
  if (window.ResizeObserver) {
    new ResizeObserver(remeasure).observe($(".footerbar"));
    new ResizeObserver(applyModebarOffset).observe($(".appbar"));
  }
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

  // ログイン情報をブラウザに消されにくくする（対応環境のみ・失敗しても無害）
  Auth.requestPersistentStorage();

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
