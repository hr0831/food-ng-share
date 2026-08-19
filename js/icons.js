/**
 * アイコン（インラインSVG）。
 *
 * 絵文字を使わないのは、同じ文字でも OS やフォントによって見た目が大きく変わり、
 * 端末によっては豆腐（□）になるため。アレルギーの警告に環境依存の記号を使うのは危険。
 * 外部アイコンライブラリも読み込まず、必要な形だけをここに持つ。
 *
 * すべて 24x24 の線画で統一し、色は currentColor に従う（CSSから色を制御できる）。
 */

const PATHS = {
  /* ロゴ: 器と葉 */
  logo: `
    <path d="M2.6 12.2h18.8a9.4 9.4 0 0 1-18.8 0Z"/>
    <path d="M12.4 9.9c-.6-3.1 1.2-6 4.4-7 .8 3.2-1.1 6.2-4.4 7Z"/>
    <path d="M9.4 9.9C8.9 8.2 7.5 7 5.9 6.7c-.3 1.8.8 3.5 2.6 4"/>
  `,
  /* アレルギー: 警告の三角 */
  allergy: `
    <path d="M10.3 4.3 1.8 18.5a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/>
    <path d="M12 9.5v4"/>
    <path d="M12 17.2h.01"/>
  `,
  /* 苦手・好み: 除外を表す丸とマイナス */
  dislike: `
    <circle cx="12" cy="12" r="8.6"/>
    <path d="M8.2 12h7.6"/>
  `,
  /* 食材: 葉 */
  ingredient: `
    <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z"/>
    <path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12"/>
  `,
  /* 料理: 器と湯気 */
  dish: `
    <path d="M3.2 12.4h17.6a8.8 8.8 0 0 1-17.6 0Z"/>
    <path d="M9 3.4c-.8 1-.8 1.9 0 2.9"/>
    <path d="M13.2 2.8c-.9 1.2-.9 2.3 0 3.5"/>
  `,
  /* タブ1: マイリスト（書く） */
  mine: `
    <path d="M12 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V12"/>
    <path d="M18.4 2.9a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6-3.6 1 1-3.6Z"/>
  `,
  /* タブ2: 相手のリスト（人） */
  partner: `
    <path d="M19.5 20.5v-1.8a4 4 0 0 0-4-4h-7a4 4 0 0 0-4 4v1.8"/>
    <circle cx="12" cy="7.5" r="4"/>
  `,
  /* タブ3: まとめ（一覧） */
  summary: `
    <path d="M15.5 4.5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h2"/>
    <rect x="8.5" y="2.5" width="7" height="4" rx="1.4"/>
    <path d="M8.5 12h7"/>
    <path d="M8.5 16h4.5"/>
  `,
  /* 設定 */
  settings: `
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2v.2a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14.3H2.8a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.7 3.6V3.4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z"/>
  `,
  /* 編集へ進む矢印 */
  chevron: `<path d="m9.5 18 6-6-6-6"/>`,
  /* 削除（スワイプの背面） */
  trash: `
    <path d="M3.5 6.2h17"/>
    <path d="M8.5 6.2V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v1.7"/>
    <path d="M18.6 6.2 17.8 19a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5.4 6.2"/>
  `,
  /* 共有 */
  share: `
    <path d="M4.5 12.5v6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6"/>
    <path d="m15.5 6.5-3.5-3.5-3.5 3.5"/>
    <path d="M12 3v12"/>
  `,
  /* コピー */
  copy: `
    <rect x="9" y="9" width="11.5" height="11.5" rx="2"/>
    <path d="M5.5 15h-1a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2H12a2 2 0 0 1 2 2v1"/>
  `,
  /* 完了 */
  check: `<path d="m20 6.5-11 11-5-5"/>`,
  /* 招待（つなぐ） */
  invite: `
    <path d="M16 11.5h4.5"/>
    <path d="M18.2 9.2v4.6"/>
    <path d="M12.5 20.5v-1.8a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v1.8"/>
    <circle cx="6.5" cy="7.5" r="4"/>
  `,
  /* 空状態（何もない） */
  empty: `
    <path d="M20.5 12.5h-4l-1.5 3h-6l-1.5-3h-4"/>
    <path d="M4.9 6.1 2.5 12.5v5a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-5l-2.4-6.4a2 2 0 0 0-1.9-1.3H6.8a2 2 0 0 0-1.9 1.3Z"/>
  `,
};

/**
 * アイコンの SVG 要素を作る。
 * @param {keyof PATHS} name
 * @param {{size?: number, className?: string}} opts
 */
export function icon(name, { size = 20, className = "" } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("ico");
  if (className) svg.classList.add(...className.split(" ").filter(Boolean));
  // 中身は上の定数だけ。利用者の入力は一切混ざらないので innerHTML で問題ない。
  svg.innerHTML = PATHS[name] || "";
  return svg;
}

/** 既存要素をアイコンで置き換える（HTML側に置いたプレースホルダ用） */
export function mountIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    const size = Number(el.dataset.iconSize || 20);
    el.replaceChildren(icon(el.dataset.icon, { size }));
  }
}
