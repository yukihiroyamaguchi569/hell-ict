/**
 * commandIdを「その内容」に束縛するための指紋。
 *
 * commandIdは冪等キーだが、それ自体は内容と結びついていない。同じIDで別の内容を
 * 送られると、DOは「同じコマンドの再送」とみなして元の結果を返し、クライアントは
 * 送ったつもりの内容が消えたことに気づけない。台帳へ指紋を残し、再送のたびに
 * 突き合わせて取り違えを弾く。
 */

/** SHA-256の16進64桁。WebCryptoは非同期なので、DOの外（Worker側）で計算して渡す。 */
export const sha256Hex = async (source: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * キーの並び順に依存しないJSON文字列。`JSON.stringify`は挿入順をそのまま出すので、
 * 同じ内容でもキー順が違うだけで別の指紋になり、正当な再送を取り違えとして弾いて
 * しまう。オブジェクトのキーを毎回ソートして畳む。
 */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    const body = entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",");
    return `{${body}}`;
  }
  // JSON.stringifyは型定義上stringを返すが、undefinedや関数には実際にはundefinedを
  // 返す。指紋の材料なので、その場合は"null"へ畳んで安定させる。
  const encoded: unknown = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "null";
};

/**
 * スレッド作成の指紋。同じcommandIdで別のタイトル・別のkindを送る取り違えを弾く。
 * 区切りに改行を挟むのは、隣接するフィールドの境界を潰さないため。
 */
export const createThreadFingerprint = (command: {
  readonly title: string;
  readonly kind: string;
}): Promise<string> => sha256Hex(`${command.title}\n${command.kind}`);

/**
 * チェックポイントの指紋。bodyはdataに任意のJSONを含むので、キー順を安定化してから
 * 畳む（stableStringify）。
 */
export const checkpointFingerprint = (body: unknown): Promise<string> =>
  sha256Hex(stableStringify(body));
