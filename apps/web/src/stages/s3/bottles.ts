import { stage3Penalty } from "@hell-ict/content";

/*
 * The Stage 3 penalty's shelf of sanitiser bottles (mock startPenalty / fillBottle). Pure: the
 * composable keeps the shelf and runs the fill timers. The shelf always starts full of work (a
 * reload starts it over, user decision 12): what is filled is not kept anywhere.
 */

export type BottleState = "todo" | "filling" | "done";

export interface Bottle {
  readonly ward: string;
  readonly state: BottleState;
}

type Wave = (typeof stage3Penalty.waves)[number];

export interface BottleShelf {
  readonly bottles: readonly Bottle[];
  /** The waves that have not landed yet, each landing once. */
  readonly waves: readonly Wave[];
}

export const startShelf = (): BottleShelf => ({
  bottles: Array.from({ length: stage3Penalty.firstCount }, () => ({
    ward: stage3Penalty.firstWard,
    state: "todo" as const,
  })),
  waves: stage3Penalty.waves,
});

const withState = (shelf: BottleShelf, index: number, state: BottleState): BottleShelf => ({
  ...shelf,
  bottles: shelf.bottles.map((bottle, i) => (i === index ? { ...bottle, state } : bottle)),
});

/** Pressing a bottle: only one still to do starts filling (`null`: nothing to do, no sound). */
export const startFilling = (shelf: BottleShelf, index: number): BottleShelf | null =>
  shelf.bottles[index]?.state === "todo" ? withState(shelf, index, "filling") : null;

const doneIn = (shelf: BottleShelf, ward: string): number =>
  shelf.bottles.filter((bottle) => bottle.ward === ward && bottle.state === "done").length;

/**
 * A bottle is full. When that brings a ward to its wave's count, the wave's bottles are added at
 * the end of the shelf and `landed` names their ward.
 */
export const finishFilling = (
  shelf: BottleShelf,
  index: number,
): { readonly shelf: BottleShelf; readonly landed: string | null } => {
  if (shelf.bottles[index]?.state !== "filling") return { shelf, landed: null };
  const filled = withState(shelf, index, "done");
  const wave = filled.waves.find((w) => doneIn(filled, w.afterWard) >= w.afterDone);
  if (wave === undefined) return { shelf: filled, landed: null };
  const added = Array.from({ length: wave.count }, () => ({
    ward: wave.ward,
    state: "todo" as const,
  }));
  return {
    shelf: {
      bottles: [...filled.bottles, ...added],
      waves: filled.waves.filter((w) => w !== wave),
    },
    landed: wave.ward,
  };
};

export const allFilled = (shelf: BottleShelf): boolean =>
  shelf.bottles.every((bottle) => bottle.state === "done");

/** The shelf by ward, in the order the wards came (5A, 5B, 5C): each bottle with its index. */
export const shelfWards = (
  shelf: BottleShelf,
): readonly {
  readonly ward: string;
  readonly items: readonly (Bottle & { index: number })[];
}[] => {
  const wards: { ward: string; items: (Bottle & { index: number })[] }[] = [];
  shelf.bottles.forEach((bottle, index) => {
    let group = wards.find((w) => w.ward === bottle.ward);
    if (group === undefined) {
      group = { ward: bottle.ward, items: [] };
      wards.push(group);
    }
    group.items.push({ ...bottle, index });
  });
  return wards;
};

/** 「済 n / 全 m 本」: the total grows as waves land, so the count shows it too. */
export const shelfCount = (shelf: BottleShelf): string =>
  `済 ${String(shelf.bottles.filter((b) => b.state === "done").length)} / 全 ${String(shelf.bottles.length)} 本`;
