"use client";

// A small ordered list of ids the person keeps in this browser, per user, like
// the rail's fold state: the pinned chats, the open chat tabs. One module
// snapshot per storage key, so every consumer agrees; private mode, server
// rendering and garbage in storage all read as an empty list.

import { useSyncExternalStore } from "react";

const EMPTY: readonly string[] = [];

export interface LocalListStore {
  readonly storageKey: (userId: string | null) => string;
  /** The stored list, from an injectable storage (tests) or the browser's. */
  readonly read: (
    getStorage: () => Pick<Storage, "getItem"> | null,
    userId: string | null,
  ) => readonly string[];
  /** Append an id (its position is kept when already present); the oldest
   *  entries fall off past `max`. */
  readonly add: (userId: string | null, id: string) => void;
  readonly remove: (userId: string | null, id: string) => void;
  /** The live list, empty on the server and until the browser snapshot lands. */
  readonly useList: (userId: string | null) => readonly string[];
}

/** Pure list rules, shared by the store and its tests. */
export function appended(current: readonly string[], id: string, max: number): readonly string[] {
  if (current.includes(id)) return current;
  const next = [...current, id];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function removed(current: readonly string[], id: string): readonly string[] {
  return current.includes(id) ? current.filter((item) => item !== id) : current;
}

const browserStorage = (): Storage | null =>
  typeof window === "undefined" ? null : window.localStorage;

export function createLocalListStore(name: string, max = Number.POSITIVE_INFINITY): LocalListStore {
  const storageKey = (userId: string | null) => `${name}:${userId ?? "anonymous"}`;
  const read: LocalListStore["read"] = (getStorage, userId) => {
    try {
      const raw = getStorage()?.getItem(storageKey(userId));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : EMPTY;
    } catch {
      return EMPTY;
    }
  };
  let snapshot: { key: string; value: readonly string[] } | null = null;
  const listeners = new Set<() => void>();
  const current = (userId: string | null): readonly string[] => {
    const key = storageKey(userId);
    if (snapshot?.key !== key) snapshot = { key, value: read(browserStorage, userId) };
    return snapshot.value;
  };
  const commit = (userId: string | null, value: readonly string[]) => {
    if (value === current(userId)) return;
    snapshot = { key: storageKey(userId), value };
    try {
      browserStorage()?.setItem(storageKey(userId), JSON.stringify(value));
    } catch {
      // Private mode or storage full: the list is best-effort.
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    storageKey,
    read,
    add: (userId, id) => commit(userId, appended(current(userId), id, max)),
    remove: (userId, id) => commit(userId, removed(current(userId), id)),
    useList: (userId) => useSyncExternalStore(subscribe, () => current(userId), () => EMPTY),
  };
}
