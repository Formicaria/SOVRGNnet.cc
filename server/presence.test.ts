import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as presence from "./presence";

describe("presence", () => {
  beforeEach(() => {
    presence.__resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("typing", () => {
    it("reports someone who just started typing", () => {
      presence.noteTyping(1, 42);
      expect(presence.getTypingUserIds(1, 99)).toEqual([42]);
    });

    it("never reports the asker back to themselves", () => {
      presence.noteTyping(1, 42);
      expect(presence.getTypingUserIds(1, 42)).toEqual([]);
    });

    it("keeps channels separate", () => {
      presence.noteTyping(1, 42);
      expect(presence.getTypingUserIds(2, 99)).toEqual([]);
    });

    it("forgets a typist after the entry expires", () => {
      presence.noteTyping(1, 42);
      vi.advanceTimersByTime(6001);
      expect(presence.getTypingUserIds(1, 99)).toEqual([]);
    });

    it("stays alive while someone keeps typing", () => {
      presence.noteTyping(1, 42);
      vi.advanceTimersByTime(4000);
      presence.noteTyping(1, 42);
      vi.advanceTimersByTime(4000);
      expect(presence.getTypingUserIds(1, 99)).toEqual([42]);
    });

    it("clears immediately when a message is sent", () => {
      presence.noteTyping(1, 42);
      presence.clearTyping(1, 42);
      expect(presence.getTypingUserIds(1, 99)).toEqual([]);
    });

    it("reports several typists at once", () => {
      presence.noteTyping(1, 42);
      presence.noteTyping(1, 43);
      expect(presence.getTypingUserIds(1, 99).sort()).toEqual([42, 43]);
    });
  });

  describe("online status", () => {
    it("counts someone as online right after activity", () => {
      presence.noteActivity(7);
      expect(presence.isOnline(7)).toBe(true);
    });

    it("counts an unseen user as offline", () => {
      expect(presence.isOnline(7)).toBe(false);
    });

    it("drops to offline after a minute of silence", () => {
      presence.noteActivity(7);
      vi.advanceTimersByTime(60_001);
      expect(presence.isOnline(7)).toBe(false);
    });

    it("treats typing as a sign of life", () => {
      presence.noteTyping(1, 7);
      expect(presence.isOnline(7)).toBe(true);
    });

    it("filters a list down to who's around", () => {
      presence.noteActivity(1);
      presence.noteActivity(3);
      expect(presence.onlineUserIds([1, 2, 3])).toEqual(new Set([1, 3]));
    });
  });

  describe("sweep", () => {
    it("releases memory for channels nobody is typing in", () => {
      presence.noteTyping(1, 42);
      vi.advanceTimersByTime(6001);
      presence.sweep();
      expect(presence.getTypingUserIds(1, 99)).toEqual([]);
    });

    it("leaves live entries alone", () => {
      presence.noteTyping(1, 42);
      presence.sweep();
      expect(presence.getTypingUserIds(1, 99)).toEqual([42]);
    });
  });
});
