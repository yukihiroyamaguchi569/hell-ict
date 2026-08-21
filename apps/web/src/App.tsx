import {
  commandResultSchema,
  leaderboardSnapshotSchema,
  teamCodeSchema,
  teamSnapshotSchema,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import type {
  CommandResult,
  LeaderboardSnapshot,
  Stage1EmailId,
  TeamSnapshot,
} from "@hell-ict/domain";
import { useCallback, useEffect, useRef, useState } from "react";

import { postJson } from "./http-client.js";
import { BriefingOverlay } from "./stage1/briefing-overlay.js";
import { Stage1Screen } from "./stage1/stage1-screen.js";

const savedTeamCodeKey = "hell-ict-team-code";
const isTeamCode = (value: string): boolean => teamCodeSchema.safeParse(value).success;
const socketUrl = (path: string): string =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

const submitEnterStage1 = async (
  snapshot: TeamSnapshot,
  commandId: string,
): Promise<CommandResult> => {
  const parsed = commandResultSchema.safeParse(
    await postJson(`/api/teams/${snapshot.teamCode}/commands`, {
      type: "enter-stage1",
      commandId,
      expectedRevision: snapshot.revision,
    }),
  );
  if (!parsed.success) throw new Error();
  return parsed.data;
};

const submitStage1Reply = async (
  snapshot: TeamSnapshot,
  params: { commandId: string; emailId: Stage1EmailId; text: string },
): Promise<CommandResult> => {
  const parsed = commandResultSchema.safeParse(
    await postJson(`/api/teams/${snapshot.teamCode}/commands`, {
      type: "submit-stage1-reply",
      commandId: params.commandId,
      expectedRevision: snapshot.revision,
      emailId: params.emailId,
      text: params.text,
    }),
  );
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
  const [message, setMessage] = useState("6桁のチームコードを入力してください。");
  const enterStage1CommandId = useRef<string | null>(null);
  // ラウンド1は複数のメールへ並行して返信しうるため、emailIdごとにcommandIdを保持する。
  // 同じメールへの再試行は同じcommandIdを再利用し、二重適用を防ぐ（enterStage1と同じ考え方）。
  const replyCommandIds = useRef(new Map<Stage1EmailId, string>());
  const teamGeneration = useRef(0);
  const leaderboardGeneration = useRef(0);

  const acceptTeamSnapshot = useCallback((next: TeamSnapshot) => {
    setSnapshot((current) =>
      current === null || next.revision >= current.revision ? next : current,
    );
  }, []);

  // チームsyncはteam/chatの両envelopeを配信するが、AIチャットペインはラウンド1では
  // 存在しないため（docs/ui/02_Stage1.md §狙い）、ここではchat kindを無視する。
  const acceptTeamSyncMessage = useCallback(
    (next: { kind: "team"; snapshot: TeamSnapshot } | { kind: "chat" }) => {
      if (next.kind === "team") acceptTeamSnapshot(next.snapshot);
    },
    [acceptTeamSnapshot],
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

  const join = async (): Promise<void> => {
    if (!isTeamCode(teamCode)) {
      setMessage("ASCII数字6桁で入力してください。");
      return;
    }
    try {
      const parsed = teamSnapshotSchema.safeParse(await postJson("/api/session", { teamCode }));
      if (!parsed.success) throw new Error();
      localStorage.setItem(savedTeamCodeKey, teamCode);
      setJoinedCode(teamCode);
      acceptTeamSnapshot(parsed.data);
      setMessage("おかえりなさい。チーム状態を復元しました。");
    } catch {
      setMessage("入室できませんでした。接続を確認して再試行してください。");
    }
  };

  const acknowledgeBriefing = async (): Promise<void> => {
    if (snapshot === null) return;
    enterStage1CommandId.current ??= crypto.randomUUID();
    try {
      const result = await submitEnterStage1(snapshot, enterStage1CommandId.current);
      acceptTeamSnapshot(result.snapshot);
      enterStage1CommandId.current = null;
    } catch {
      setMessage("結果を確認できません。もう一度押すと同じ操作を安全に再試行します。");
    }
  };

  const submitReply = async (emailId: Stage1EmailId, text: string): Promise<void> => {
    if (snapshot === null) throw new Error();
    let commandId = replyCommandIds.current.get(emailId);
    commandId ??= crypto.randomUUID();
    replyCommandIds.current.set(emailId, commandId);
    const result = await submitStage1Reply(snapshot, { commandId, emailId, text });
    acceptTeamSnapshot(result.snapshot);
    replyCommandIds.current.delete(emailId);
  };

  if (snapshot === null || joinedCode === null)
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

  if (snapshot.state.stage === "prologue")
    return (
      <BriefingOverlay
        onAcknowledge={() => {
          void acknowledgeBriefing();
        }}
      />
    );

  return (
    <Stage1Screen
      state={snapshot.state}
      teamCode={joinedCode}
      leaderboard={leaderboard}
      onSubmitReply={submitReply}
    />
  );
};
