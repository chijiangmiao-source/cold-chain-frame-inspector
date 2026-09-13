import { describe, expect, it } from 'vitest';
import {
  buildReport,
  CALIBRATION_MAX_TENTHS,
  CALIBRATION_MIN_TENTHS,
  calibratedTemperatureC,
  calibratedTemperatureRaw,
  checkSequenceContinuity,
  formatOffsetC,
  formatTemperature,
  FRAME_SIZE,
  mergeAlarmSegments,
  parseCalibrationInput,
  parseFrames,
} from '../src/parser';

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

describe('校准偏移输入解析', () => {
  it('接受整数与一位小数，换算为十分之一度整数', () => {
    expect(parseCalibrationInput('0')).toMatchObject({ ok: true, offsetTenths: 0 });
    expect(parseCalibrationInput('0.0')).toMatchObject({ ok: true, offsetTenths: 0 });
    expect(parseCalibrationInput('1.5')).toMatchObject({ ok: true, offsetTenths: 15 });
    expect(parseCalibrationInput('2')).toMatchObject({ ok: true, offsetTenths: 20 });
    expect(parseCalibrationInput('-0.1')).toMatchObject({ ok: true, offsetTenths: -1 });
    expect(parseCalibrationInput('+3')).toMatchObject({ ok: true, offsetTenths: 30 });
    expect(parseCalibrationInput('-7.5')).toMatchObject({ ok: true, offsetTenths: -75 });
  });

  it('忽略首尾空白', () => {
    expect(parseCalibrationInput('  2.5  ')).toMatchObject({ ok: true, offsetTenths: 25 });
  });

  it('正负边界 -10.0 与 +10.0 均可接受', () => {
    expect(CALIBRATION_MIN_TENTHS).toBe(-100);
    expect(CALIBRATION_MAX_TENTHS).toBe(100);
    expect(parseCalibrationInput('-10.0')).toMatchObject({ ok: true, offsetTenths: -100 });
    expect(parseCalibrationInput('10.0')).toMatchObject({ ok: true, offsetTenths: 100 });
    expect(parseCalibrationInput('-10')).toMatchObject({ ok: true, offsetTenths: -100 });
    expect(parseCalibrationInput('+10.0')).toMatchObject({ ok: true, offsetTenths: 100 });
  });

  it('超出范围被拒绝：10.1 / -10.1 / 100', () => {
    for (const text of ['10.1', '-10.1', '100', '-25', '11']) {
      const r = parseCalibrationInput(text);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('out-of-range');
      expect(r.offsetTenths).toBeNull();
      expect(r.message).toContain('-10.0 至 +10.0');
    }
  });

  it('非数字被拒绝：字母、空串、孤立符号、多重小数点', () => {
    for (const text of ['abc', '', '   ', '-', '+', '1.2.3', '1,5', '1.', '.5', '1..0']) {
      const r = parseCalibrationInput(text);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('not-a-number');
      expect(r.offsetTenths).toBeNull();
    }
  });

  it('小数位超过一位被拒绝：0.05 / 1.55 / 10.00', () => {
    for (const text of ['0.05', '1.55', '10.00', '-9.99']) {
      const r = parseCalibrationInput(text);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('too-many-decimals');
      expect(r.offsetTenths).toBeNull();
    }
  });
});

describe('校准温度精确运算（十分之一度整数相加）', () => {
  it('原始值与偏移纯整数相加，结果仍是精确整数', () => {
    expect(calibratedTemperatureRaw(235, 15)).toBe(250);
    expect(calibratedTemperatureRaw(1, 2)).toBe(3);
    expect(calibratedTemperatureRaw(268, 15)).toBe(283);
    expect(calibratedTemperatureRaw(-155, -100)).toBe(-255);
    expect(calibratedTemperatureRaw(-155, 100)).toBe(-55);
  });

  it('格式化在整数相加之后进行，无浮点漂移', () => {
    // 0.1 + 0.2 的浮点误差（0.30000000000000004）不会进入计算
    expect(calibratedTemperatureC(1, 2)).toBe('0.3');
    expect(calibratedTemperatureC(268, 15)).toBe('28.3');
    expect(calibratedTemperatureC(235, 15)).toBe('25.0');
    expect(calibratedTemperatureC(-155, -100)).toBe('-25.5');
    expect(calibratedTemperatureC(-155, 100)).toBe('-5.5');
    expect(calibratedTemperatureC(-1, 1)).toBe('0.0');
    expect(calibratedTemperatureC(0, -1)).toBe('-0.1');
  });

  it('正负边界偏移全量程正确', () => {
    expect(calibratedTemperatureC(235, CALIBRATION_MAX_TENTHS)).toBe('33.5');
    expect(calibratedTemperatureC(235, CALIBRATION_MIN_TENTHS)).toBe('13.5');
    expect(calibratedTemperatureC(-32768, CALIBRATION_MIN_TENTHS)).toBe('-3286.8');
  });

  it('偏移文本显式带符号', () => {
    expect(formatOffsetC(0)).toBe('0.0');
    expect(formatOffsetC(15)).toBe('+1.5');
    expect(formatOffsetC(100)).toBe('+10.0');
    expect(formatOffsetC(-1)).toBe('-0.1');
    expect(formatOffsetC(-100)).toBe('-10.0');
  });
});

describe('报告中的校准信息', () => {
  it('传入校准参数：加入校准说明与逐帧校准温度，原字段与既有结构保留', () => {
    const data = bytes(
      makeFrame({ timestamp: 1_700_000_000, tempRaw: 235, humidity: 45, seq: 7, flags: 0b001 }),
      makeFrame({ timestamp: 1_700_000_060, tempRaw: -155, humidity: 60, seq: 8 }),
    );
    const r = parseFrames(data);
    expect(r.error).toBeNull();
    const alarms = mergeAlarmSegments(r.frames);
    const report = buildReport('cal.bin', data.length, r.frames, alarms, {
      offsetTenths: 15,
    });

    // 校准说明
    expect(report.calibration).toEqual({
      offsetTenths: 15,
      offsetC: '+1.5',
      note: expect.stringContaining('0.1 °C 整数相加') as unknown as string,
    });

    // 逐帧校准温度：整数相加结果与格式化文本
    expect(report.frames[0].calibratedTemperatureRaw).toBe(250);
    expect(report.frames[0].calibratedTemperatureC).toBe('25.0');
    expect(report.frames[1].calibratedTemperatureRaw).toBe(-140);
    expect(report.frames[1].calibratedTemperatureC).toBe('-14.0');

    // 原始字段原样保留
    expect(report.frames[0].temperatureRaw).toBe(235);
    expect(report.frames[0].temperatureC).toBe('23.5');
    expect(report.frames[1].temperatureRaw).toBe(-155);
    expect(report.frames[1].temperatureC).toBe('-15.5');
    expect(report.frames[0].humidity).toBe(45);
    expect(report.frames[0].fields.map((x) => x.offset)).toEqual([0, 2, 3, 4, 8, 10, 11]);

    // 既有连续性、告警结构不变
    expect(report.continuity).toEqual(checkSequenceContinuity(r.frames));
    expect(report.alarms).toEqual(alarms);
    expect(report.fileName).toBe('cal.bin');
    expect(report.frameCount).toBe(2);
  });

  it('负偏移边界 -10.0：校准说明与逐帧温度正确', () => {
    const data = bytes(makeFrame({ tempRaw: 235, seq: 1 }));
    const r = parseFrames(data);
    const report = buildReport('neg.bin', data.length, r.frames, mergeAlarmSegments(r.frames), {
      offsetTenths: -100,
    });
    expect(report.calibration?.offsetTenths).toBe(-100);
    expect(report.calibration?.offsetC).toBe('-10.0');
    expect(report.frames[0].calibratedTemperatureRaw).toBe(135);
    expect(report.frames[0].calibratedTemperatureC).toBe('13.5');
  });

  it('零偏移：校准温度与原始温度一致，说明仍在', () => {
    const data = bytes(makeFrame({ tempRaw: -155, seq: 1 }));
    const r = parseFrames(data);
    const report = buildReport('zero.bin', data.length, r.frames, mergeAlarmSegments(r.frames), {
      offsetTenths: 0,
    });
    expect(report.calibration?.offsetC).toBe('0.0');
    expect(report.frames[0].calibratedTemperatureRaw).toBe(-155);
    expect(report.frames[0].calibratedTemperatureC).toBe(report.frames[0].temperatureC);
  });

  it('未传校准参数：输出与现有调用兼容，不含任何校准字段', () => {
    const data = bytes(makeFrame({ tempRaw: 235, humidity: 45, seq: 1 }));
    const r = parseFrames(data);
    const report = buildReport('plain.bin', data.length, r.frames, mergeAlarmSegments(r.frames));
    expect('calibration' in report).toBe(false);
    expect(report.calibration).toBeUndefined();
    expect('calibratedTemperatureRaw' in report.frames[0]).toBe(false);
    expect('calibratedTemperatureC' in report.frames[0]).toBe(false);
    // 既有结构保持
    expect(report.frames[0].temperatureC).toBe('23.5');
    expect(report.continuity).toEqual({ continuous: true, gaps: [] });
  });

  it('显式传 null 与未传参数等价', () => {
    const data = bytes(makeFrame({ tempRaw: 235, seq: 1 }));
    const r = parseFrames(data);
    const report = buildReport(
      'null.bin',
      data.length,
      r.frames,
      mergeAlarmSegments(r.frames),
      null,
    );
    expect('calibration' in report).toBe(false);
    expect('calibratedTemperatureC' in report.frames[0]).toBe(false);
  });

  it('校准不改变告警与连续性结论（仍基于原始字段）', () => {
    const data = bytes(
      makeFrame({ flags: 0b001, tempRaw: 235, seq: 10, timestamp: 100 }),
      makeFrame({ flags: 0b001, tempRaw: 236, seq: 11, timestamp: 200 }),
      makeFrame({ flags: 0b000, tempRaw: 237, seq: 20, timestamp: 300 }),
    );
    const r = parseFrames(data);
    const alarms = mergeAlarmSegments(r.frames);
    const withCal = buildReport('a.bin', data.length, r.frames, alarms, { offsetTenths: 100 });
    const withoutCal = buildReport('a.bin', data.length, r.frames, alarms);
    // 连续性与告警结论与是否校准无关
    expect(withCal.continuity).toEqual(withoutCal.continuity);
    expect(withCal.alarms).toEqual(withoutCal.alarms);
    expect(withCal.continuity.continuous).toBe(false);
    expect(withCal.alarms.summary.highTemp).toBe(1);
    // 校准只新增字段，原始温度字段不变
    expect(withCal.frames[1].temperatureC).toBe('23.6');
    expect(withCal.frames[1].calibratedTemperatureC).toBe('33.6');
  });
});

describe('formatTemperature 在校准场景下的稳定性', () => {
  it('十分之一度整数的格式化始终精确到一位小数', () => {
    expect(formatTemperature(250)).toBe('25.0');
    expect(formatTemperature(-140)).toBe('-14.0');
    expect(formatTemperature(3)).toBe('0.3');
    expect(formatTemperature(-255)).toBe('-25.5');
  });
});
