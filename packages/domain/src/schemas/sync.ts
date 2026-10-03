import { z } from "zod";

import { chatSnapshotSchema } from "./chat.js";
import { teamSnapshotSchema } from "./team-state.js";

/**
 * TeamRoomのWebSocket配信は、チーム状態とチャットの両方を同じソケットへ流す。
 * 受信側が種類を取り違えないよう、判別可能unionのenvelopeで包む。
 */
export const teamSyncMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("team"), snapshot: teamSnapshotSchema }).strict(),
  z.object({ kind: z.literal("chat"), snapshot: chatSnapshotSchema }).strict(),
]);

export type TeamSyncMessage = z.infer<typeof teamSyncMessageSchema>;
