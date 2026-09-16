export interface Clock {
  now(): Date;
}

export function systemClock(): Clock {
  return { now: () => new Date() };
}

export interface ScheduledTask {
  cancel(): void;
}

export interface TimerScheduler {
  schedule(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
}

export function systemTimerScheduler(): TimerScheduler {
  return {
    schedule(delayMs, callback) {
      const handle = setTimeout(() => {
        void callback();
      }, delayMs);
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}

interface ManualTask {
  readonly runAt: number;
  readonly callback: () => void | Promise<void>;
  cancelled: boolean;
}

/** Deterministic test scheduler: advance virtual time and flush due callbacks. */
export function createManualTimerScheduler(startMs = 0): TimerScheduler & {
  advance(ms: number): Promise<void>;
  pendingCount(): number;
  nowMs(): number;
} {
  let virtualNow = startMs;
  let tasks: ManualTask[] = [];

  const runDue = async (): Promise<void> => {
    for (;;) {
      const due = tasks
        .filter((task) => !task.cancelled && task.runAt <= virtualNow)
        .toSorted((a, b) => a.runAt - b.runAt);
      if (due.length === 0) return;
      tasks = tasks.filter((task) => !due.includes(task));
      for (const task of due) {
        if (!task.cancelled) await task.callback();
      }
    }
  };

  return {
    schedule(delayMs, callback) {
      const task: ManualTask = { runAt: virtualNow + delayMs, callback, cancelled: false };
      tasks.push(task);
      return {
        cancel() {
          task.cancelled = true;
        },
      };
    },
    async advance(ms) {
      virtualNow += ms;
      await runDue();
    },
    pendingCount() {
      return tasks.filter((task) => !task.cancelled).length;
    },
    nowMs() {
      return virtualNow;
    },
  };
}
