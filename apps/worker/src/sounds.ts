/**
 * 効果音mp3の配信（`GET /sounds/<name>.mp3`）。
 *
 * 音源は効果音ラボで、規約が素材の再配布を禁じている。このリポジトリは公開なので
 * `.gitignore`で`assets/sounds/`ごと除外してあり、mp3の実体はコミットされていない。
 * かつては`scripts/build-testplay.sh`が手元の`assets/sounds/`を
 * `apps/worker/public/sounds/`へコピーして静的アセットとして配っていたが、
 * `main`へのマージで走る自動デプロイ（.github/workflows/deploy.yml）は
 * クリーンチェックアウトで音源を持たないため、本番では全て404になっていた。
 * そこで配信元をR2バケット（`hell-ict-sounds`、binding `SOUNDS`）へ一本化する。
 * 投入は`scripts/upload-sounds.sh`で行う。
 *
 * 音源は同一オリジンの`<audio>`（モックの`sfx()`が`new Audio()`で読む）から
 * 取りに来るため、`/api/*`の入口ガード（src/guard.ts）は当てない。Originヘッダーの
 * 付かないGETになるので、当てると鳴らなくなる。伏せる情報を含まない公開素材であり、
 * 許可リストの外へは何も出さないので、この経路にガードは要らない。
 */

/**
 * 配信する効果音の許可リスト。`docs/ui/mock/index.html`の`sfx()`が鳴らす7点で、
 * これ以外の名前はR2に何が入っていても配らない。
 */
export const SOUND_NAMES = [
  "cancel",
  "decision1",
  "don-1",
  "emergency-alert1",
  "hall-clapping-hands1",
  "mobile-phone-ringtone1",
  "success1",
] as const;

/** このモジュールが扱うパスの接頭辞。 */
export const SOUNDS_PATH_PREFIX = "/sounds/";

/**
 * R2キーとして受け付ける形。小文字英数字とハイフンだけの`.mp3`に限る。
 * 許可リストと二重に掛けるのは、リストの編集ミスで`/`や`%`や`.`を含む名前が
 * 紛れ込んでもキーの形を崩せないようにするためである。
 */
const SOUND_KEY_PATTERN = /^[a-z0-9-]+\.mp3$/;

const ALLOWED_SOUND_KEYS: ReadonlySet<string> = new Set(
  SOUND_NAMES.map((name) => `${name}.mp3`).filter((key) => SOUND_KEY_PATTERN.test(key)),
);

/** R2から取り出したオブジェクトのうち、配信に使う部分だけ。 */
export type SoundObject = { readonly body: ReadableStream; readonly httpEtag: string };

/**
 * R2バケットのうち、このモジュールが使う操作だけ。`R2Bucket`をそのまま受けずに
 * 構造で絞るのは、テストからFakeを注入し「検証で落ちたときにR2を呼んでいない」ことを
 * 呼び出し回数で確かめられるようにするためである（`env.SOUNDS`はこの形を満たす）。
 */
export type SoundsBucket = { get(key: string): Promise<SoundObject | null> };

/** 経路が無いときと同じ応答。存在しないキーも不正な名前もこれへ揃える。 */
const notFound = (): Response => new Response("Not found", { status: 404 });

/**
 * `/sounds/<file>`から、R2へ問い合わせてよいキーを取り出す。外れたらnull。
 *
 * `new URL()`は`/sounds/../x.mp3`を`/x.mp3`へ正規化するので接頭辞で外れ、
 * `%2e%2e`のようなパーセント符号化はデコードされないまま残るので正規表現で外れる。
 * 二重スラッシュ（`/sounds//decision1.mp3`）と大文字も同じく正規表現が弾く。
 */
export const soundKeyFromPath = (pathname: string): string | null => {
  if (!pathname.startsWith(SOUNDS_PATH_PREFIX)) return null;
  const key = pathname.slice(SOUNDS_PATH_PREFIX.length);
  if (!SOUND_KEY_PATTERN.test(key)) return null;
  return ALLOWED_SOUND_KEYS.has(key) ? key : null;
};

/**
 * 研修は120分で、同じ音を何度も鳴らす。1日キャッシュさせて2回目以降は
 * ブラウザのキャッシュで済ませる（当日に差し替える運用は無い）。
 */
const SOUND_CACHE_CONTROL = "public, max-age=86400";

/**
 * 検証済みのキーをR2から返す。見つからなければ404。
 * Content-Typeはこの経路がmp3しか配らないので固定で与える。
 */
const soundObjectResponse = async (bucket: SoundsBucket, key: string): Promise<Response> => {
  const object = await bucket.get(key);
  if (object === null) return notFound();
  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Cache-Control": SOUND_CACHE_CONTROL,
  });
  // httpEtagはR2が必ず付けるが、Fakeや将来の実装で欠けても配信自体は続けられる。
  if (object.httpEtag.length > 0) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
};

/**
 * `GET /sounds/*`のハンドラー。名前の検証で落ちた場合はR2へ触らずに404を返す。
 */
export const handleSoundRequest = (bucket: SoundsBucket, pathname: string): Promise<Response> => {
  const key = soundKeyFromPath(pathname);
  if (key === null) return Promise.resolve(notFound());
  return soundObjectResponse(bucket, key);
};
