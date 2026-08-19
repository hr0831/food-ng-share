/**
 * supabase-js v2.58.0 をリポジトリに同梱したもの（バージョン固定）。
 *
 * なぜ同梱するか:
 *   CDN（esm.sh / jsDelivr）を実行時に参照すると、CDN が落ちた・社内ネットワークで
 *   ブロックされた・将来バージョンが変わった、といった理由でアプリが動かなくなる。
 *   ここでは jsDelivr の `+esm` ビルドを依存パッケージごと vendor/esm/ に取り込み、
 *   相対パス import に書き換えてあるので、実行時の外部依存はゼロ。
 *
 * 取得元（再取得したい場合はこの URL を辿って同じ手順を踏む）:
 *   https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm
 *   ├ @supabase/auth-js@2.72.0
 *   ├ @supabase/functions-js@2.5.0
 *   ├ @supabase/node-fetch@2.6.15
 *   ├ @supabase/postgrest-js@1.21.4
 *   ├ @supabase/realtime-js@2.15.5
 *   └ @supabase/storage-js@2.12.2
 *
 * CDN 版に切り替えたい場合は、この行を下のコメントと入れ替えるだけでよい:
 *   export * from "https://esm.sh/@supabase/supabase-js@2.58.0";
 */
export * from "./esm/@supabase_supabase-js@2.58.0.js";
