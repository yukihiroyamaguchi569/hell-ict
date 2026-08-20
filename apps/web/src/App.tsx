import {
  commandResultSchema,
  leaderboardSnapshotSchema,
  teamCodeSchema,
  teamSnapshotSchema,
} from "@hell-ict/domain";
import type { CommandResult, LeaderboardSnapshot, TeamSnapshot } from "@hell-ict/domain";
import { useCallback, useEffect, useRef, useState } from "react";

const savedTeamCodeKey = "hell-ict-team-code";
const isTeamCode = (value: string): boolean => teamCodeSchema.safeParse(value).success;
const socketUrl = (path: string): string =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

const submitStage1 = async (snapshot: TeamSnapshot, commandId: string): Promise<CommandResult> => {
  const response = await fetch(`/api/teams/${snapshot.teamCode}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "enter-stage1", commandId, expectedRevision: snapshot.revision }),
  });
  const parsed = commandResultSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error();
  return parsed.data;
};

export const App = () => {
  const [teamCode, setTeamCode] = useState(() => localStorage.getItem(savedTeamCodeKey) ?? "");
  const [joinedCode, setJoinedCode] = useState<string | null>(() => {
    const saved = localStorage.getItem(savedTeamCodeKey);
    return saved !== null && isTeamCode(saved) ? saved : null;
  });
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardSnapshot | null>(null);
  const [leaderboardPending, setLeaderboardPending] = useState(false);
  const [message, setMessage] = useState("6桁のチームコードを入力してください。");
  const commandId = useRef<string | null>(null);
  const teamGeneration = useRef(0);
  const leaderboardGeneration = useRef(0);

  const acceptTeamSnapshot = useCallback((next: TeamSnapshot) => {
    setSnapshot((current) =>
      current === null || next.revision >= current.revision ? next : current,
    );
  }, []);

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
        (input) => teamSnapshotSchema.safeParse(input),
        acceptTeamSnapshot,
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
    [acceptTeamSnapshot],
  );

  useEffect(() => {
    if (joinedCode === null) return;
    return connect(joinedCode);
  }, [connect, joinedCode]);

  const join = async (): Promise<void> => {
    if (!isTeamCode(teamCode)) {
      setMessage("ASCII数字6桁で入力してください。");
      return;
    }
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamCode }),
      });
      const parsed = teamSnapshotSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error();
      localStorage.setItem(savedTeamCodeKey, teamCode);
      setJoinedCode(teamCode);
      acceptTeamSnapshot(parsed.data);
      setMessage("おかえりなさい。チーム状態を復元しました。");
    } catch {
      setMessage("入室できませんでした。接続を確認して再試行してください。");
    }
  };

  const enterStage1 = async (): Promise<void> => {
    if (snapshot === null) return;
    commandId.current ??= crypto.randomUUID();
    try {
      const result = await submitStage1(snapshot, commandId.current);
      acceptTeamSnapshot(result.snapshot);
      setLeaderboardPending(result.leaderboardPending);
      if (!result.leaderboardPending) commandId.current = null;
      setMessage(
        result.leaderboardPending
          ? "リーダーボードの同期が未完了です。再試行してください。"
          : "Stage 1へ進みました。",
      );
    } catch {
      setMessage("結果を確認できません。もう一度押すと同じ操作を安全に再試行します。");
    }
  };

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
      <aside>
        <h2>リーダーボード</h2>
        {leaderboard?.entries.map((entry) => (
          <p key={entry.marker}>
            {entry.marker}
            {entry.isSelf ? "（自チーム）" : ""}: {entry.stage}
          </p>
        ))}
      </aside>
    </main>
  );
};
