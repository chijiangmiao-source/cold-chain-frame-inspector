/**
 * 批次复盘会话：把一次完整合法批次的帧整理成只读时间线，
 * 由可注入时钟驱动逐帧推进，供夜间巡检交接时按记录顺序复盘，
 * 观察告警与温度变化如何逐帧出现，而不必在长表格中反复滚动。
 *
 * 状态机：待播放(idle) → 播放中(playing) → 已暂停(paused) / 已结束(ended)。
 * 播放中每推进一拍前进一帧；抵达末帧后再推进一拍进入已结束；
 * 已结束时再次播放从首帧重新开始；拖动定位可立即跳到任意帧。
 *
 * 会话只消费解析结果（ParsedFrame），不反向影响解析、校准、连续性、
 * 告警归并与 JSON 下载等既有契约；换入新批次时旧会话销毁并按新帧重建。
 */

import type { FrameFlags, ParsedFrame } from './parser';

/** 复盘推进节拍：每 1000ms 前进一帧 */
export const REPLAY_INTERVAL_MS = 1000;

/** 复盘状态：待播放 / 播放中 / 已暂停 / 已结束 */
export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'ended';

/**
 * 可注入时钟：与 setInterval / clearInterval 同形。
 * 页面注入全局定时器；测试注入虚拟时间或手动时钟，
 * 使推进、暂停与结束的结果可重复。
 */
export interface ReplayClock {
  setInterval(handler: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 时间线上的单帧快照：从解析结果拷贝并冻结，与原对象解耦 */
export interface ReplayFrameSnapshot {
  /** 帧序号，从 0 开始 */
  index: number;
  /** 帧首字节在文件中的绝对偏移 */
  offset: number;
  /** 小端无符号秒时间戳 */
  timestamp: number;
  /** 小端有符号温度原始值 */
  temperatureRaw: number;
  /** 摄氏度，原始值 / 10，固定一位小数 */
  temperatureC: string;
  humidity: number;
  sequence: number;
  /** 告警标志（高温 / 低温 / 低电量） */
  flags: FrameFlags;
}

export interface ReplaySessionOptions {
  /** 推进节拍（毫秒），默认 REPLAY_INTERVAL_MS */
  intervalMs?: number;
  /** 可注入时钟，默认使用全局 setInterval / clearInterval */
  clock?: ReplayClock;
  /** 状态或当前帧变化时的回调（会话自身作为参数回传） */
  onChange?: (session: ReplaySession) => void;
}

export interface ReplaySession {
  /** 当前状态：待播放 / 播放中 / 已暂停 / 已结束 */
  readonly status: ReplayStatus;
  /** 当前帧在时间线上的位置（0 起） */
  readonly currentIndex: number;
  /** 时间线帧数 */
  readonly frameCount: number;
  /** 销毁后为 true，之后所有操作均为空操作 */
  readonly destroyed: boolean;
  /** 只读时间线：按文件顺序排列的帧快照 */
  readonly timeline: readonly ReplayFrameSnapshot[];
  /** 当前帧快照 */
  current(): ReplayFrameSnapshot;
  /** 播放：待播放 / 已暂停时开始或继续；已结束时从首帧重新开始 */
  play(): void;
  /** 暂停：仅播放中有效，其余状态为空操作 */
  pause(): void;
  /** 拖动定位：立即跳到任意帧（越界钳制）；已结束时定位后转为已暂停 */
  seek(index: number): void;
  /** 销毁：停止时钟，之后所有操作均为空操作 */
  destroy(): void;
}

/** 系统时钟：调用时取全局 setInterval / clearInterval（可被测试整体替换） */
const systemClock: ReplayClock = {
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (handle) =>
    clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

class ReplaySessionImpl implements ReplaySession {
  private _status: ReplayStatus = 'idle';
  private _currentIndex = 0;
  private _destroyed = false;
  private timer: unknown = null;
  readonly timeline: readonly ReplayFrameSnapshot[];

  constructor(
    frames: readonly ParsedFrame[],
    private readonly intervalMs: number,
    private readonly clock: ReplayClock,
    private readonly onChange: ((session: ReplaySession) => void) | null,
  ) {
    if (frames.length === 0) {
      throw new Error('无法复盘空批次：至少需要一个解析成功的帧。');
    }
    // 生成只读时间线：逐帧拷贝并冻结，之后对解析结果的任何改动都不影响复盘
    this.timeline = Object.freeze(
      frames.map((f): ReplayFrameSnapshot =>
        Object.freeze({
          index: f.index,
          offset: f.offset,
          timestamp: f.timestamp,
          temperatureRaw: f.temperatureRaw,
          temperatureC: f.temperatureC,
          humidity: f.humidity,
          sequence: f.sequence,
          flags: Object.freeze({ ...f.flags }),
        }),
      ),
    );
  }

  get status(): ReplayStatus {
    return this._status;
  }

  get currentIndex(): number {
    return this._currentIndex;
  }

  get frameCount(): number {
    return this.timeline.length;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  current(): ReplayFrameSnapshot {
    return this.timeline[this._currentIndex];
  }

  play(): void {
    if (this._destroyed || this._status === 'playing') return;
    // 抵达末帧结束后再次播放：从首帧重新开始
    if (this._status === 'ended') this._currentIndex = 0;
    this._status = 'playing';
    this.startTimer();
    this.emit();
  }

  pause(): void {
    if (this._destroyed || this._status !== 'playing') return;
    this.stopTimer();
    this._status = 'paused';
    this.emit();
  }

  seek(index: number): void {
    if (this._destroyed) return;
    const clamped = Math.min(Math.max(Math.trunc(index), 0), this.frameCount - 1);
    this._currentIndex = clamped;
    // 已结束时拖回任意帧：脱离结束态，等待再次播放
    if (this._status === 'ended') this._status = 'paused';
    this.emit();
  }

  destroy(): void {
    if (this._destroyed) return;
    this.stopTimer();
    this._destroyed = true;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = this.clock.setInterval(() => this.tick(), this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this._destroyed || this._status !== 'playing') return;
    if (this._currentIndex >= this.frameCount - 1) {
      // 末帧再推进一拍：整场复盘结束，时钟停止
      this.stopTimer();
      this._status = 'ended';
    } else {
      this._currentIndex += 1;
    }
    this.emit();
  }

  private emit(): void {
    this.onChange?.(this);
  }
}

/**
 * 从解析成功的帧创建复盘会话。frames 必须非空：空批次与不合格批次
 * 无法复盘，调用方（如页面）应在帧数为 0 或文件不合格时不创建会话，
 * 并向用户说明原因，且不得利用已保留的合法帧前缀。
 */
export function createReplaySession(
  frames: readonly ParsedFrame[],
  options: ReplaySessionOptions = {},
): ReplaySession {
  return new ReplaySessionImpl(
    frames,
    options.intervalMs ?? REPLAY_INTERVAL_MS,
    options.clock ?? systemClock,
    options.onChange ?? null,
  );
}
