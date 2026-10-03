import { computed, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { z } from "zod";

import type { KeyValueStorage } from "../ports.js";
import { sessionRecord, sessionRecordKey, type SessionRecord } from "../session-record.js";

/*
 * Which mails the team has opened, per team, kept in sessionStorage (`hellVueRead:<code>`) so a
 * reload keeps them read. Mail ids are unique across stages, so one list serves every stage.
 */

const readIdsSchema = z.array(z.string()).readonly();

export interface MailRead {
  readonly readIds: ComputedRef<ReadonlySet<string>>;
  markRead(id: string): void;
}

export const useMailRead = (
  storage: KeyValueStorage,
  teamCode: Readonly<Ref<string | null>>,
): MailRead => {
  const readIds = shallowRef<ReadonlySet<string>>(new Set());
  let record: SessionRecord<readonly string[]> | null = null;

  watch(
    teamCode,
    (code) => {
      record =
        code === null
          ? null
          : sessionRecord(storage, sessionRecordKey("Read", code), readIdsSchema);
      readIds.value = new Set(record?.read() ?? []);
    },
    { immediate: true },
  );

  return {
    readIds: computed(() => readIds.value),
    markRead(id) {
      if (readIds.value.has(id)) return;
      readIds.value = new Set([...readIds.value, id]);
      record?.write([...readIds.value]);
    },
  };
};
