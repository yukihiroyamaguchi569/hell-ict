import { GAME_STAGE_IDS, gameViewResponseSchema, type TeamGameScene } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  appScreen,
  appShellView,
  centerView,
  clearEffectScene,
  stageMissionFacts,
  welcomeAction,
} from "../src/app-view.js";
import type { GameSessionStatus, GameView } from "../src/composables/use-game-session.js";
import { stageRegistry } from "../src/stages/registry.js";
import type { StageModule } from "../src/stages/stage-module.js";
import { START_MS, viewBody } from "./fakes.js";

const WELCOME: GameView = gameViewResponseSchema.parse(viewBody(0));
const INBOX: GameView = {
  ...WELCOME,
  state: { ...WELCOME.state, inbox: { openedAt: WELCOME.serverNow, sent: [] } },
};

const BUILT: StageModule = { setup: () => ({ center: { render: () => null } }) };

describe("appScreen", () => {
  it("入室が通るまでは、どの状態でも入室画面（書き込める画面を出さない）", () => {
    for (const status of ["idle", "joining", "restore-failed"] as const) {
      expect(appScreen(status, null), status).toBe("entry");
      // 画面の状態が残っていても、ready でなければ操作画面は出さない
      expect(appScreen(status, WELCOME), status).toBe("entry");
    }
    expect(appScreen("ready", null)).toBe("entry");
  });

  it("入室したら、受信トレイを開く前はウェルカム、開いた後はゲーム画面", () => {
    expect(appScreen("ready", WELCOME)).toBe("welcome");
    expect(appScreen("ready", INBOX)).toBe("game");
  });

  it("古くなった端末は、状態の有無にかかわらず再読み込みの案内", () => {
    const stale: GameSessionStatus = "stale";
    expect(appScreen(stale, WELCOME)).toBe("stale");
    expect(appScreen(stale, null)).toBe("stale");
  });
});

describe("appShellView", () => {
  it("入室前は、始めたばかりのチームと同じ平時の器でペインを出さない", () => {
    expect(appShellView(null, null)).toEqual({
      stage: "prologue",
      mode: "peace",
      fever: 3,
      crescendo: false,
      left: "hidden",
      right: "hidden",
    });
  });

  it("受信トレイを開いたら左ペインを出し、AIペインは右に畳んでおく", () => {
    expect(appShellView(INBOX, null)).toMatchObject({ left: "shown", right: "collapsed" });
  });

  it("ステージの上書きが右ペインに効く。入室前は効かない", () => {
    expect(appShellView(INBOX, "shown").right).toBe("shown");
    expect(appShellView(null, "shown").right).toBe("hidden");
  });
});

describe("centerView（中央に何を出すか）", () => {
  it("ウェルカム：Prologue が未実装でも［メールを開く］を押すまではウェルカム", () => {
    expect(centerView("welcome", null, false)).toBe("welcome");
    expect(centerView("welcome", BUILT, false)).toBe("welcome");
  });

  it("ウェルカム：Prologue が未実装なら、押した後は「この先は準備中です」", () => {
    expect(centerView("welcome", null, true)).toBe("coming-soon");
  });

  it("ウェルカム：Prologue が実装済みなら、押しても受信トレイが開くまではウェルカムのまま", () => {
    expect(centerView("welcome", BUILT, true)).toBe("welcome");
  });

  it("ゲーム画面：ステージが未実装なら準備中、実装済みならステージの中央", () => {
    expect(centerView("game", null, false)).toBe("coming-soon");
    expect(centerView("game", BUILT, false)).toBe("stage");
  });

  it("入室画面と古いタブでは、中央に何も出さない（ステージの中身も準備中も）", () => {
    for (const screen of ["entry", "stale"] as const) {
      for (const module of [null, BUILT]) {
        for (const left of [false, true]) {
          expect(centerView(screen, module, left), screen).toBe("none");
        }
      }
    }
  });
});

describe("welcomeAction", () => {
  it("Prologue が未実装なら inbox.open を送らず準備中へ", () => {
    expect(welcomeAction(null)).toBe("coming-soon");
  });

  it("Prologue が実装済みなら inbox.open を送る", () => {
    expect(welcomeAction(BUILT)).toBe("send-inbox-open");
  });
});

describe("stageRegistry", () => {
  it("全ステージの入口がある（登録の無いステージも null として並ぶ）", () => {
    expect(Object.keys(stageRegistry).sort()).toEqual([...GAME_STAGE_IDS].sort());
  });
});

describe("clearEffectScene", () => {
  const cleared: TeamGameScene = {
    kind: "clear-sequence",
    stage: "s1",
    next: "s2",
    handover: false,
  };

  it("未登録のステージはクリア済みでも演出の場面を渡さない（advance を送らせない）", () => {
    expect(clearEffectScene(cleared, null, false)).toBeNull();
    expect(clearEffectScene(cleared, null, true)).toBeNull();
  });

  it("登録済みのステージは場面をそのまま渡す。場面が無ければ null", () => {
    expect(clearEffectScene(cleared, BUILT, false)).toBe(cleared);
    expect(clearEffectScene(null, BUILT, false)).toBeNull();
  });

  it("ステージが演出を保留している間は、クリア済みでも場面を渡さない", () => {
    expect(clearEffectScene(cleared, BUILT, true)).toBeNull();
    expect(clearEffectScene(null, BUILT, true)).toBeNull();
  });
});

describe("stageMissionFacts", () => {
  const ownDeadline = { at: START_MS + 60_000, label: "締切", overText: null };

  it("ステージが締切を持たなければ枠の締切のまま（Prologue はメールを開いている間だけ）", () => {
    expect(stageMissionFacts(INBOX.state, "p0", BUILT).deadline).not.toBeNull();
    expect(stageMissionFacts(INBOX.state, null, BUILT).deadline).toBeNull();
    expect(stageMissionFacts(INBOX.state, "p0", null)).toEqual(
      stageMissionFacts(INBOX.state, "p0", BUILT),
    );
  });

  it("ステージの締切があればそれに置き換える。null を返せば締切を出さない", () => {
    const seen: unknown[] = [];
    const withDeadline: StageModule = {
      ...BUILT,
      missionDeadline: (state, focus) => {
        seen.push([state.game.stage, focus]);
        return ownDeadline;
      },
    };
    expect(stageMissionFacts(INBOX.state, "p1", withDeadline).deadline).toBe(ownDeadline);
    expect(seen).toEqual([["prologue", "p1"]]);
    const hides: StageModule = { ...BUILT, missionDeadline: () => null };
    expect(stageMissionFacts(INBOX.state, "p1", hides).deadline).toBeNull();
    expect(stageMissionFacts(INBOX.state, "p1", hides).title).toBe("Prologue　受信トレイ");
  });
});
