/**
 * 「あそぶ」タブのロジック。
 *
 * 目的: 面倒な登録作業を遊びに置き換える。
 * 方針: ここには計算とジェスチャーだけを置き、画面の組み立ては ui.js に残す
 *       （描画の作法を1か所に集めておくため）。
 *
 * 新しいテーブルは1つも使わない。
 *   仕分けの答え … そのまま restrictions に入る
 *   おみくじ     … 日付とルームIDから計算で出す（保存しない）
 *   相性度       … 手元のデータを数えるだけ
 */

import { FOODS } from "./foods.js";
import { normalizeFood, polarityOf } from "./data.js";

/** 1セットの問題数。信号待ちで終わる長さに収める */
export const SET_SIZE = 10;

/* ================================================================== *
 * 日付と乱数
 * ================================================================== */

/**
 * 日本時間の日付（YYYY-MM-DD）。
 * 端末のタイムゾーン設定に頼ると、片方が海外・片方が国内のときに
 * 「同じ日のおみくじ」がずれる。固定で +9時間して日付だけ取り出す。
 */
export function jstDateKey(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 文字列 → 32bit の種。FNV-1a */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 種から再現可能な乱数列を作る（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================== *
 * おみくじ
 * ================================================================== */

/**
 * 運勢。
 * 凶を入れるのは、外れがあるから当たりが嬉しくなるため。ただし文言は
 * 必ず前向きにし、食べ物の話だけで完結させる（運勢で人を不安にさせない）。
 * weight は出やすさ。大吉と凶を細くして、真ん中を厚くしている。
 */
/**
 * 期待度の上限。演出が「どこまで昇格するか」を決める。
 * 良い運勢ほど上まで行くので、途中で「今日はいけるかも」が分かる。
 */
const HEAT_MAX = {
  kyo: 1, suekichi: 2, kichi: 2, shokichi: 3, chukichi: 4, daikichi: 5,
};

export const FORTUNES = [
  { key: "daikichi", label: "大吉", weight: 1, message: "迷ったら、いちばん食べたいものを選んで正解の日。" },
  { key: "chukichi", label: "中吉", weight: 2, message: "いつもの店に、まだ頼んでいない一品がある日。" },
  { key: "shokichi", label: "小吉", weight: 3, message: "分け合うと、おいしさが増える日。" },
  { key: "kichi", label: "吉", weight: 3, message: "お腹のすき具合に、素直になるとうまくいく日。" },
  { key: "suekichi", label: "末吉", weight: 2, message: "少し待つと、いい席が空く日。" },
  { key: "kyo", label: "凶", weight: 1, message: "今日は奇をてらわず、好きなものを食べるのが吉。" },
];

/**
 * その食べ物が「ふたりとも食べられる」か。
 * アレルギーと、にがてのレベル3（食べられない）を除く。
 * どちらか一方でも該当すれば候補から外す。
 */
function isSafeForBoth(name, restrictions) {
  const key = normalizeFood(name);
  return !restrictions.some(
    (r) =>
      normalizeFood(r.food) === key &&
      (r.kind === "allergy" || (polarityOf(r.kind) === "avoid" && Number(r.level) === 3))
  );
}

/**
 * 今日のおみくじ。
 *
 * ルームIDと日付だけで決まるので、二人の端末で必ず同じ結果になる。
 * 保存も通信も要らない（テーブルを1つも増やさずに済んでいるのはこのため）。
 *
 * ラッキーごはんは「開始位置を決めて、安全なものが見つかるまで前へ進む」方式。
 * 候補配列そのものを引くと、片方だけ同期が一瞬遅れたときに結果がずれるため。
 */
export function drawOmikuji(roomId, dateKey, restrictions = []) {
  const rnd = mulberry32(hash32(`${roomId}:${dateKey}`));

  const total = FORTUNES.reduce((sum, f) => sum + f.weight, 0);
  let pick = rnd() * total;
  let fortune = FORTUNES[FORTUNES.length - 1];
  for (const f of FORTUNES) {
    pick -= f.weight;
    if (pick < 0) { fortune = f; break; }
  }

  const start = Math.floor(rnd() * FOODS.length);
  let food = null;
  for (let i = 0; i < FOODS.length; i++) {
    const cand = FOODS[(start + i) % FOODS.length];
    if (isSafeForBoth(cand.name, restrictions)) { food = cand; break; }
  }

  /*
   * 演出用の情報。
   * fake は「本来の上限よりひとつ上まで見せてから落ちる」ガセ。
   * これがあると、上まで上がっても安心できなくなり、毎回ひやりとする。
   *
   * ★この rnd() は必ず最後に呼ぶこと。
   *   途中に差し込むと乱数の並びがずれて、過去と同じ日でも結果が変わってしまう。
   */
  const heat = { max: HEAT_MAX[fortune.key] || 2, fake: rnd() < 0.25 };

  return { fortune, food, dateKey, heat };
}

/* ================================================================== *
 * 出題
 * ================================================================== */

/**
 * 次の10問を選ぶ。
 * 登録済み・とばし済みのものは出さない。定番8：変わり種2 を保ちながら、
 * 足りない側は余っている側で埋める（在庫切れで出題が止まらないように）。
 */
export function pickQuestions(excludedKeys, count = SET_SIZE) {
  const available = FOODS.filter((f) => !excludedKeys.has(normalizeFood(f.name)));
  if (!available.length) return [];

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const common = shuffle(available.filter((f) => !f.rare));
  const rare = shuffle(available.filter((f) => f.rare));

  const wantRare = Math.round(count * 0.2);
  const picked = [
    ...rare.slice(0, wantRare),
    ...common.slice(0, count - wantRare),
  ];
  // どちらかが足りなかった分を、もう片方の残りで埋める
  if (picked.length < count) {
    const used = new Set(picked.map((f) => f.name));
    for (const f of [...common, ...rare]) {
      if (picked.length >= count) break;
      if (!used.has(f.name)) { picked.push(f); used.add(f.name); }
    }
  }
  return shuffle(picked);
}

/** まだ出題できる問題が残っているか */
export function remainingCount(excludedKeys) {
  return FOODS.filter((f) => !excludedKeys.has(normalizeFood(f.name))).length;
}

/* ================================================================== *
 * とばした問題の記憶（端末内）
 * ================================================================== */

/*
 * 「とばす」はデータとして残らないので、端末に覚えておく。
 * サーバに置かないのは、テーブルを増やさないため。端末を変えると
 * また出てくるが、もう一度とばすだけで済むので害が小さい。
 *
 * 既存のキー（food-ng-share.auth など）は決して変えないこと。ここは新規キー。
 */
const skipKey = (userId) => `food-ng-share.gameSkipped.${userId || "anon"}`;

export function loadSkipped(userId) {
  try {
    const raw = localStorage.getItem(skipKey(userId));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function saveSkipped(userId, set) {
  try {
    // 際限なく増えないよう、新しいものから300件だけ残す
    localStorage.setItem(skipKey(userId), JSON.stringify([...set].slice(-300)));
  } catch {
    /* 容量超過やプライベートモードなら諦めてよい（また出題されるだけ） */
  }
}

/* ================================================================== *
 * 相性度
 * ================================================================== */

/**
 * ふたりとも登録しているものの中で、にがて／すきの向きが一致した割合。
 * 片方しか登録していないものは「まだ答えが揃っていない」として数えない。
 */
export function compatibility(mine, theirs) {
  const mineMap = new Map();
  for (const r of mine) mineMap.set(normalizeFood(r.food), polarityOf(r.kind));

  let total = 0;
  let matched = 0;
  const seen = new Set();
  for (const r of theirs) {
    const key = normalizeFood(r.food);
    if (seen.has(key) || !mineMap.has(key)) continue;
    seen.add(key);
    total += 1;
    if (mineMap.get(key) === polarityOf(r.kind)) matched += 1;
  }
  return { total, matched, percent: total ? Math.round((matched / total) * 100) : 0 };
}

/**
 * 今やった1セットのうち、相手と向きが一致したものの名前を返す。
 * 通知の本文に使う。
 */
export function matchedInSet(answers, theirs) {
  const theirMap = new Map();
  for (const r of theirs) theirMap.set(normalizeFood(r.food), polarityOf(r.kind));

  const names = [];
  for (const a of answers) {
    const key = normalizeFood(a.food);
    if (theirMap.get(key) === a.polarity) names.push(a.food);
  }
  return names;
}

/* ================================================================== *
 * 扇スワイプ
 * ================================================================== */

/** 確定に必要な距離。これ未満はただの手ぶれとして無視する */
export const MIN_DISTANCE = 70;
/** 水平からこれ以上立っている（ほぼ真上・真下）と、どちらとも判定しない */
export const MAX_ELEVATION = 70;
/** レベルの境目。上下それぞれ25度より外で「強い／弱い」に変わる */
export const LEVEL_BOUNDARY = 25;

/**
 * 指の向きから「どの区画か」を求める。
 *
 *        大好き(3)          食べられない(3)
 *           ＼              ／
 *   好き(2) ──●──  …  ──●── 極力避けたい(2)
 *           ／              ＼
 *      まあ好き(1)          好まない(1)
 *           右＝すき          左＝にがて
 *
 * @returns {{side:"like"|"avoid", level:1|2|3, elev:number, dist:number}|null}
 */
export function zoneFor(dx, dy) {
  const dist = Math.hypot(dx, dy);
  if (dist < MIN_DISTANCE) return null;

  // 右を0度、上を+90度とする角度
  const ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const right = Math.abs(ang) <= 90;
  // 左右それぞれで「水平からの仰角」に直す（左側は鏡写しになる）
  const elev = right ? ang : ang > 0 ? 180 - ang : -180 - ang;
  if (Math.abs(elev) > MAX_ELEVATION) return null;

  const level = elev > LEVEL_BOUNDARY ? 3 : elev < -LEVEL_BOUNDARY ? 1 : 2;
  return { side: right ? "like" : "avoid", level, elev, dist };
}

/**
 * カードに扇スワイプを付ける。
 *
 * 扇の中心は「カードの中心」ではなく「指を置いた場所」。
 * 親指は弧を描くので、カード中心を基準にすると右下に寄って
 * 「まあ好き」ばかりになる。指の開始点を基準にすれば、どこから
 * 始めても本人の感覚どおりの角度で測れる。
 *
 * @param {HTMLElement} el     動かすカード
 * @param {object} handlers    onPreview(zone|null) / onCommit(zone) / onStart() / onEnd()
 */
export function attachFanSwipe(el, { onPreview, onCommit, onStart, onEnd }) {
  let active = false;
  let originX = 0;
  let originY = 0;
  let last = null;

  const paint = (dx, dy) => {
    const tilt = Math.max(-12, Math.min(12, dx * 0.05));
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${tilt}deg)`;
  };

  const reset = () => {
    active = false;
    last = null;
    el.style.transition = "transform .18s ease";
    el.style.transform = "";
    onPreview?.(null);
    onEnd?.();
    // 次のドラッグで追従が鈍らないよう、戻し終わったら transition を外す
    setTimeout(() => { el.style.transition = ""; }, 200);
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    active = true;
    originX = e.clientX;
    originY = e.clientY;
    last = null;
    el.style.transition = "";
    try { el.setPointerCapture(e.pointerId); } catch { /* 未対応環境は無視 */ }
    onStart?.();
  });

  el.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    paint(dx, dy);
    last = zoneFor(dx, dy);
    onPreview?.(last);
  });

  const finish = () => {
    if (!active) return;
    const zone = last;
    if (zone) {
      // 離した瞬間に見えていた判定で確定する
      active = false;
      onPreview?.(null);
      onEnd?.();
      onCommit?.(zone);
      el.style.transition = "";
      el.style.transform = "";
    } else {
      reset();
    }
  };

  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", reset);
}
