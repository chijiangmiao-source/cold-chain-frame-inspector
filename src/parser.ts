/**
 * 冷库记录器二进制帧解析器。
 *
 * 帧布局（固定 12 字节，多帧顺序拼接）：
 *   偏移 0-1  魔数，必须为 A5 5A
 *   偏移 2    版本，必须为 01
 *   偏移 3    标志位：bit0 高温、bit1 低温、bit2 低电量，bit3-7 必须为 0
 *   偏移 4-7  小端无符号秒时间戳
 *   偏移 8-9  小端有符号温度原始值，摄氏度 = 原始值 / 10（固定一位小数）
 *   偏移 10   湿度，整数 0-100
 *   偏移 11   序号
 *
 * 解析策略：遇到首个非法字段立即停止，错误精确到帧号与字段首字节的
 * 文件绝对偏移；之前已解析出的合法帧保留，但整文件判定失败。
 */

export const FRAME_SIZE = 12;
export const MAGIC_0 = 0xa5;
export const MAGIC_1 = 0x5a;
export const VERSION = 0x01;
/** bit3-7 为保留位，必须全零 */
export const RESERVED_MASK = 0xf8;
export const HUMIDITY_MAX = 100;

export interface FrameFlags {
  highTemp: boolean;
  lowTemp: boolean;
  lowBattery: boolean;
}

export type FieldName =
  | 'magic'
  | 'version'
  | 'flags'
  | 'timestamp'
  | 'temperature'
  | 'humidity'
  | 'sequence';

export interface FieldEntry {
  name: FieldName;
  /** 字段首字节在文件中的绝对偏移 */
  offset: number;
  value: string | number;
}

export interface ParsedFrame {
  /** 帧序号，从 0 开始 */
  index: number;
  /** 帧首字节在文件中的绝对偏移 */
  offset: number;
  magic: string;
  version: number;
  flagsRaw: number;
  flags: FrameFlags;
  /** 小端无符号秒时间戳 */
  timestamp: number;
  /** 小端有符号温度原始值 */
  temperatureRaw: number;
  /** 摄氏度，原始值 / 10，固定一位小数 */
  temperatureC: string;
  humidity: number;
  sequence: number;
  /** 按文件顺序排列的字段及各自起始偏移 */
  fields: FieldEntry[];
}

export type ErrorField = 'length' | 'magic' | 'version' | 'flags' | 'humidity';

export interface ParseError {
  /** 出错帧的序号 */
  frameIndex: number;
  /** 出错字段首字节在文件中的绝对偏移 */
  offset: number;
  field: ErrorField;
  expected: string;
  actual: string;
  message: string;
}

export interface ParseResult {
  /** 出错前已成功解析的合法帧（出错时依然保留） */
  frames: ParsedFrame[];
  /** null 表示整个文件完全合法 */
  error: ParseError | null;
}

export function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

/** 原始值 / 10，固定一位小数，例如 -155 -> "-15.5" */
export function formatTemperature(raw: number): string {
  return (raw / 10).toFixed(1);
}

export function parseFrames(data: Uint8Array): ParseResult {
  const frames: ParsedFrame[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const completeCount = Math.floor(data.length / FRAME_SIZE);

  for (let index = 0; index < completeCount; index++) {
    const base = index * FRAME_SIZE;

    const m0 = data[base];
    const m1 = data[base + 1];
    if (m0 !== MAGIC_0 || m1 !== MAGIC_1) {
      return fail(frames, {
        frameIndex: index,
        offset: base,
        field: 'magic',
        expected: 'A5 5A',
        actual: `${hexByte(m0)} ${hexByte(m1)}`,
        message: `期望 A5 5A，实际 ${hexByte(m0)} ${hexByte(m1)}`,
      });
    }

    const version = data[base + 2];
    if (version !== VERSION) {
      return fail(frames, {
        frameIndex: index,
        offset: base + 2,
        field: 'version',
        expected: '01',
        actual: hexByte(version),
        message: `期望 01，实际 ${hexByte(version)}`,
      });
    }

    const flagsRaw = data[base + 3];
    if ((flagsRaw & RESERVED_MASK) !== 0) {
      return fail(frames, {
        frameIndex: index,
        offset: base + 3,
        field: 'flags',
        expected: '位 3-7 全为 0',
        actual: `标志字节 ${hexByte(flagsRaw)}`,
        message: `位 3-7 必须为 0，实际标志字节 ${hexByte(flagsRaw)}`,
      });
    }

    const humidity = data[base + 10];
    if (humidity > HUMIDITY_MAX) {
      return fail(frames, {
        frameIndex: index,
        offset: base + 10,
        field: 'humidity',
        expected: '0-100',
        actual: String(humidity),
        message: `允许 0-100，实际 ${humidity}`,
      });
    }

    const timestamp = view.getUint32(base + 4, true);
    const temperatureRaw = view.getInt16(base + 8, true);
    const temperatureC = formatTemperature(temperatureRaw);
    const sequence = data[base + 11];
    const flags: FrameFlags = {
      highTemp: (flagsRaw & 0b001) !== 0,
      lowTemp: (flagsRaw & 0b010) !== 0,
      lowBattery: (flagsRaw & 0b100) !== 0,
    };

    frames.push({
      index,
      offset: base,
      magic: 'A5 5A',
      version,
      flagsRaw,
      flags,
      timestamp,
      temperatureRaw,
      temperatureC,
      humidity,
      sequence,
      fields: [
        { name: 'magic', offset: base, value: 'A5 5A' },
        { name: 'version', offset: base + 2, value: version },
        { name: 'flags', offset: base + 3, value: flagsRaw },
        { name: 'timestamp', offset: base + 4, value: timestamp },
        { name: 'temperature', offset: base + 8, value: temperatureC },
        { name: 'humidity', offset: base + 10, value: humidity },
        { name: 'sequence', offset: base + 11, value: sequence },
      ],
    });
  }

  const remainder = data.length - completeCount * FRAME_SIZE;
  if (remainder !== 0) {
    const offset = completeCount * FRAME_SIZE;
    return fail(frames, {
      frameIndex: completeCount,
      offset,
      field: 'length',
      expected: '完整的 12 字节帧',
      actual: `仅剩 ${remainder} 字节`,
      message: `文件长度不是 12 的倍数，该帧仅剩 ${remainder} 字节`,
    });
  }

  return { frames, error: null };
}

function fail(frames: ParsedFrame[], error: ParseError): ParseResult {
  return { frames, error };
}

export interface SequenceGap {
  /** 断点前一帧的帧号 */
  prevIndex: number;
  /** 断点后一帧的帧号 */
  nextIndex: number;
  /** 前一帧的序号 */
  prevSequence: number;
  /** 后一帧的实际序号 */
  nextSequence: number;
  /** 期望序号：(prevSequence + 1) % 256 */
  expectedSequence: number;
  /** 后一帧首字节在文件中的绝对偏移 */
  nextOffset: number;
}

export interface ContinuityResult {
  /** true 表示全部相邻帧在 0-255 循环序号下连续（未发现断点） */
  continuous: boolean;
  /** 按文件顺序记录的断点明细 */
  gaps: SequenceGap[];
}

/**
 * 对完全合法文件的帧按文件顺序做 0-255 循环序号连续性检查。
 * 首帧不参与比较；255 -> 0 视为连续；空文件与单帧文件按无断点处理。
 * 仅在整文件解析成功（error === null）后调用，已保留的前置帧不得
 * 当作完整批次结论。
 */
export function checkSequenceContinuity(frames: ParsedFrame[]): ContinuityResult {
  const gaps: SequenceGap[] = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const next = frames[i];
    const expectedSequence = (prev.sequence + 1) % 256;
    if (next.sequence !== expectedSequence) {
      gaps.push({
        prevIndex: prev.index,
        nextIndex: next.index,
        prevSequence: prev.sequence,
        nextSequence: next.sequence,
        expectedSequence,
        nextOffset: next.offset,
      });
    }
  }
  return { continuous: gaps.length === 0, gaps };
}

export interface FrameReport {
  index: number;
  offset: number;
  magic: string;
  version: number;
  flags: FrameFlags;
  timestamp: number;
  temperatureRaw: number;
  temperatureC: string;
  humidity: number;
  sequence: number;
  fields: FieldEntry[];
}

export interface FileReport {
  fileName: string;
  fileSize: number;
  frameCount: number;
  /** 连续性摘要与断点明细，与页面展示一致 */
  continuity: ContinuityResult;
  frames: FrameReport[];
}

/** 生成下载用 JSON 报告，内容与页面表格完全一致 */
export function buildReport(
  fileName: string,
  fileSize: number,
  frames: ParsedFrame[],
): FileReport {
  return {
    fileName,
    fileSize,
    frameCount: frames.length,
    continuity: checkSequenceContinuity(frames),
    frames: frames.map((f) => ({
      index: f.index,
      offset: f.offset,
      magic: f.magic,
      version: f.version,
      flags: { ...f.flags },
      timestamp: f.timestamp,
      temperatureRaw: f.temperatureRaw,
      temperatureC: f.temperatureC,
      humidity: f.humidity,
      sequence: f.sequence,
      fields: f.fields.map((field) => ({ ...field })),
    })),
  };
}
