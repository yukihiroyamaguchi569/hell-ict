import {
  chatMessageResultSchema,
  commandResultSchema,
  createThreadResultSchema,
  leaderboardSnapshotSchema,
  teamCodeSchema,
  sessionResultSchema,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import type {
  ChatSnapshot,
  CommandResult,
  LeaderboardSnapshot,
  TeamSnapshot,
} from "@hell-ict/domain";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatPane } from "./chat-pane.js";
import { HttpRequestError, postJson } from "./http-client.js";

/**
 * ゲームマスターのリセットより前に入室した端末からの書き込みか。サーバは進捗・
 * チェックポイント・会話・コマンドのどの経路でも同じcodeで返すので、判定は1か所で足りる。
 */
const isStaleGeneration = (caught: unknown): boolean =>
  caught instanceof HttpRequestError && caught.code === "stale-generation";

/**
 * 入室手続きの結末。`superseded`は「あとから始まった入室に追い越された」で、
 * 失敗ではない——エラー表示を出すと、成功した側の画面に無関係な警告が残る。
 */
type SessionOutcome = "ok" | "failed" | "superseded";

const savedTeamCodeKey = "hell-ict-team-code";
const isTeamCode = (value: string): boolean => teamCodeSchema.safeParse(value).success;
const socketUrl = (path: string): string =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

const submitStage1 = async (
  snapshot: TeamSnapshot,
  commandId: string,
  generation: number,
): Promise<CommandResult> => {
  const parsed = commandResultSchema.safeParse(
    await postJson(`/api/teams/${snapshot.teamCode}/commands`, {
      type: "enter-stage1",
      commandId,
      expectedRevision: snapshot.revision,
      generation,
    }),
  );
  if (!parsed.success) throw new Error();
  return parsed.data;
};

const submitCreateThread = async (
  teamCode: string,
  commandId: string,
  title: string,
  generation: number,
): Promise<ChatSnapshot> => {
  const parsed = createThreadResultSchema.safeParse(
    await postJson(`/api/teams/${teamCode}/chat/threads`, {
      type: "create-thread",
      commandId,
      title,
      generation,
    }),
  );
  if (!parsed.success) throw new Error();
  return parsed.data.snapshot;
};

/**
 * 送信の宛先と内容、そしてリセット世代。max-params（4）に収めるため1つにまとめる。
 */
type ChatMessageRequest = {
  readonly commandId: string;
  readonly threadId: string;
  readonly text: string;
  readonly generation: number;
};

const submitChatMessage = async (
  teamCode: string,
  request: ChatMessageRequest,
): Promise<ChatSnapshot> => {
  const parsed = chatMessageResultSchema.safeParse(
    await postJson(`/api/teams/${teamCode}/chat/messages`, {
      type: "send-message",
      ...request,
    }),
  );
  if (!parsed.success) throw new Error();
  return parsed.data.snapshot;
};

/** 帯の表示だけを持つ。App本体の分岐を増やさないための切り出し。 */
const LeaderboardPane = ({ snapshot }: { snapshot: LeaderboardSnapshot | null }) => (
  <aside>
    <h2>リーダーボード</h2>
    {snapshot?.entries.map((entry) => (
      <p key={entry.marker}>
        {entry.marker}
        {entry.isSelf ? "（自チーム）" : ""}: {entry.stage}
      </p>
    ))}
  </aside>
);

/**
 * リロードでの復帰。以前は保存済みコードからWebSocketだけを開き直していたため、
 * 世代を持たないまま操作できてしまい、リセット後は書き込みが全部409になった。
 * 復帰でも`/api/session`を呼び直し、最新のsnapshotと世代を取り直す。
 *
 * Appの外へ出すのは、コンポーネント本体の分岐を増やさないため（複雑度の上限）。
 */
const useRestoredSession = (
  joinedCode: string | null,
  openedCode: { current: string | null },
  openSession: (code: string) => Promise<SessionOutcome>,
  onFailure: () => void,
): void => {
  useEffect(() => {
    if (joinedCode === null || openedCode.current === joinedCode) return;
    // 追い越された（superseded）ときは何も言わない。フォームから入り直した側が
    // 成功しているので、そこへ「取得できません」を出すと嘘になる。
    void openSession(joinedCode).then((outcome) => {
      if (outcome === "failed") onFailure();
    }, onFailure);
  }, [joinedCode, onFailure, openSession, openedCode]);
};

export const App = () => {
  const [teamCode, setTeamCode] = useState(() => localStorage.getItem(savedTeamCodeKey) ?? "");
  const [joinedCode, setJoinedCode] = useState<string | null>(() => {
    const saved = localStorage.getItem(savedTeamCodeKey);
    return saved !== null && isTeamCode(saved) ? saved : null;
  });
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardSnapshot | null>(null);
  const [leaderboardPending, setLeaderboardPending] = useState(false);
  const [message, setMessage] = useState("6桁のチームコードを入力してください。");
  const commandId = useRef<string | null>(null);
  const teamGeneration = useRef(0);
  const leaderboardGeneration = useRef(0);
  /**
   * サーバのリセット世代。入室応答でしか手に入らないので、取れるまで（null）は
   * 書き込みを一切送らない——0を仮置きすると、リセット済みのチームへ古い世代で
   * 書きに行くことになる。WebSocket接続名の世代（teamGeneration）とは別物。
   */
  const [resetGeneration, setResetGeneration] = useState<number | null>(null);
  /** ゲームマスターのリセットより前に入室していた端末。以後の書き込みは通らない。 */
  const [stale, setStale] = useState(false);
  /** どのコードで入室手続きを済ませたか。リロード復帰の二重実行を防ぐ。 */
  const openedCode = useRef<string | null>(null);
  /** 入室手続きの連番。並走したときに、最後に始めたものの応答だけを採る。 */
  const sessionSeq = useRef(0);

  const acceptTeamSnapshot = useCallback((next: TeamSnapshot) => {
    setSnapshot((current) =>
      current === null || next.revision >= current.revision ? next : current,
    );
  }, []);

  const acceptChatSnapshot = useCallback((next: ChatSnapshot) => {
    setChatSnapshot((current) =>
      current === null || next.revision >= current.revision ? next : current,
    );
  }, []);

  const acceptTeamSyncMessage = useCallback(
    (next: { kind: "team"; snapshot: TeamSnapshot } | { kind: "chat"; snapshot: ChatSnapshot }) => {
      if (next.kind === "team") acceptTeamSnapshot(next.snapshot);
      else acceptChatSnapshot(next.snapshot);
    },
    [acceptChatSnapshot, acceptTeamSnapshot],
  );

  const connect = useCallback(
    (code: string) => {
      const connectSocket = <T,>(
        path: string,
        generation: { current: number },
        parse: (value: unknown) => { success: boolean; data?: T },
        accept: (value: T) => void,
      ): (() => void) => {
        const current = ++generation.current;
        let retry = 0;
        let socket: WebSocket | null = null;
        let timer: number | null = null;
        const open = (): void => {
          socket = new WebSocket(socketUrl(path));
          socket.onmessage = (event) => {
            if (generation.current !== current || typeof event.data !== "string") return;
            try {
              const parsed = parse(JSON.parse(event.data) as unknown);
              if (parsed.success && parsed.data !== undefined) accept(parsed.data);
            } catch {
              /* 不正な配信は表示状態を変えない。 */
            }
          };
          socket.onclose = () => {
            if (generation.current !== current) return;
            timer = window.setTimeout(open, Math.min(5_000, 250 * 2 ** retry));
            retry = Math.min(retry + 1, 5);
          };
        };
        open();
        return () => {
          generation.current += 1;
          if (timer !== null) window.clearTimeout(timer);
          socket?.close();
        };
      };
      const closeTeam = connectSocket(
        `/api/teams/${code}/sync`,
        teamGeneration,
        (input) => teamSyncMessageSchema.safeParse(input),
        acceptTeamSyncMessage,
      );
      const closeLeaderboard = connectSocket(
        `/api/leaderboard/sync?teamCode=${code}`,
        leaderboardGeneration,
        (input) => leaderboardSnapshotSchema.safeParse(input),
        setLeaderboard,
      );
      return () => {
        closeTeam();
        closeLeaderboard();
      };
    },
    [acceptTeamSyncMessage],
  );

  useEffect(() => {
    if (joinedCode === null) return;
    return connect(joinedCode);
  }, [connect, joinedCode]);

  /**
   * 入室手続き。snapshotと世代は`/api/session`が1回のやり取りで返すので、必ずここを
   * 通す。手で入室したときも、保存済みコードからの復帰でも同じ経路にする。
   */
  const reportRestoreFailure = useCallback(() => {
    setMessage("進行状況を取得できません。接続を確認して再読み込みしてください。");
  }, []);

  const openSession = useCallback(async (code: string): Promise<SessionOutcome> => {
    const seq = ++sessionSeq.current;
    const parsed = sessionResultSchema.safeParse(
      await postJson("/api/session", { teamCode: code }),
    );
    // 待っている間に別の入室が始まっていたら、この応答は捨てる。保存済みコードからの
    // 復元が遅れている最中にフォームから別のチームで入ると、遅い応答があとから
    // 世代とsnapshotを上書きし、「表示は別チーム・世代は前のチーム」になる。
    if (seq !== sessionSeq.current) return "superseded";
    if (!parsed.success) return "failed";
    openedCode.current = code;
    setResetGeneration(parsed.data.generation);
    // 入室応答はその時点のサーバ正で、世代と組で受け取っている。revisionの単調性
    // （acceptTeamSnapshot）は通さずそのまま採る——別チームへ入り直したときや、
    // リセットでrevisionが0へ戻ったときに、手元の大きいrevisionが勝ってしまう。
    setSnapshot(parsed.data);
    return "ok";
  }, []);

  useRestoredSession(joinedCode, openedCode, openSession, reportRestoreFailure);

  const join = async (): Promise<void> => {
    if (!isTeamCode(teamCode)) {
      setMessage("ASCII数字6桁で入力してください。");
      return;
    }
    try {
      const outcome = await openSession(teamCode);
      if (outcome === "superseded") return;
      if (outcome === "failed") throw new Error();
      localStorage.setItem(savedTeamCodeKey, teamCode);
      setJoinedCode(teamCode);
      setMessage("おかえりなさい。チーム状態を復元しました。");
    } catch {
      setMessage("入室できませんでした。接続を確認して再試行してください。");
    }
  };

  const enterStage1 = async (): Promise<void> => {
    if (snapshot === null || resetGeneration === null) return;
    commandId.current ??= crypto.randomUUID();
    try {
      const result = await submitStage1(snapshot, commandId.current, resetGeneration);
      acceptTeamSnapshot(result.snapshot);
      setLeaderboardPending(result.leaderboardPending);
      if (!result.leaderboardPending) commandId.current = null;
      setMessage(
        result.leaderboardPending
          ? "リーダーボードの同期が未完了です。再試行してください。"
          : "Stage 1へ進みました。",
      );
    } catch (caught) {
      if (isStaleGeneration(caught)) {
        setStale(true);
        return;
      }
      setMessage("結果を確認できません。もう一度押すと同じ操作を安全に再試行します。");
    }
  };

  /**
   * 世代切れを拾って全画面表示へ倒す。呼び出し側の再試行やpending保持は
   * そのまま動かしたいので、握りつぶさず投げ直す。
   */
  const markStaleAndRethrow = (caught: unknown): never => {
    if (isStaleGeneration(caught)) setStale(true);
    throw caught;
  };

  const createThread = async (threadCommandId: string, title: string): Promise<void> => {
    if (joinedCode === null || resetGeneration === null) throw new Error();
    acceptChatSnapshot(
      await submitCreateThread(joinedCode, threadCommandId, title, resetGeneration).catch(
        markStaleAndRethrow,
      ),
    );
  };

  const sendChatMessage = async (
    messageCommandId: string,
    threadId: string,
    text: string,
  ): Promise<void> => {
    if (joinedCode === null || resetGeneration === null) throw new Error();
    acceptChatSnapshot(
      await submitChatMessage(joinedCode, {
        commandId: messageCommandId,
        threadId,
        text,
        generation: resetGeneration,
      }).catch(markStaleAndRethrow),
    );
  };

  // 以後どの書き込みも通らないので、操作できる画面を出さない。案内は再読み込みだけ
  // ——モックの #ov-stale と同じ扱いで、閉じられる案内は嘘になる。
  if (stale)
    return (
      <main>
        <p className="eyebrow">聖クロノス総合病院 / ICT研修</p>
        <h1>地獄のICT</h1>
        <p role="status">この端末の状態は古くなっています。ページを再読み込みしてください。</p>
        <button
          type="button"
          onClick={() => {
            location.reload();
          }}
        >
          再読み込みする
        </button>
      </main>
    );

  if (snapshot === null)
    return (
      <main>
        <p className="eyebrow">聖クロノス総合病院 / ICT研修</p>
        <h1>地獄のICT</h1>
        <label htmlFor="team-code">チームコード</label>
        <input
          id="team-code"
          inputMode="numeric"
          maxLength={6}
          value={teamCode}
          onChange={(event) => {
            setTeamCode(event.target.value);
          }}
        />
        <button
          type="button"
          onClick={() => {
            void join();
          }}
        >
          入室する
        </button>
        <p role="status">{message}</p>
      </main>
    );

  return (
    <main>
      <header>
        <p className="eyebrow">聖クロノス総合病院 / ICT研修</p>
        <h1>地獄のICT</h1>
        <p>在院 398/400・空床 2・原因不明の発熱 3</p>
      </header>
      <section>
        <h2>{snapshot.state.stage === "prologue" ? "Prologue: 着任" : "Stage 1: 平常運転"}</h2>
        <p>
          {snapshot.state.stage === "prologue"
            ? "何も起きていません。いい一日になりますように。"
            : "事務長からの通達により、メール処理を開始します。"}
        </p>
        {snapshot.state.stage === "prologue" && (
          <button
            type="button"
            onClick={() => {
              void enterStage1();
            }}
          >
            了解しました
          </button>
        )}
        {snapshot.state.stage === "stage1" && leaderboardPending && (
          <button
            type="button"
            onClick={() => {
              void enterStage1();
            }}
          >
            リーダーボード同期を再試行
          </button>
        )}
        <p role="status">{message}</p>
      </section>
      <LeaderboardPane snapshot={leaderboard} />
      <ChatPane
        snapshot={chatSnapshot}
        onCreateThread={createThread}
        onSendMessage={sendChatMessage}
      />
    </main>
  );
};
