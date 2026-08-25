/**
 * Supabase の接続設定。
 *
 * この2つの値は「ブラウザから見えて構わない」種類の情報です。そのまま
 * GitHub のパブリックリポジトリにコミットして問題ありません。
 * 誰がどのデータを読み書きできるかは、サーバ側の RLS ポリシーだけで決まります。
 *
 * ★絶対にやってはいけないこと★
 *   secret キー（sb_secret_... で始まるもの）をこのファイルに書くこと。
 *   secret キーは RLS を無視して全データにアクセスできます。
 *   フロントエンドにも、リポジトリにも、絶対に置かないでください。
 *
 * 値の取得場所:
 *   Supabase ダッシュボード > Project Settings > API Keys
 *     - Project URL          → SUPABASE_URL
 *     - Publishable key      → SUPABASE_PUBLISHABLE_KEY（sb_publishable_... で始まる）
 */

/*
 * 注意: ここに書くのは「プロジェクトURL」であって REST エンドポイントではありません。
 * ダッシュボードに出てくる https://xxxx.supabase.co/rest/v1/ のような URL から
 * /rest/v1/ を取り除いたものを指定します（supabase-js が /rest/v1 や /auth/v1 を
 * 自分で付け足すため、付けたままだと /rest/v1/rest/v1/... になって全滅します）。
 */
export const SUPABASE_URL = "https://habksqmojofyceswcrkm.supabase.co";

export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5dzFkfMvb1Eplrsuo6-d-w_PzDXt0dd";

/*
 * プッシュ通知用の公開カギ（VAPID public key）。
 *
 * tools/vapid.html をブラウザで開いて「カギを作る」で生成し、
 * 出てきた①の値をここに貼ります。公開されて構わない種類のカギです。
 *
 * 空のままなら、通知の機能そのものが画面に出ません（他の機能は普通に動きます）。
 *
 * ★対になる「秘密のカギ」は、Supabase の Edge Functions シークレットにだけ
 *   登録してください。ここや GitHub には絶対に書かないこと。
 */
export const VAPID_PUBLIC_KEY =
  "BKte5grIGOz3RMyAa13mm4uU36dS25_G10wP5V3WHdgtubt3WBvByY9dpFCSE4rkPtXRkNUSiLlaOlJY5ZNDqO4";

/** 設定がプレースホルダのままかどうか（未設定の案内を出すために使う） */
export const IS_CONFIGURED =
  !SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
  !SUPABASE_PUBLISHABLE_KEY.includes("XXXXXXXX");
