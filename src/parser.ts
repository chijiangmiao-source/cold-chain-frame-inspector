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

/**
 * 温度校准偏移：以十分之一度（0.1 °C）整数表示与计算。
 *
 * 冷库探头定期校准后会产生统一温度偏移，巡检人员用当前校准值复核
 * 合法批次。所有校准运算均为整数相加（原始值与偏移同为 0.1 °C
 * 整数），避免 0.1 + 0.2 之类的浮点漂移。
 */

/** 校准偏移下限：-10.0 °C */
export const CALIBRATION_MIN_TENTHS = -100;
/** 校准偏移上限：+10.0 °C */
export const CALIBRATION_MAX_TENTHS = 100;

/**
 * 校准后温度原始值 = 原始值 + 偏移（均为 0.1 °C 整数）。
 * 纯整数相加，结果仍是精确的十分之一度整数。
 */
export function calibratedTemperatureRaw(
  temperatureRaw: number,
  offsetTenths: number,
): number {
  return temperatureRaw + offsetTenths;
}

/** 校准后摄氏度文本：整数相加后再格式化，固定一位小数 */
export function calibratedTemperatureC(
  temperatureRaw: number,
  offsetTenths: number,
): string {
  return formatTemperature(calibratedTemperatureRaw(temperatureRaw, offsetTenths));
}

/**
 * 偏移的摄氏度表示，固定一位小数并显式带符号：
 * 15 -> "+1.5"，-100 -> "-10.0"，0 -> "0.0"。
 */
export function formatOffsetC(offsetTenths: number): string {
  const abs = formatTemperature(Math.abs(offsetTenths));
  if (offsetTenths > 0) return `+${abs}`;
  if (offsetTenths < 0) return `-${abs}`;
  return '0.0';
}

export type CalibrationInputError =
  /** 无法解析为数字（含空输入） */
  | 'not-a-number'
  /** 小数位超过一位（校准按 0.1 °C 步进） */
  | 'too-many-decimals'
  /** 超出 -10.0 ~ +10.0 °C 范围 */
  | 'out-of-range';

export interface CalibrationInputResult {
  /** true 表示输入合法，offsetTenths 有效 */
  ok: boolean;
  /** 解析成功时的偏移（0.1 °C 整数）；失败时为 null */
  offsetTenths: number | null;
  /** 失败原因；成功时为 null */
  error: CalibrationInputError | null;
  /** 面向用户的错误说明；成功时为 null */
  message: string | null;
}

/**
 * 解析校准偏移输入：允许整数或最多一位小数，范围 -10.0 ~ +10.0 °C。
 *
 * 解析全程按文本拆分符号 / 整数 / 小数位再合成十分之一度整数，
 * 不经过浮点运算，"0.05" 之类输入按"小数位过多"拒绝而非四舍五入。
 * 失败时调用方应保留上次有效结果。
 */
export function parseCalibrationInput(text: string): CalibrationInputResult {
  const trimmed = text.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      offsetTenths: null,
      error: 'not-a-number',
      message: `「${text}」不是有效数字：请输入 -10.0 至 +10.0 之间、最多一位小数的数值。`,
    };
  }
  const [, sign, intPart, fracPart = ''] = match;
  if (fracPart.length > 1) {
    return {
      ok: false,
      offsetTenths: null,
      error: 'too-many-decimals',
      message: '小数位过多：校准偏移按 0.1 °C 步进，最多允许一位小数。',
    };
  }
  const magnitude = Number(intPart) * 10 + (fracPart.length === 1 ? Number(fracPart) : 0);
  const offsetTenths = sign === '-' ? -magnitude : magnitude;
  if (offsetTenths < CALIBRATION_MIN_TENTHS || offsetTenths > CALIBRATION_MAX_TENTHS) {
    return {
      ok: false,
      offsetTenths: null,
      error: 'out-of-range',
      message: '超出范围：校准偏移必须在 -10.0 至 +10.0 °C 之间。',
    };
  }
  return { ok: true, offsetTenths, error: null, message: null };
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
  /** 校准后温度原始值（0.1 °C 整数），仅构建报告时传入校准参数才存在 */
  calibratedTemperatureRaw?: number;
  /** 校准后摄氏度（固定一位小数），仅构建报告时传入校准参数才存在 */
  calibratedTemperatureC?: string;
}

/** 告警类型，与帧标志位一一对应：高温 / 低温 / 低电量 */
export const ALARM_TYPES = ['highTemp', 'lowTemp', 'lowBattery'] as const;
export type AlarmType = (typeof ALARM_TYPES)[number];

export interface AlarmSegment {
  /** 告警类型：highTemp 高温、lowTemp 低温、lowBattery 低电量 */
  type: AlarmType;
  /** 片段起始帧号（包含） */
  startFrameIndex: number;
  /** 片段结束帧号（包含） */
  endFrameIndex: number;
  /** 起始帧首字节在文件中的绝对偏移 */
  startOffset: number;
  /** 结束帧末字节在文件中的绝对偏移（含），与起始偏移构成完整字节区间 */
  endOffset: number;
  /** 起始帧的小端秒时间戳 */
  startTimestamp: number;
  /** 结束帧的小端秒时间戳 */
  endTimestamp: number;
  /** 片段包含的帧数 */
  frameCount: number;
}

export interface AlarmSummary {
  /** 三类告警片段总数 */
  totalSegments: number;
  highTemp: number;
  lowTemp: number;
  lowBattery: number;
}

export interface AlarmResult {
  summary: AlarmSummary;
  /**
   * 片段明细：按类型分组（高温、低温、低电量），组内按文件顺序排列。
   * 三类标志各自独立归并，同一帧可同时出现在三类片段中（告警可重叠）。
   */
  segments: AlarmSegment[];
}

/**
 * 对完全合法文件的帧按文件顺序分别归并三类告警标志。
 *
 * 某标志连续为真形成一个片段；遇到假值或文件结束即闭合。相邻两帧
 * 即使标志都为真，只要 0-255 循环序号不连续（存在断点），也在断点
 * 处切成两段，绝不跨序号断点合并；255 -> 0 的回绕视为连续。
 * 仅在整文件解析成功（error === null）后调用，与连续性检查一致：
 * 已保留的前置帧不得当作完整批次的告警结论。
 */
export function mergeAlarmSegments(frames: ParsedFrame[]): AlarmResult {
  const segments: AlarmSegment[] = [];
  const summary: AlarmSummary = {
    totalSegments: 0,
    highTemp: 0,
    lowTemp: 0,
    lowBattery: 0,
  };

  for (const type of ALARM_TYPES) {
    let segStart: ParsedFrame | null = null;
    let segEnd: ParsedFrame | null = null;

    const push = (start: ParsedFrame, end: ParsedFrame): void => {
      segments.push({
        type,
        startFrameIndex: start.index,
        endFrameIndex: end.index,
        startOffset: start.offset,
        endOffset: end.offset + FRAME_SIZE - 1,
        startTimestamp: start.timestamp,
        endTimestamp: end.timestamp,
        frameCount: end.index - start.index + 1,
      });
      summary[type] += 1;
      summary.totalSegments += 1;
    };

    for (const frame of frames) {
      if (frame.flags[type]) {
        if (segStart !== null && segEnd !== null) {
          const expectedSequence = (segEnd.sequence + 1) % 256;
          if (frame.sequence !== expectedSequence) {
            // 序号断点：先在前一帧闭合旧片段，再从当前帧开启新片段
            push(segStart, segEnd);
            segStart = frame;
          }
        } else {
          // 此前为假值或片段刚开始：从当前帧开启
          segStart = frame;
        }
        segEnd = frame;
      } else if (segStart !== null) {
        // 遇到假值：片段在上一帧（最后一个为真的帧）闭合
        push(segStart, segEnd as ParsedFrame);
        segStart = null;
        segEnd = null;
      }
    }

    // 文件结束：仍在延续的片段在末帧闭合
    if (segStart !== null) push(segStart, segEnd as ParsedFrame);
  }

  return { summary, segments };
}

/** 报告中的校准说明：描述本次复核使用的统一温度偏移 */
export interface CalibrationReport {
  /** 温度偏移，0.1 °C 整数（如 15 表示 +1.5 °C） */
  offsetTenths: number;
  /** 偏移的摄氏度表示，固定一位小数并显式带符号，如 "+1.5"、"-10.0"、"0.0" */
  offsetC: string;
  /** 校准说明：校准温度的由来及其不影响既有结论的声明 */
  note: string;
}

export interface FileReport {
  fileName: string;
  fileSize: number;
  frameCount: number;
  /** 连续性摘要与断点明细，与页面展示一致 */
  continuity: ContinuityResult;
  /** 告警摘要与片段明细，与页面展示一致（仅整文件合法时生成） */
  alarms: AlarmResult;
  /** 校准说明：仅构建报告时传入校准参数才存在 */
  calibration?: CalibrationReport;
  frames: FrameReport[];
}

/** 生成下载用 JSON 报告，内容与页面表格完全一致 */
export function buildReport(
  fileName: string,
  fileSize: number,
  frames: ParsedFrame[],
  alarms: AlarmResult,
  calibration?: { offsetTenths: number } | null,
): FileReport {
  const offsetTenths = calibration?.offsetTenths ?? null;
  const report: FileReport = {
    fileName,
    fileSize,
    frameCount: frames.length,
    continuity: checkSequenceContinuity(frames),
    alarms,
    frames: frames.map((f) => {
      const frame: FrameReport = {
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
      };
      if (offsetTenths !== null) {
        // 逐帧校准温度：0.1 °C 整数相加，避免浮点漂移；原始字段原样保留
        frame.calibratedTemperatureRaw = calibratedTemperatureRaw(
          f.temperatureRaw,
          offsetTenths,
        );
        frame.calibratedTemperatureC = formatTemperature(frame.calibratedTemperatureRaw);
      }
      return frame;
    }),
  };
  if (offsetTenths !== null) {
    report.calibration = {
      offsetTenths,
      offsetC: formatOffsetC(offsetTenths),
      note: '校准温度 = 原始温度 + 校准偏移，按 0.1 °C 整数相加以避免浮点漂移；'
        + '原始字段、湿度、序号连续性与告警结论均基于原始数据，不受校准影响。',
    };
  }
  return report;
}
