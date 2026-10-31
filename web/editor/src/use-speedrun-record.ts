import { useEffect, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import {
  defaultSpeedSelection,
  type WclSpeedCategory,
  type WclSpeedSelection,
  type SpeedrunWorldRecord,
} from "./speedrun-world-record";

export function useSpeedrunRecord(
  state: Snapshot,
  controller: EditorController,
) {
  const version = state.replay?.gameVersion,
    map = state.replay?.map;
  const key = `${version}:${map}:${state.wclConnected}:${state.replay?.fight.difficulty}:${state.replay?.fight.size}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    category: WclSpeedCategory;
    selection: WclSpeedSelection;
  } | null>(null);
  const [result, setResult] = useState<{
    key: string;
    record: SpeedrunWorldRecord | null;
    error: string | null;
    loading: boolean;
  }>({ key: "", record: null, error: null, loading: false });
  const [refresh, setRefresh] = useState(0);
  const [catalogueRefresh, setCatalogueRefresh] = useState(0);
  const current = loaded?.key === key ? loaded : null;
  useEffect(() => {
    setLoaded(null);
    if (!state.wclConnected || !version || map === undefined) return;
    const abort = new AbortController();
    setResult({ key, record: null, error: null, loading: true });
    void controller
      .speedCategory(version, map, abort.signal)
      .then((category) => {
        if (!abort.signal.aborted)
          setLoaded({
            key,
            category,
            selection: (() => {
              const chosen = defaultSpeedSelection(category);
              const difficulty = category.difficulties.find(
                (d) => d.id === state.replay?.fight.difficulty,
              );
              if (difficulty)
                return {
                  ...chosen,
                  difficulty: difficulty.id,
                  size: difficulty.sizes.includes(
                    state.replay?.fight.size ?? -1,
                  )
                    ? state.replay!.fight.size!
                    : (difficulty.sizes[0] ?? null),
                };
              return chosen;
            })(),
          });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setResult({
            key,
            record: null,
            error: String(error.message ?? error),
            loading: false,
          });
      });
    return () => abort.abort();
  }, [controller, key, catalogueRefresh]);
  const selectionKey = current ? JSON.stringify(current.selection) : "";
  useEffect(() => {
    if (!current || !version || map === undefined) return;
    const abort = new AbortController();
    setResult({
      key: key + selectionKey,
      record: null,
      error: null,
      loading: true,
    });
    void controller
      .speedWorldRecord(
        version,
        map,
        current.category,
        current.selection,
        abort.signal,
      )
      .then((record) => {
        if (!abort.signal.aborted)
          setResult({
            key: key + selectionKey,
            record,
            error: null,
            loading: false,
          });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setResult({
            key: key + selectionKey,
            record: null,
            error: String(error.message ?? error),
            loading: false,
          });
      });
    return () => abort.abort();
  }, [controller, key, selectionKey, current?.category, refresh]);
  const visible =
    result.key === key + selectionKey || (!current && result.key === key)
      ? result
      : { record: null, error: null, loading: state.wclConnected };
  return {
    ...visible,
    category: current?.category ?? null,
    selection: current?.selection ?? null,
    connected: state.wclConnected,
    select: (selection: WclSpeedSelection) => {
      if (current) setLoaded({ ...current, selection });
    },
    retry: () =>
      current
        ? setRefresh((value) => value + 1)
        : setCatalogueRefresh((value) => value + 1),
  };
}
