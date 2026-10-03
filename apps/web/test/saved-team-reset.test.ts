import { describe, expect, it } from "vitest";

import { TEAM_CODE_STORAGE_KEY } from "../src/composables/use-game-session.js";
import { FONT_STEP_KEY, SFX_MUTED_KEY } from "../src/composables/use-preferences.js";
import { teamNameKey } from "../src/composables/use-team-name.js";
import type { AddressBar } from "../src/ports.js";
import { forgetSavedTeamIfAsked, urlWithoutReset } from "../src/saved-team-reset.js";
import { FakeKeyValueStorage } from "./fakes.js";

class FakeAddressBar implements AddressBar {
  readonly replaced: string[] = [];

  constructor(private url: string) {}

  current(): string {
    return this.url;
  }

  replace(url: string): void {
    this.replaced.push(url);
    this.url = url;
  }
}

describe("urlWithoutReset", () => {
  it.each([
    ["/?reset", "/"],
    ["/?reset=", "/"],
    ["/?reset=1", "/"],
    ["/?reset=0", "/"],
    ["/?reset&reset=1", "/"],
    ["/?reset#gm", "/#gm"],
    ["/?a=1&reset&b=2", "/?a=1&b=2"],
    ["/?reset=1&a=x#top", "/?a=x#top"],
    ["/sub/path?reset", "/sub/path"],
  ])("%s は reset だけを外して %s", (current, expected) => {
    expect(urlWithoutReset(current)).toBe(expected);
  });

  it.each(["/", "/#reset", "/?a=1", "/?resets=1", "/?Reset", "/?x=reset", "/reset"])(
    "%s は reset を求めていない（null）",
    (current) => {
      expect(urlWithoutReset(current)).toBeNull();
    },
  );
});

describe("forgetSavedTeamIfAsked", () => {
  const savedStorage = (): FakeKeyValueStorage => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(TEAM_CODE_STORAGE_KEY, "420001");
    storage.values.set(teamNameKey("420001"), "A班");
    storage.values.set(SFX_MUTED_KEY, "1");
    storage.values.set(FONT_STEP_KEY, "2");
    return storage;
  };

  it("reset 付きなら保存済みのチームコードだけを消し、URL から reset を外す", () => {
    const storage = savedStorage();
    const address = new FakeAddressBar("/?reset=1&a=x#top");

    expect(forgetSavedTeamIfAsked({ address, storage })).toBe(true);

    expect(storage.values.has(TEAM_CODE_STORAGE_KEY)).toBe(false);
    // チーム名・ミュート・文字サイズは残す
    expect(storage.values.get(teamNameKey("420001"))).toBe("A班");
    expect(storage.values.get(SFX_MUTED_KEY)).toBe("1");
    expect(storage.values.get(FONT_STEP_KEY)).toBe("2");
    expect(address.replaced).toEqual(["/?a=x#top"]);
  });

  it("再読み込み（URL に reset が残っていない）では、入り直したチームを消さない", () => {
    const storage = savedStorage();
    const address = new FakeAddressBar("/?reset");
    forgetSavedTeamIfAsked({ address, storage });
    storage.values.set(TEAM_CODE_STORAGE_KEY, "420002");

    expect(forgetSavedTeamIfAsked({ address, storage })).toBe(false);

    expect(storage.values.get(TEAM_CODE_STORAGE_KEY)).toBe("420002");
    expect(address.replaced).toEqual(["/"]);
  });

  it("reset が無ければ Storage にも URL にも触れない", () => {
    const storage = savedStorage();
    const address = new FakeAddressBar("/?a=1#gm");

    expect(forgetSavedTeamIfAsked({ address, storage })).toBe(false);

    expect(storage.values.get(TEAM_CODE_STORAGE_KEY)).toBe("420001");
    expect(address.replaced).toEqual([]);
  });

  it("Storage が例外を投げても止まらず、URL から reset を外す", () => {
    const storage = savedStorage();
    storage.failing = true;
    const address = new FakeAddressBar("/?reset");

    expect(forgetSavedTeamIfAsked({ address, storage })).toBe(true);

    expect(address.replaced).toEqual(["/"]);
  });

  it("保存が無くても reset を外す", () => {
    const storage = new FakeKeyValueStorage();
    const address = new FakeAddressBar("/?reset");

    expect(forgetSavedTeamIfAsked({ address, storage })).toBe(true);

    expect(storage.values.size).toBe(0);
    expect(address.replaced).toEqual(["/"]);
  });
});
