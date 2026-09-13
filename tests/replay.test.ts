import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_SIZE, parseFrames, type ParsedFrame } from '../src/parser';
import {
  createReplaySession,
  REPLAY_INTERVAL_MS,
  type ReplayClock,
  type ReplaySession,
  type ReplayStatus,
} from '../src/replay';

interface FrameOpts {
  magic?: [number, number];
  version?: number;
  flags?: number;
  timestamp?: number;
  tempRaw?: number;
  humidity?: number;
  seq?: number;
}

/** 按帧布局构造一个 12 字节帧，默认全部字段合法 */
function makeFrame(o: FrameOpts = {}): number[] {
  const b = new Array<number>(FRAME_SIZE).fill(0);
  const [m0, m1] = o.magic ?? [0xa5, 0x5a];
  b[0] = m0;
  b[1] = m1;
  b[2] = o.version ?? 0x01;
  b[3] = o.flags ?? 0;
  const ts = o.timestamp ?? 0;
  b[4] = ts & 0xff;
  b[5] = (ts >>> 8) & 0xff;
  b[6] = (ts >>> 16) & 0xff;
  b[7] = (ts >>> 24) & 0xff;
  const t = (o.tempRaw ?? 0) & 0xffff;
  b[8] = t & 0xff;
  b[9] = (t >>> 8) & 0xff;
  b[10] = o.humidity ?? 0;
  b[11] = o.seq ?? 0;
  return b;
}

function bytes(...frames: number[][]): Uint8Array {
  return new Uint8Array(frames.flat());
}

/** 解析出 count 个合法帧（序号默认 0..count-1 连续），供复盘会话消费 */
function makeFrames(count: number, opts: (i: number) => FrameOpts = () => ({})): ParsedFrame[] {
  const r = parseFrames(
    bytes(...Array.from({ length: count }, (_, i) => makeFrame({ seq: i, ...opts(i) }))),
  );
  if (r.error !== null) throw new Error('测试数据应为完全合法的帧');
  return r.frames;
}

describe('复盘会话创建', () => {
  it('空批次无法创建会话', () => {
    expect(() => createReplaySession([])).toThrow(/空批次/);
  });

  it('初始状态为待播放并定位首帧', () => {
    const session = createReplaySession(makeFrames(3));
    expect(session.status).toBe('idle');
    expect(session.currentIndex).toBe(0);
    expect(session.frameCount).toBe(3);
    expect(session.destroyed).toBe(false);
    expect(session.current()).toBe(session.timeline[0]);
  });

  it('时间线按文件顺序生成且为只读快照', () => {
    const frames = (() => {
      const r = parseFrames(
        bytes(
          makeFrame({ timestamp: 1000, tempRaw: 235, humidity: 45, seq: 7, flags: 0b001 }),
          makeFrame({ timestamp: 1060, tempRaw: -155, humidity: 60, seq: 8, flags: 0b110 }),
        ),
      );
      if (r.error !== null) throw new Error('测试数据应为完全合法的帧');
      return r.frames;
    })();

    const session = createReplaySession(frames);
    expect(session.timeline).toHaveLength(2);
    expect(session.timeline[0]).toEqual({
      index: 0,
      offset: 0,
      timestamp: 1000,
      temperatureRaw: 235,
      temperatureC: '23.5',
      humidity: 45,
      sequence: 7,
      flags: { highTemp: true, lowTemp: false, lowBattery: false },
    });
    expect(session.timeline[1]).toEqual({
      index: 1,
      offset: FRAME_SIZE,
      timestamp: 1060,
      temperatureRaw: -155,
      temperatureC: '-15.5',
      humidity: 60,
      sequence: 8,
      flags: { highTemp: false, lowTemp: true, lowBattery: true },
    });
    // 时间线、快照与标志全部冻结，复盘期间不可被改写
    expect(Object.isFrozen(session.timeline)).toBe(true);
    expect(Object.isFrozen(session.timeline[0])).toBe(true);
    expect(Object.isFrozen(session.timeline[0].flags)).toBe(true);
  });

  it('快照与源解析结果解耦：事后改动源帧不影响时间线', () => {
    const frames = makeFrames(2, (i) => ({ humidity: 40 + i, flags: 0b001 }));
    const session = createReplaySession(frames);

    frames[0].humidity = 99;
    frames[0].flags.highTemp = false;
    frames[0].temperatureC = '99.9';

    expect(session.timeline[0].humidity).toBe(40);
    expect(session.timeline[0].flags.highTemp).toBe(true);
    expect(session.timeline[0].temperatureC).toBe('0.0');
  });
});

describe('推进、暂停与结束（虚拟时间）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('播放后按节拍逐帧推进当前帧', () => {
    const session = createReplaySession(makeFrames(3));
    session.play();
    expect(session.status).toBe('playing');
    expect(session.currentIndex).toBe(0);

    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);
    expect(session.status).toBe('playing');

    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(2);
    expect(session.status).toBe('playing');
  });

  it('默认时钟使用全局 setInterval，推进节拍为 1000ms', () => {
    expect(REPLAY_INTERVAL_MS).toBe(1000);
    const session = createReplaySession(makeFrames(2));
    session.play();
    // 不足一拍不推进
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS - 1);
    expect(session.currentIndex).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.currentIndex).toBe(1);
  });

  it('抵达末帧后再推进一拍进入已结束，时钟停止且停在末帧', () => {
    const session = createReplaySession(makeFrames(2));
    session.play();
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);
    expect(session.status).toBe('playing');

    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');
    expect(session.currentIndex).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // 结束后时间继续流逝也不再变化
    vi.advanceTimersByTime(10 * REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');
    expect(session.currentIndex).toBe(1);
  });

  it('单帧批次：播放后一拍即结束', () => {
    const session = createReplaySession(makeFrames(1));
    session.play();
    expect(session.status).toBe('playing');
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');
    expect(session.currentIndex).toBe(0);
  });

  it('暂停后时间推进不再改变当前帧，继续播放从暂停处前进', () => {
    const session = createReplaySession(makeFrames(4));
    session.play();
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);

    session.pause();
    expect(session.status).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);
    expect(session.status).toBe('paused');

    session.play();
    expect(session.status).toBe('playing');
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(2);
  });

  it('非播放中调用暂停为空操作', () => {
    const session = createReplaySession(makeFrames(2));
    session.pause();
    expect(session.status).toBe('idle');
    session.play();
    vi.advanceTimersByTime(2 * REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');
    session.pause();
    expect(session.status).toBe('ended');
  });

  it('已结束时再次播放从首帧重新开始', () => {
    const session = createReplaySession(makeFrames(3));
    session.play();
    vi.advanceTimersByTime(3 * REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');
    expect(session.currentIndex).toBe(2);

    session.play();
    expect(session.status).toBe('playing');
    expect(session.currentIndex).toBe(0);
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);
  });

  it('推进、暂停与结束的结果在虚拟时间下可重复', () => {
    const runScenario = (): string[] => {
      const session = createReplaySession(makeFrames(4));
      const trace: string[] = [];
      const record = (): void => {
        trace.push(`${session.status}@${session.currentIndex}`);
      };
      record();
      session.play();
      record();
      vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
      record();
      session.pause();
      record();
      vi.advanceTimersByTime(5 * REPLAY_INTERVAL_MS);
      record();
      session.play();
      vi.advanceTimersByTime(2 * REPLAY_INTERVAL_MS);
      record();
      vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
      record();
      session.play();
      record();
      vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
      record();
      session.destroy();
      return trace;
    };

    const first = runScenario();
    const second = runScenario();
    expect(second).toEqual(first);
    expect(first).toEqual([
      'idle@0',
      'playing@0',
      'playing@1',
      'paused@1',
      'paused@1',
      'playing@3',
      'ended@3',
      'playing@0',
      'playing@1',
    ]);
  });
});

describe('拖动定位', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('待播放时定位任意帧，状态保持待播放', () => {
    const session = createReplaySession(makeFrames(5));
    session.seek(3);
    expect(session.currentIndex).toBe(3);
    expect(session.status).toBe('idle');
    expect(session.current()).toBe(session.timeline[3]);
  });

  it('越界定位被钳制到首末帧，非整数取整', () => {
    const session = createReplaySession(makeFrames(3));
    session.seek(-10);
    expect(session.currentIndex).toBe(0);
    session.seek(999);
    expect(session.currentIndex).toBe(2);
    session.seek(1.7);
    expect(session.currentIndex).toBe(1);
  });

  it('播放中定位后继续从新位置推进', () => {
    const session = createReplaySession(makeFrames(5));
    session.play();
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);

    session.seek(3);
    expect(session.currentIndex).toBe(3);
    expect(session.status).toBe('playing');
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(4);
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');
  });

  it('已结束时定位脱离结束态转为已暂停，再次播放从定位处继续', () => {
    const session = createReplaySession(makeFrames(4));
    session.play();
    vi.advanceTimersByTime(4 * REPLAY_INTERVAL_MS);
    expect(session.status).toBe('ended');

    session.seek(1);
    expect(session.status).toBe('paused');
    expect(session.currentIndex).toBe(1);

    session.play();
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(2);
  });
});

describe('销毁', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('销毁停止时钟，之后播放 / 暂停 / 定位均为空操作', () => {
    const session = createReplaySession(makeFrames(3));
    session.play();
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);

    session.destroy();
    expect(session.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    session.play();
    session.pause();
    session.seek(2);
    expect(session.status).toBe('playing'); // 销毁前状态不变
    expect(session.currentIndex).toBe(1);
    vi.advanceTimersByTime(5 * REPLAY_INTERVAL_MS);
    expect(session.currentIndex).toBe(1);

    // 重复销毁安全
    session.destroy();
    expect(session.destroyed).toBe(true);
  });
});

describe('可注入时钟', () => {
  it('会话完全通过注入的时钟推进与停止，不依赖全局定时器', () => {
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const clock: ReplayClock = {
      setInterval: (handler) => {
        const id = nextId++;
        timers.set(id, handler);
        return id;
      },
      clearInterval: (handle) => {
        timers.delete(handle as number);
      },
    };
    const fireAll = (): void => {
      for (const handler of [...timers.values()]) handler();
    };

    const session = createReplaySession(makeFrames(2), { clock, intervalMs: 60_000 });
    session.play();
    expect(timers.size).toBe(1);

    fireAll();
    expect(session.currentIndex).toBe(1);
    expect(session.status).toBe('playing');

    fireAll();
    expect(session.status).toBe('ended');
    expect(timers.size).toBe(0);
  });
});

describe('状态变化通知', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('每次状态或当前帧变化时回调并回传会话自身', () => {
    const events: Array<{ status: ReplayStatus; index: number; self: ReplaySession }> = [];
    const session = createReplaySession(makeFrames(2), {
      onChange: (s) => events.push({ status: s.status, index: s.currentIndex, self: s }),
    });

    session.play();
    vi.advanceTimersByTime(REPLAY_INTERVAL_MS);
    session.pause();
    session.seek(0);
    session.play();
    vi.advanceTimersByTime(2 * REPLAY_INTERVAL_MS);

    expect(events.map((e) => `${e.status}@${e.index}`)).toEqual([
      'playing@0',
      'playing@1',
      'paused@1',
      'paused@0',
      'playing@0',
      'playing@1',
      'ended@1',
    ]);
    for (const e of events) expect(e.self).toBe(session);
  });
});
