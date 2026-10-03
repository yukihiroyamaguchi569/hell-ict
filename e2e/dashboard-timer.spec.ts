import { readFileSync } from "node:fs";
import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * 会場ディスプレイ用ダッシュボードの残り時間タイマー。
 * 実サーバを立てず、page.routeでHTMLとAPIを差し替え、page.clockで時間を進める。
 */
const dashboardHtml = readFileSync(
  new URL("../apps/worker/dashboard/index.html", import.meta.url),
  "utf8",
);

/**
 * 読み上げのFake。発話したテキスト（空の解錠用は除く）と、声・lang、cancel/speak の呼び出し順を記録する。
 * 声の一覧は window.__voices を先に置けば差し替えられ、window.__voicesChanged() で voiceschanged を発火できる。
 */
const FAKE_SPEECH = `
  window.__spoken = [];
  window.__utterances = [];
  window.__unlocks = 0;
  window.__speechLog = [];
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ""; this.voice = null; }
  };
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => window.__voices || [{ name: "Alex", lang: "en-US" }, { name: "Kyoko", lang: "ja-JP" }],
      addEventListener: (type, listener) => {
        if (type === "voiceschanged") window.__voicesChanged = listener;
      },
      cancel: () => { window.__speechLog.push("cancel"); },
      speak: (utterance) => {
        if (utterance.text === "") { window.__unlocks += 1; return; }
        window.__speechLog.push("speak:" + utterance.text);
        window.__spoken.push(utterance.text);
        window.__utterances.push({ lang: utterance.lang, voice: utterance.voice && utterance.voice.name });
      },
    },
  });
`;

/** 読み上げが使えない環境。 */
const NO_SPEECH = `Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });`;

/**
 * 残り時間が10分の倍数に達するたびに鳴るチャイム（読み上げが使えないときの代わり）。
 * AudioContextをFakeに差し替え、oscillator.startの回数で鳴った回数を数える。
 */
const FAKE_AUDIO = `
  window.__chimeStarts = 0;
  window.AudioContext = class {
    state = "running";
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    createOscillator() {
      return {
        type: "",
        frequency: { value: 0 },
        connect: (node) => node,
        start: () => { window.__chimeStarts += 1; },
        stop: () => {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: (node) => node,
      };
    }
  };
`;

/**
 * 実機のスピーカーから声やチャイムが出ないよう、全テストのページに読み上げとAudioContextのFakeを入れる。
 * 複数の addInitScript の実行順は保証されないため、環境の差し替えは1本のスクリプトで行い、
 * 読み上げやチャイムが使えない環境のテストは test.use で audioScript ごと置き換える。
 */
const test = base.extend<{ audioScript: string }>({
  audioScript: [FAKE_AUDIO + FAKE_SPEECH, { option: true }],
  page: async ({ page, audioScript }, provide) => {
    await page.addInitScript(audioScript);
    await provide(page);
  },
});

const BASE = "http://dashboard.test";
const TIMER_KEY = "hellIctDashboardTimer";

const openDashboard = async (page: Page): Promise<void> => {
  await page.route(`${BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/dashboard.html") {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: dashboardHtml });
      return;
    }
    if (url.pathname === "/api/progress/summary") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ teams: [], events: [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto(`${BASE}/dashboard.html`);
};

const display = (page: Page) => page.locator("#timer-display");
const toggle = (page: Page) => page.locator("#timer-toggle");
const minutes = (page: Page) => page.getByLabel("制限時間（分）");

const START = new Date("2026-09-26T10:00:00+09:00").getTime();

/**
 * 偽の時計を ms だけ進める。page.clock.runFor を5秒ずつに分けて呼ぶだけで、発火するタイマーと順序は
 * 一度に進めた場合と変わらない（ダッシュボードの1秒タイマーは毎秒すべて発火する）。
 *
 * 分ける理由: Playwrightの runFor は、偽のタイマーを1つ発火するたびに本物の setTimeout(0) を1回待つ。
 * 1回の runFor の中ではこれが入れ子になり、5段を超えると Chromium が4msに切り上げる。macOSでは
 * その待ちが実測15〜30msまで延び、80分ぶん（約5,000回の発火）を一度に進めると30秒の上限を超えた。
 * 呼び出しを分ければ入れ子が毎回リセットされ、10分ぶんが約9秒から0.1秒未満になる。
 */
const RUN_STEP_MS = 5000;
const runFor = async (page: Page, ms: number): Promise<void> => {
  for (let done = 0; done < ms; done += RUN_STEP_MS) {
    await page.clock.runFor(Math.min(RUN_STEP_MS, ms - done));
  }
};

test.beforeEach(async ({ page }) => {
  // installだけだと偽の時計も実時間で進み、テストの待ち時間の分だけ残りが減ってしまう。
  // pauseAtで止め、時間はrunForで進めた分だけ進むようにする（再読み込み後も止まったまま）。
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
});

test("初期値は80分で止まっており、スタートで減り、一時停止で止まる", async ({ page }) => {
  await openDashboard(page);
  await expect(display(page)).toHaveText("80:00");
  await expect(minutes(page)).toHaveValue("80");

  await runFor(page, 5000);
  await expect(display(page)).toHaveText("80:00");

  await toggle(page).click();
  await expect(toggle(page)).toHaveText("一時停止");
  await expect(minutes(page)).toBeDisabled();
  await runFor(page, 61_000);
  await expect(display(page)).toHaveText("78:59");

  await toggle(page).click();
  await expect(toggle(page)).toHaveText("スタート");
  await runFor(page, 30_000);
  await expect(display(page)).toHaveText("78:59");
});

test("分を変えると止まっているタイマーがその分数になり、初期値に戻すでもその分数へ戻る", async ({
  page,
}) => {
  await openDashboard(page);
  await minutes(page).fill("45");
  await minutes(page).blur();
  await expect(display(page)).toHaveText("45:00");

  await toggle(page).click();
  await runFor(page, 10_000);
  await expect(display(page)).toHaveText("44:50");

  await page.getByRole("button", { name: "初期値に戻す" }).click();
  await expect(display(page)).toHaveText("45:00");
  await expect(toggle(page)).toHaveText("スタート");
  await expect(minutes(page)).toBeEnabled();
});

test("不正な分数は受け付けず、元の分数へ戻す", async ({ page }) => {
  await openDashboard(page);
  for (const value of ["0", "1000", "1.5"]) {
    await minutes(page).fill(value);
    await minutes(page).blur();
    await expect(minutes(page)).toHaveValue("80");
    await expect(display(page)).toHaveText("80:00");
  }
});

test("残り10分で警告表示になり、0で時間切れになってスタートを押せない", async ({ page }) => {
  await openDashboard(page);
  await minutes(page).fill("11");
  await minutes(page).blur();
  await toggle(page).click();

  await runFor(page, 59_000);
  await expect(page.locator("#timer")).not.toHaveClass(/warning/);
  await runFor(page, 2000);
  await expect(page.locator("#timer")).toHaveClass(/warning/);

  await runFor(page, 10 * 60 * 1000);
  await expect(display(page)).toHaveText("00:00");
  await expect(page.locator("#timer")).toHaveClass(/finished/);
  await expect(page.getByText("時間切れ")).toBeVisible();
  await expect(toggle(page)).toBeDisabled();
});

test("再読み込みしても、走っているタイマーは続きから動く", async ({ page }) => {
  await openDashboard(page);
  await toggle(page).click();
  await runFor(page, 120_000);
  await expect(display(page)).toHaveText("78:00");

  await page.reload();
  await expect(toggle(page)).toHaveText("一時停止");
  await runFor(page, 60_000);
  await expect(display(page)).toHaveText("77:00");
});

test("localStorageの値が壊れていれば80分の初期値で始まる", async ({ page }) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"minutes":"x","remainingMs":-1,"endsAt":null}'),
    TIMER_KEY,
  );
  await openDashboard(page);
  await expect(display(page)).toHaveText("80:00");
  await expect(toggle(page)).toHaveText("スタート");
});

const MINUTE = 60_000;

const chimes = (page: Page) => page.evaluate("window.__chimeStarts");
const spoken = (page: Page) => page.evaluate("window.__spoken");

test.describe("残り10分刻みの読み上げ", () => {
  test("80分では残り70:00で経過とのこりを、00:00でゲーム終了を1回ずつ読み、チャイムは鳴らさない", async ({
    page,
  }) => {
    await openDashboard(page);
    await toggle(page).click();

    await runFor(page, 9 * MINUTE + 59_000);
    await expect(display(page)).toHaveText("70:01");
    expect(await spoken(page)).toEqual([]);

    await runFor(page, 1000);
    await expect(display(page)).toHaveText("70:00");
    expect(await spoken(page)).toEqual(["10分経過、のこり70分です"]);
    expect(await page.evaluate("window.__utterances[0]")).toEqual({
      lang: "ja-JP",
      voice: "Kyoko",
    });

    await runFor(page, 70 * MINUTE);
    await expect(display(page)).toHaveText("00:00");
    await runFor(page, 5000);
    expect(await spoken(page)).toEqual([
      "10分経過、のこり70分です",
      "20分経過、のこり60分です",
      "30分経過、のこり50分です",
      "40分経過、のこり40分です",
      "50分経過、のこり30分です",
      "60分経過、のこり20分です",
      "70分経過、のこり10分です",
      "80分経過、ゲーム終了です",
    ]);
    expect(await chimes(page)).toBe(0);
  });

  test("11分では残り10:01では読まず、10:00で1分経過を読む", async ({ page }) => {
    await openDashboard(page);
    await minutes(page).fill("11");
    await minutes(page).blur();
    await toggle(page).click();

    await runFor(page, 59_000);
    await expect(display(page)).toHaveText("10:01");
    expect(await spoken(page)).toEqual([]);

    await runFor(page, 1000);
    await expect(display(page)).toHaveText("10:00");
    expect(await spoken(page)).toEqual(["1分経過、のこり10分です"]);
  });

  test("一時停止中は読まず、再開後に区切りをまたいだら読む", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 5 * MINUTE);
    await toggle(page).click();

    await runFor(page, 20 * MINUTE);
    await expect(display(page)).toHaveText("75:00");
    expect(await spoken(page)).toEqual([]);

    await toggle(page).click();
    await runFor(page, 5 * MINUTE);
    await expect(display(page)).toHaveText("70:00");
    expect(await spoken(page)).toEqual(["10分経過、のこり70分です"]);
  });

  test("再読み込みしても過ぎた区切りを遡って読まない", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 25 * MINUTE);
    expect(await spoken(page)).toHaveLength(2);

    await page.reload();
    await runFor(page, 2000);
    await expect(toggle(page)).toHaveText("一時停止");
    expect(await spoken(page)).toEqual([]);

    await page.locator("body").click();
    await runFor(page, 5 * MINUTE);
    await expect(display(page)).toHaveText("49:58");
    expect(await spoken(page)).toEqual(["30分経過、のこり50分です"]);
  });

  test("初期値に戻した後に再スタートしても、すぐには読まない", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 15 * MINUTE);
    expect(await spoken(page)).toHaveLength(1);

    await page.getByRole("button", { name: "初期値に戻す" }).click();
    await toggle(page).click();
    await runFor(page, 5 * MINUTE);
    await expect(display(page)).toHaveText("75:00");
    expect(await spoken(page)).toHaveLength(1);
  });

  test("最初のクリックで1回だけ空の発話を流して読み上げを解錠する", async ({ page }) => {
    await openDashboard(page);
    expect(await page.evaluate("window.__unlocks")).toBe(0);
    await page.locator("body").click();
    await toggle(page).click();
    expect(await page.evaluate("window.__unlocks")).toBe(1);
    expect(await spoken(page)).toEqual([]);
  });

  const VOICE_CASES = [
    {
      name: "Kyokoが無ければ日本語の声で読む",
      voices: '[{ name: "Alex", lang: "en-US" }, { name: "Otoya", lang: "ja_JP" }]',
      voice: "Otoya",
    },
    {
      name: "日本語の声が無ければ声を指定せずlangだけで読む",
      voices: '[{ name: "Alex", lang: "en-US" }]',
      voice: null,
    },
  ];
  for (const { name, voices, voice } of VOICE_CASES) {
    test(name, async ({ page }) => {
      await page.addInitScript(`window.__voices = ${voices};`);
      await openDashboard(page);
      await toggle(page).click();
      await runFor(page, 10 * MINUTE);
      expect(await page.evaluate("window.__utterances")).toEqual([{ lang: "ja-JP", voice }]);
    });
  }

  test("声の一覧が後から届いたら、voiceschangedでKyokoを選び直す", async ({ page }) => {
    await page.addInitScript(`window.__voices = [];`);
    await openDashboard(page);
    await page.evaluate(`
      window.__voices = [{ name: "Kyoko", lang: "ja-JP" }];
      window.__voicesChanged();
    `);
    await toggle(page).click();
    await runFor(page, 10 * MINUTE);
    expect(await page.evaluate("window.__utterances")).toEqual([{ lang: "ja-JP", voice: "Kyoko" }]);
  });

  test("読み上げる前に、残っている読み上げをcancelで止める", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 20 * MINUTE);
    expect(await page.evaluate("window.__speechLog")).toEqual([
      "cancel",
      "speak:10分経過、のこり70分です",
      "cancel",
      "speak:20分経過、のこり60分です",
    ]);
  });

  test("読み上げで例外が出たらチャイムに替え、タイマーは止まらない", async ({ page }) => {
    await openDashboard(page);
    await page.evaluate(
      `window.speechSynthesis.speak = () => { throw new Error("speech failed"); };`,
    );
    await page.locator("body").click();
    await toggle(page).click();
    await runFor(page, 10 * MINUTE);
    await expect(display(page)).toHaveText("70:00");
    expect(await chimes(page)).toBe(1);
    await runFor(page, MINUTE);
    await expect(display(page)).toHaveText("69:00");
  });
});

test.describe("読み上げが使えないときの残り10分刻みのチャイム", () => {
  test.use({ audioScript: NO_SPEECH + FAKE_AUDIO });

  test("80分で走らせると、残りが10分の倍数に達するたびに1回ずつ鳴り、区切りの直前では鳴らない", async ({
    page,
  }) => {
    await openDashboard(page);
    await toggle(page).click();

    await runFor(page, 9 * MINUTE + 59_000);
    await expect(display(page)).toHaveText("70:01");
    expect(await chimes(page)).toBe(0);

    await runFor(page, 1000);
    await expect(display(page)).toHaveText("70:00");
    expect(await chimes(page)).toBe(1);

    await runFor(page, 10 * MINUTE);
    await expect(display(page)).toHaveText("60:00");
    expect(await chimes(page)).toBe(2);
  });

  test("11分設定では、残り10:00ちょうどで1回・10:01では鳴らず、00:00で計2回鳴る", async ({
    page,
  }) => {
    await openDashboard(page);
    await minutes(page).fill("11");
    await minutes(page).blur();
    await toggle(page).click();

    await runFor(page, 59_000);
    await expect(display(page)).toHaveText("10:01");
    expect(await chimes(page)).toBe(0);

    await runFor(page, 1000);
    await expect(display(page)).toHaveText("10:00");
    expect(await chimes(page)).toBe(1);

    await runFor(page, 10 * MINUTE);
    await expect(display(page)).toHaveText("00:00");
    await runFor(page, 5000);
    expect(await chimes(page)).toBe(2);
  });

  test("45分設定では、経過5分（残り40:00）で1回鳴る", async ({ page }) => {
    await openDashboard(page);
    await minutes(page).fill("45");
    await minutes(page).blur();
    await toggle(page).click();

    await runFor(page, 4 * MINUTE + 59_000);
    await expect(display(page)).toHaveText("40:01");
    expect(await chimes(page)).toBe(0);

    await runFor(page, 1000);
    await expect(display(page)).toHaveText("40:00");
    expect(await chimes(page)).toBe(1);
  });

  test("一時停止中は鳴らず、再開後に区切りをまたいだら鳴る", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 5 * MINUTE);
    await toggle(page).click();

    await runFor(page, 20 * MINUTE);
    await expect(display(page)).toHaveText("75:00");
    expect(await chimes(page)).toBe(0);

    await toggle(page).click();
    await runFor(page, 5 * MINUTE);
    await expect(display(page)).toHaveText("70:00");
    expect(await chimes(page)).toBe(1);
  });

  test("走っている途中で再読み込みしても、過ぎた区切りを遡って鳴らさない", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 25 * MINUTE);
    expect(await chimes(page)).toBe(2);

    await page.reload();
    await runFor(page, 2000);
    await expect(toggle(page)).toHaveText("一時停止");
    expect(await chimes(page)).toBe(0);

    // 音はクリックで用意するので、ページのどこかを一度クリックしてから次の区切りをまたぐ。
    await page.locator("body").click();
    await runFor(page, 5 * MINUTE);
    await expect(display(page)).toHaveText("49:58");
    expect(await chimes(page)).toBe(1);
  });

  test("10分設定では、0到達と区切りが重なっても1回だけ鳴る", async ({ page }) => {
    await openDashboard(page);
    await minutes(page).fill("10");
    await minutes(page).blur();
    await toggle(page).click();

    await runFor(page, 10 * MINUTE);
    await expect(display(page)).toHaveText("00:00");
    await expect(page.locator("#timer")).toHaveClass(/finished/);
    await runFor(page, 5000);
    expect(await chimes(page)).toBe(1);
  });

  test("初期値に戻した後に再スタートしても、すぐには鳴らない", async ({ page }) => {
    await openDashboard(page);
    await toggle(page).click();
    await runFor(page, 15 * MINUTE);
    expect(await chimes(page)).toBe(1);

    await page.getByRole("button", { name: "初期値に戻す" }).click();
    await toggle(page).click();
    await runFor(page, 5 * MINUTE);
    await expect(display(page)).toHaveText("75:00");
    expect(await chimes(page)).toBe(1);

    await runFor(page, 5 * MINUTE);
    expect(await chimes(page)).toBe(2);
  });
});

/** 読み上げもチャイムも使えない環境。どれでもタイマーは止まらず、溜まったチャイムを後から鳴らさない。 */
const BROKEN_AUDIO = {
  AudioContextなし: `window.__chimeStarts = 0; delete window.AudioContext; delete window.webkitAudioContext;`,
  生成で例外: `window.__chimeStarts = 0; window.AudioContext = class { constructor() { throw new Error("no audio"); } };`,
  再開できない: `
    window.__chimeStarts = 0;
    window.AudioContext = class {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume() { return Promise.reject(new Error("not allowed")); }
      createOscillator() {
        return {
          type: "",
          frequency: { value: 0 },
          connect: (node) => node,
          start: () => { window.__chimeStarts += 1; },
          stop: () => {},
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: (node) => node,
        };
      }
    };
  `,
};

for (const [name, script] of Object.entries(BROKEN_AUDIO)) {
  test.describe(`音が出せない環境（${name}）`, () => {
    test.use({ audioScript: NO_SPEECH + script });
    test("タイマーは進み、チャイムは予約されない", async ({ page }) => {
      await openDashboard(page);
      await toggle(page).click();
      await runFor(page, 10 * MINUTE);
      await expect(display(page)).toHaveText("70:00");

      await toggle(page).click();
      await expect(toggle(page)).toHaveText("スタート");
      expect(await chimes(page)).toBe(0);
    });
  });
}
