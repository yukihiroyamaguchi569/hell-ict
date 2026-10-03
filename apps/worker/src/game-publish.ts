import type { TeamCode } from "@hell-ict/domain";

import { recordGameActivity } from "./activity-log.js";
import { standingOf } from "./game-store.js";
import type { GameStore } from "./game-store.js";
import { recordGameProgress } from "./progress.js";

/**
 * TeamRoom's publishing of game transitions to the race leaderboard (standing), D1 progress
 * and D1 activity log. The send queues live on the instance, so TeamRoom must hold exactly one
 * GamePublisher per DO instance; creating one per call would drop the one-at-a-time ordering.
 */
export class GamePublisher {
  constructor(private readonly env: Env) {}

  /** 遷移の後始末（帯・進捗・活動ログへの反映）。どれも失敗は握り、印を残して次の機会に送る。 */
  async publish(teamCode: TeamCode, store: GameStore): Promise<void> {
    await Promise.all([
      this.pushGameStanding(teamCode, store),
      this.flushGameProgress(teamCode, store),
      this.flushGameActivity(teamCode, store),
    ]);
  }

  /**
   * 停留所が動いた後の帯（RaceLeaderboard）への反映。失敗しても印を残して戻り、次の
   * コマンドかGETで送り直す——帯が落ちてもゲームは進める。awaitの間に別のコマンドが
   * 進めることがあるが、RaceLeaderboardはseqと世代で古い位置を捨て、印は送ったseqまでしか
   * 消さないので、2つのタブの反映が前後しても古い位置へは戻らない。
   */
  private async pushGameStanding(teamCode: TeamCode, store: GameStore): Promise<void> {
    if (!store.hasPendingStanding()) return;
    const state = store.read();
    if (state === null) return;
    const { standing, seq } = standingOf(state);
    try {
      await this.env.RACE_LEADERBOARD.getByName("global").recordStanding(
        teamCode,
        standing,
        seq,
        store.generation,
      );
    } catch {
      return;
    }
    store.clearPendingStanding(seq);
  }

  /**
   * 進捗の送信の列。同じDOの中で2本が同時に同じ行を読んで二重に積まないよう、送信を
   * 1本ずつ順に走らせる（前の送信が終わってから、次の呼び出しが自分の世代の行を読む）。
   */
  private progressQueue: Promise<void> = Promise.resolve();

  /**
   * 遷移を進捗（D1のprogress_events）へ積む。積めなかった分はgame_progress_outboxに残り、
   * 次のコマンドかGETで送り直す——D1が落ちてもコマンドは通し、遷移は失わない。
   */
  private flushGameProgress(teamCode: TeamCode, store: GameStore): Promise<void> {
    this.progressQueue = this.progressQueue.then(() => this.sendGameProgress(teamCode, store));
    return this.progressQueue;
  }

  /** 失敗は握る（送信待ちの行は残る）。例外を返すと、壊れた1行でコマンドが全部止まる。 */
  private async sendGameProgress(teamCode: TeamCode, store: GameStore): Promise<void> {
    try {
      const pending = store.pendingProgress();
      if (pending === null) return;
      await recordGameProgress(this.env, teamCode, store.generation, pending.events);
      store.clearProgress(pending.lastId);
    } catch {
      // 次のコマンドかGETで送り直す。
    }
  }

  /** 活動ログの送信の列。進捗の列と同じ理由で1本ずつ走らせる（D1の遅れを進捗と足し合わせない）。 */
  private activityQueue: Promise<void> = Promise.resolve();

  /**
   * 提出・判定・罠・罰を活動ログ（D1のactivity_events）へ積む（Issue #235）。積めなかった分は
   * game_activity_outboxに残り、次のコマンドかGETで送り直す——D1が落ちてもコマンドは通す。
   */
  private flushGameActivity(teamCode: TeamCode, store: GameStore): Promise<void> {
    this.activityQueue = this.activityQueue.then(() => this.sendGameActivity(teamCode, store));
    return this.activityQueue;
  }

  /** 区切りごとに送り、空になるまで続ける。失敗は握る（送信待ちの行は残る）。 */
  private async sendGameActivity(teamCode: TeamCode, store: GameStore): Promise<void> {
    try {
      for (let pending = store.pendingActivity(); pending !== null; ) {
        await recordGameActivity(this.env, teamCode, pending.rows);
        store.clearActivity(pending.lastId);
        pending = store.pendingActivity();
      }
    } catch {
      // 次のコマンドかGETで送り直す。
    }
  }
}
