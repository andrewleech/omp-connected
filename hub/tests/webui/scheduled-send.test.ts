import { describe, expect, test } from "bun:test";
import {
  MAX_SCHEDULE_DELAY_MS,
  delayFromDuration,
  delayUntilClock,
  formatCountdown,
  formatFireTime,
} from "@/webui/lib/scheduled-send";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("delayUntilClock", () => {
  const now = new Date(2026, 8, 30, 14, 20, 30);

  test("a later time today is today", () => {
    expect(delayUntilClock("16:00", now)).toBe(HOUR + 39 * MINUTE + 30_000);
  });

  test("an earlier time, or this very minute, is tomorrow", () => {
    expect(delayUntilClock("09:05", now)).toBe(
      new Date(2026, 9, 1, 9, 5).getTime() - now.getTime(),
    );
    expect(delayUntilClock("14:20", now)).toBe(
      new Date(2026, 9, 1, 14, 20).getTime() - now.getTime(),
    );
  });

  test("anything but a valid HH:MM is null", () => {
    for (const value of ["", "7:05", "24:00", "12:60", "12:5x"])
      expect(delayUntilClock(value, now)).toBeNull();
  });
});

describe("delayFromDuration", () => {
  test("whole hours and minutes from one minute up to the session's limit", () => {
    expect(delayFromDuration(0, 1)).toBe(MINUTE);
    expect(delayFromDuration(0, 90)).toBe(90 * MINUTE);
    expect(delayFromDuration(2, 30)).toBe(2 * HOUR + 30 * MINUTE);
    expect(delayFromDuration(168, 0)).toBe(MAX_SCHEDULE_DELAY_MS);
  });

  test("zero, fractions, negatives and past the limit are null", () => {
    expect(delayFromDuration(0, 0)).toBeNull();
    expect(delayFromDuration(0.5, 0)).toBeNull();
    expect(delayFromDuration(-1, 30)).toBeNull();
    expect(delayFromDuration(0, -1)).toBeNull();
    expect(delayFromDuration(168, 1)).toBeNull();
  });
});

describe("formatCountdown", () => {
  test("rounds the time left up so a pending prompt never reads as 0", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(1)).toBe("1s");
    expect(formatCountdown(59_001)).toBe("1m");
    expect(formatCountdown(12 * MINUTE)).toBe("12m");
    expect(formatCountdown(2 * HOUR + 5 * MINUTE)).toBe("2h 05m");
    expect(formatCountdown(76 * HOUR)).toBe("3d 4h");
  });
});

describe("formatFireTime", () => {
  const now = new Date(2026, 8, 30, 22, 0);

  test("names the day once the time is not today", () => {
    const today = formatFireTime(new Date(2026, 8, 30, 23, 30).getTime(), now);
    const tomorrow = formatFireTime(new Date(2026, 9, 1, 7, 0).getTime(), now);
    const later = formatFireTime(new Date(2026, 9, 3, 9, 15).getTime(), now);
    const clock = (date: Date) =>
      date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(today).toBe(clock(new Date(2026, 8, 30, 23, 30)));
    expect(tomorrow).toBe(`tomorrow ${clock(new Date(2026, 9, 1, 7, 0))}`);
    expect(later.split(" ")[0]).toBe(
      new Date(2026, 9, 3).toLocaleDateString([], { weekday: "short" }),
    );
  });
});
