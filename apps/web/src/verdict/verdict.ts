/**
 * What the verdict box under a submission says (mock `verdictChecking` and the `.lead` / `.done`
 * rows each stage adds under it). The stage decides the words and plays its own sound.
 * - checking: only 「提出を確認しています…」 with its spinner.
 * - rejected: the reasons, one row each. Sent back, not failed: no penalty, no limit.
 * - cleared: one line of success.
 */
export type Verdict =
  | { readonly kind: "checking" }
  | { readonly kind: "rejected"; readonly lines: readonly string[] }
  | { readonly kind: "cleared"; readonly text: string };
