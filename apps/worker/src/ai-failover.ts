import type { AiGateway, AiRequest, AiResponse } from "@hell-ict/domain";

import { OpenAiGateway, OpenAiRequestError } from "./openai-gateway.js";
import type { ExtraRequestBody, OpenAiFailure } from "./openai-gateway.js";

/**
 * 予備キー・予備モデルへの切り替え（Issue #217）。
 *
 * 2026-09-26本番では主キーのクレジットが尽き（429 insufficient_quota）、補充するまで
 * 約11分AIが止まった。主系が「原因のはっきりした失敗」を返したときだけ、同じ依頼を
 * 予備へ1回だけ送り直す。
 *
 * 切り替えるのは、OpenAIが生成の前に断ったと分かる失敗に限る——キーが使えない
 * （401・403・429 insufficient_quota）か、モデルが使えない（model_not_found・404）か。
 * どちらも課金されずに返るので、予備へ送り直しても二重課金にならない。
 * 一時的なレート制限（429 rate_limit_exceeded）・5xx・タイムアウト・通信断・応答の形の
 * 不一致では切り替えない。タイムアウトと通信断はOpenAI側で生成が進み課金されている
 * 可能性があり、予備へ送ると同じ依頼に二重に払う。レート制限と5xxは待てば直る失敗で、
 * 参加者の再試行（503）で足りる——ここで予備の組織の枠まで使い始めると、主系が戻った
 * 後も切り替えの判断が揺れる。
 */

/**
 * どの経路でAIを呼んだか。活動ログとhealthに出す。`fallback`は運営が`AI_ROUTE`で手で
 * 切り替えた他社の予備（OpenAIそのものの障害への備え。下の`createAiGateway`）。
 */
export type AiRoute = "primary" | "backup-key" | "backup-model" | "fallback";

/** 自動で切り替える経路。手で切り替える`fallback`は保持の対象にしない。 */
type AutoRoute = Exclude<AiRoute, "fallback">;

/** 切り替えの原因。キーが使えないか、モデルが使えないか。 */
export type AiSwitchCause = "key" | "model";

/**
 * 失敗が切り替えの対象か判定する。モデル起因を先に見る——プロジェクトに権限の無い
 * モデルは403でmodel_not_foundを返すことがあり、キーを替えても直らない。
 */
export const switchCauseOf = (failure: OpenAiFailure): AiSwitchCause | null => {
  if (failure.reason !== "http_error") return null;
  if (failure.code === "model_not_found" || failure.status === 404) return "model";
  if (failure.status === 401 || failure.status === 403) return "key";
  if (failure.status === 429 && failure.code === "insufficient_quota") return "key";
  return null;
};

const ROUTE_FOR_CAUSE = {
  key: "backup-key",
  model: "backup-model",
} as const satisfies Record<AiSwitchCause, AutoRoute>;

/**
 * 切り替えた状態を保つ時間。この間は主系を呼ばずに予備へ直接送り、主系への無駄な
 * 往復を省く。過ぎたら主系を1回試し、戻っていればそのまま主系へ戻る（クレジットを
 * 補充すれば、運営が何もしなくても5分以内に主系へ戻る）。
 */
export const AI_ROUTE_HOLD_MS = 5 * 60 * 1000;

/**
 * 切り替えた状態。Workerのisolateのメモリにだけ持つ——保持の目的は主系への無駄な
 * 往復を省くことだけで、isolateごとにずれても（各isolateが1回ずつ主系を試すだけで）
 * 正しさは変わらない。DO・KVへ置くと、チャットのたびに読み書きが1往復増える。
 */
export class AiRouteState {
  private route: AutoRoute = "primary";
  private untilMs = 0;

  constructor(private readonly holdMs: number = AI_ROUTE_HOLD_MS) {}

  current(nowMs: number): AutoRoute {
    return nowMs < this.untilMs ? this.route : "primary";
  }

  hold(route: AutoRoute, nowMs: number): void {
    this.route = route;
    this.untilMs = nowMs + this.holdMs;
  }

  release(): void {
    this.route = "primary";
    this.untilMs = 0;
  }
}

/** 経路ごとの接続。予備が未設定の経路はnull。 */
export type AiRouteGateways = {
  readonly primary: AiGateway;
  readonly "backup-key": AiGateway | null;
  readonly "backup-model": AiGateway | null;
};

/** 活動ログへ足すmeta。どの経路で呼び、この送信で切り替えたなら原因は何か。 */
export type AiRouteMeta = { aiRoute: AiRoute; aiSwitchCause?: AiSwitchCause };

/**
 * 主系が確定的に失敗したときだけ予備へ1回送り直すAiGateway。1回の送信で呼ぶのは
 * 主系と予備を合わせて最大2回で、予備の結果（成功も失敗も）をそのまま返す。
 * 送信ごとに作り直す前提で、どの経路で呼んだかを`routeMeta`に持つ。
 */
export class FailoverAiGateway implements AiGateway {
  routeMeta: AiRouteMeta = { aiRoute: "primary" };

  constructor(
    private readonly gateways: AiRouteGateways,
    private readonly state: AiRouteState,
    private readonly now: () => number,
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    const startedAt = this.now();
    const held = this.state.current(startedAt);
    const heldGateway = held === "primary" ? null : this.gateways[held];
    if (heldGateway !== null) {
      // 切り替えを保っている間は主系を呼ばない。同じ送信の中で主系へ戻すこともしない
      // （1回の送信で呼ぶのは1回まで）。
      this.routeMeta = { aiRoute: held };
      return heldGateway.complete(request).catch((caught: unknown) => {
        // 予備も確定的に使えなくなったなら保持を解き、次の送信は主系から試す
        // （主系のクレジットを補充した後に、保持が切れるまで待たせない）。
        if (caught instanceof OpenAiRequestError && switchCauseOf(caught.failure) !== null)
          this.state.release();
        throw caught;
      });
    }
    try {
      return await this.gateways.primary.complete(request);
    } catch (caught) {
      return this.completeWithBackup(request, caught, startedAt);
    }
  }

  private async completeWithBackup(
    request: AiRequest,
    primaryError: unknown,
    startedAt: number,
  ): Promise<AiResponse> {
    const cause =
      primaryError instanceof OpenAiRequestError ? switchCauseOf(primaryError.failure) : null;
    if (cause === null) throw primaryError;
    const route = ROUTE_FOR_CAUSE[cause];
    const backup = this.gateways[route];
    // 予備には主系が使い残した時間だけを渡す。1回の送信がタイムアウト（と、それを
    // 前提にしたDOのクレーム猶予）を超えて続かないようにする。
    const remainingMs = request.timeoutMs - (this.now() - startedAt);
    if (backup === null || remainingMs <= 0) throw primaryError;
    this.routeMeta = { aiRoute: route, aiSwitchCause: cause };
    const response = await backup.complete({ ...request, timeoutMs: remainingMs });
    // 予備で通ったときだけ保持する。予備も失敗したなら、次の送信は主系から試し直す。
    this.state.hold(route, this.now());
    return response;
  }
}

/**
 * 手で切り替えた他社の予備（`AI_ROUTE=fallback`）。経路は常に`fallback`で、自動の
 * 切り替え（`FailoverAiGateway`）も保持も使わない。OpenAIそのものが落ちたときの備えで、
 * OpenAIの予備キー・予備モデルへは連鎖しない。
 */
export class FallbackAiGateway extends OpenAiGateway {
  readonly routeMeta: AiRouteMeta = { aiRoute: "fallback" };
}

/**
 * 予備（Anthropicの互換の接続先、claude-haiku-5-5）の呼び出しにだけ足す指定。思考を
 * 切る——ゲームは思考を求めず、思考の分だけ遅く高くなる。互換の接続先は
 * `reasoning_effort`を無視し`thinking`を通す。ai-bench（scripts/ai-bench/config.ts）で
 * 比較と負荷テスト（60同時・900件すべて成功）に使ったのと同じ本文にそろえる。
 */
export const FALLBACK_EXTRA_BODY = {
  thinking: { type: "disabled" },
} as const satisfies ExtraRequestBody;

/**
 * AI経路に要る設定だけを抜き出した型。`Env`の`vars`はwrangler typesがリテラル型にするので、
 * テストから別の宛先を渡せるよう`string`で受ける（`Env`はそのまま代入できる）。
 */
export type AiEnv = {
  readonly OPENAI_BASE_URL: string;
  readonly OPENAI_API_KEY: string;
  readonly OPENAI_MODEL: string;
  readonly OPENAI_API_KEY_BACKUP?: string | undefined;
  readonly OPENAI_MODEL_BACKUP?: string | undefined;
  readonly AI_ROUTE?: string | undefined;
  readonly AI_FALLBACK_BASE_URL?: string | undefined;
  readonly AI_FALLBACK_API_KEY?: string | undefined;
  readonly AI_FALLBACK_MODEL?: string | undefined;
};

/** 空文字は未設定として扱う（`wrangler secret put`で空を入れて無効にできるように）。 */
const configured = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

/** 予備の設定を読む。主系と同じ値は予備にならないので未設定とみなす。 */
const backupSettings = (
  env: AiEnv,
): { readonly key: string | null; readonly model: string | null } => {
  const key = configured(env.OPENAI_API_KEY_BACKUP);
  const model = configured(env.OPENAI_MODEL_BACKUP);
  return {
    key: key === env.OPENAI_API_KEY ? null : key,
    model: model === env.OPENAI_MODEL ? null : model,
  };
};

/**
 * 他社の予備の接続先。https以外（http・URLでない値・資格情報入りのURL）は、キーと
 * 参加者の入力を平文や想定外の宛先へ送らないよう未設定とみなす。末尾の`/`は落とす
 * （`/chat/completions`をつなぐため）。クエリ・フラグメント付き（空の`?`・`#`を含む）も
 * 未設定とみなす——つないだパスがその中に入り、意図した宛先へ届かないのにhealthは
 * `fallback`と出てしまう。空の`?`・`#`は`URL`の`search`・`hash`に現れないので、元の文字列で見る。
 */
const httpsBaseUrl = (value: string | undefined): string | null => {
  const raw = configured(value);
  if (raw === null || /[?#]/.test(raw) || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return raw.replace(/\/+$/, "");
};

type FallbackSettings = { readonly baseUrl: string; readonly key: string; readonly model: string };

/** 他社の予備の設定。3つのどれかが欠けて（または使えない値で）いればnull。 */
const fallbackSettings = (env: AiEnv): FallbackSettings | null => {
  const baseUrl = httpsBaseUrl(env.AI_FALLBACK_BASE_URL);
  const key = configured(env.AI_FALLBACK_API_KEY);
  const model = configured(env.AI_FALLBACK_MODEL);
  return baseUrl === null || key === null || model === null ? null : { baseUrl, key, model };
};

/**
 * 今使う他社の予備。`AI_ROUTE`が`fallback`で、予備の3つがそろっているときだけ返す。
 * それ以外（未設定・空・`primary`・書き損じ・予備の不足）は主系のまま動かす——
 * 切り替えの書き損じでAIを止めない。どちらで動いているかはhealthの`ai.route`で分かる。
 */
const activeFallback = (env: AiEnv): FallbackSettings | null =>
  env.AI_ROUTE === "fallback" ? fallbackSettings(env) : null;

/** isolateで共有する切り替え状態。チャットとhealthが同じものを見る。 */
export const sharedAiRouteState = new AiRouteState();

export const createAiGateway = (
  env: AiEnv,
  state: AiRouteState = sharedAiRouteState,
): AiGateway => {
  const fallback = activeFallback(env);
  if (fallback !== null)
    return new FallbackAiGateway(
      fallback.baseUrl,
      fallback.key,
      fallback.model,
      FALLBACK_EXTRA_BODY,
    );
  const backup = backupSettings(env);
  const gateway = (apiKey: string, model: string): OpenAiGateway =>
    new OpenAiGateway(env.OPENAI_BASE_URL, apiKey, model);
  return new FailoverAiGateway(
    {
      primary: gateway(env.OPENAI_API_KEY, env.OPENAI_MODEL),
      "backup-key": backup.key === null ? null : gateway(backup.key, env.OPENAI_MODEL),
      "backup-model": backup.model === null ? null : gateway(env.OPENAI_API_KEY, backup.model),
    },
    state,
    Date.now,
  );
};

/** 活動ログへ足す経路のmeta。経路を持たないAiGateway（テスト用のFake）は何も足さない。 */
export const aiRouteMeta = (gateway: AiGateway): Partial<AiRouteMeta> =>
  gateway instanceof FailoverAiGateway || gateway instanceof FallbackAiGateway
    ? gateway.routeMeta
    : {};

/**
 * healthへ載せるAI経路の状態。キーの値・一部・長さは出さない（healthはOrigin不問で
 * 誰でも読める）。予備モデル名・接続先は秘密ではないが、設定の有無だけで確認には足りる。
 * `route`は手で切り替えた`fallback`を先に見る。それ以外はhealthに応答したisolateの
 * 自動の切り替えの状態で、他のisolateとずれることがある。
 */
export const aiRouteStatus = (
  env: AiEnv,
  state: AiRouteState,
  nowMs: number,
): {
  route: AiRoute;
  backupKey: boolean;
  backupModel: boolean;
  fallbackConfigured: boolean;
} => {
  const backup = backupSettings(env);
  return {
    route: activeFallback(env) === null ? state.current(nowMs) : "fallback",
    backupKey: backup.key !== null,
    backupModel: backup.model !== null,
    fallbackConfigured: fallbackSettings(env) !== null,
  };
};
