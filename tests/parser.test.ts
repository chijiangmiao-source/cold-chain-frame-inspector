import { describe, expect, it } from 'vitest';
import {
  buildReport,
  checkSequenceContinuity,
  formatTemperature,
  FRAME_SIZE,
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

describe('合法帧解析', () => {
  it('解析单个合法帧的全部字段', () => {
    const r = parseFrames(
      bytes(makeFrame({ timestamp: 1_700_000_000, tempRaw: 235, humidity: 45, seq: 7 })),
    );
    expect(r.error).toBeNull();
    expect(r.frames).toHaveLength(1);
    const f = r.frames[0];
    expect(f.index).toBe(0);
    expect(f.offset).toBe(0);
    expect(f.magic).toBe('A5 5A');
    expect(f.version).toBe(1);
    expect(f.timestamp).toBe(1_700_000_000);
    expect(f.temperatureRaw).toBe(235);
    expect(f.temperatureC).toBe('23.5');
    expect(f.humidity).toBe(45);
    expect(f.sequence).toBe(7);
  });

  it('按原顺序列出每个字段的起始偏移', () => {
    const r = parseFrames(bytes(makeFrame({ seq: 1 }), makeFrame({ seq: 2 })));
    expect(r.error).toBeNull();
    expect(r.frames[0].fields.map((x) => x.offset)).toEqual([0, 2, 3, 4, 8, 10, 11]);
    expect(r.frames[1].fields.map((x) => x.offset)).toEqual([12, 14, 15, 16, 20, 22, 23]);
    expect(r.frames[0].fields.map((x) => x.name)).toEqual([
      'magic',
      'version',
      'flags',
      'timestamp',
      'temperature',
      'humidity',
      'sequence',
    ]);
  });

  it('多帧保持文件原顺序', () => {
    const r = parseFrames(
      bytes(makeFrame({ seq: 3 }), makeFrame({ seq: 1 }), makeFrame({ seq: 2 })),
    );
    expect(r.error).toBeNull();
    expect(r.frames.map((f) => f.sequence)).toEqual([3, 1, 2]);
  });

  it('空文件合法，零帧', () => {
    const r = parseFrames(new Uint8Array(0));
    expect(r.error).toBeNull();
    expect(r.frames).toHaveLength(0);
  });
});

describe('字节序', () => {
  it('时间戳按小端无符号 32 位解析', () => {
    // 字节 78 56 34 12 -> 0x12345678
    const r = parseFrames(bytes(makeFrame({ timestamp: 0x12345678 })));
    expect(r.error).toBeNull();
    expect(r.frames[0].timestamp).toBe(0x12345678);
  });

  it('时间戳支持无符号最大值 0xFFFFFFFF', () => {
    const r = parseFrames(bytes(makeFrame({ timestamp: 0xffffffff })));
    expect(r.error).toBeNull();
    expect(r.frames[0].timestamp).toBe(4294967295);
  });

  it('温度原始值按小端解析：0xFF69 -> -155', () => {
    const r = parseFrames(bytes(makeFrame({ tempRaw: -155 })));
    expect(r.error).toBeNull();
    expect(r.frames[0].temperatureRaw).toBe(-155);
    expect(r.frames[0].temperatureC).toBe('-15.5');
  });

  it('温度原始值最小值 -32768', () => {
    const r = parseFrames(bytes(makeFrame({ tempRaw: -32768 })));
    expect(r.error).toBeNull();
    expect(r.frames[0].temperatureRaw).toBe(-32768);
    expect(r.frames[0].temperatureC).toBe('-3276.8');
  });
});

describe('负数与温度格式化', () => {
  it('固定一位小数', () => {
    expect(formatTemperature(230)).toBe('23.0');
    expect(formatTemperature(0)).toBe('0.0');
    expect(formatTemperature(7)).toBe('0.7');
    expect(formatTemperature(-7)).toBe('-0.7');
    expect(formatTemperature(-1)).toBe('-0.1');
    expect(formatTemperature(-155)).toBe('-15.5');
  });

  it('零下温度逐帧正确', () => {
    const r = parseFrames(
      bytes(makeFrame({ tempRaw: -50 }), makeFrame({ tempRaw: 268 })),
    );
    expect(r.error).toBeNull();
    expect(r.frames[0].temperatureC).toBe('-5.0');
    expect(r.frames[1].temperatureC).toBe('26.8');
  });
});

describe('标志位', () => {
  it('bit0/bit1/bit2 分别解码为高温/低温/低电量', () => {
    const r = parseFrames(bytes(makeFrame({ flags: 0b101 })));
    expect(r.error).toBeNull();
    expect(r.frames[0].flags).toEqual({
      highTemp: true,
      lowTemp: false,
      lowBattery: true,
    });
  });

  it('三个标志位可同时置位', () => {
    const r = parseFrames(bytes(makeFrame({ flags: 0b111 })));
    expect(r.error).toBeNull();
    expect(r.frames[0].flags).toEqual({
      highTemp: true,
      lowTemp: true,
      lowBattery: true,
    });
  });
});

describe('错误偏移定位', () => {
  it('第二帧魔数错误：停在帧首字节（偏移 12），保留第一帧', () => {
    const r = parseFrames(
      bytes(makeFrame({ seq: 1 }), makeFrame({ magic: [0x00, 0x00], seq: 2 })),
    );
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0].sequence).toBe(1);
    expect(r.error).toMatchObject({ frameIndex: 1, offset: 12, field: 'magic' });
  });

  it('魔数第二字节错误同样停在字段首字节', () => {
    const r = parseFrames(bytes(makeFrame({ magic: [0xa5, 0x00] })));
    expect(r.frames).toHaveLength(0);
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 0, field: 'magic' });
  });

  it('版本错误：停在版本字节（偏移 2）', () => {
    const r = parseFrames(bytes(makeFrame({ version: 0x02 })));
    expect(r.frames).toHaveLength(0);
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 2, field: 'version' });
  });

  it('第二帧版本错误：偏移 14', () => {
    const r = parseFrames(bytes(makeFrame(), makeFrame({ version: 0x00 })));
    expect(r.frames).toHaveLength(1);
    expect(r.error).toMatchObject({ frameIndex: 1, offset: 14, field: 'version' });
  });

  it('保留位非零：停在标志字节（偏移 3）', () => {
    const r = parseFrames(bytes(makeFrame({ flags: 0b0000_1000 })));
    expect(r.frames).toHaveLength(0);
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 3, field: 'flags' });
  });

  it('保留位最高位非零也算非法', () => {
    const r = parseFrames(bytes(makeFrame({ flags: 0b1000_0000 })));
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 3, field: 'flags' });
  });

  it('第三帧保留位非法：偏移 27，保留前两帧', () => {
    const r = parseFrames(
      bytes(makeFrame({ seq: 1 }), makeFrame({ seq: 2 }), makeFrame({ flags: 0x20, seq: 3 })),
    );
    expect(r.frames).toHaveLength(2);
    expect(r.error).toMatchObject({ frameIndex: 2, offset: 27, field: 'flags' });
  });

  it('湿度 101 越界：停在湿度字节（偏移 10）', () => {
    const r = parseFrames(bytes(makeFrame({ humidity: 101 })));
    expect(r.frames).toHaveLength(0);
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 10, field: 'humidity' });
  });

  it('第二帧湿度越界：偏移 22', () => {
    const r = parseFrames(bytes(makeFrame(), makeFrame({ humidity: 255 })));
    expect(r.frames).toHaveLength(1);
    expect(r.error).toMatchObject({ frameIndex: 1, offset: 22, field: 'humidity' });
  });

  it('湿度边界 0 与 100 均合法', () => {
    const r = parseFrames(bytes(makeFrame({ humidity: 0 }), makeFrame({ humidity: 100 })));
    expect(r.error).toBeNull();
    expect(r.frames).toHaveLength(2);
  });

  it('文件长度不是 12 的倍数：停在不完整帧的起点', () => {
    const data = bytes(makeFrame({ seq: 1 }));
    const withTail = new Uint8Array([...data, 0xa5, 0x5a, 0x01, 0x00, 0x00]);
    const r = parseFrames(withTail);
    expect(r.frames).toHaveLength(1);
    expect(r.error).toMatchObject({ frameIndex: 1, offset: 12, field: 'length' });
  });

  it('不足一帧的文件：帧 0 偏移 0 处报长度错误', () => {
    const r = parseFrames(new Uint8Array([0xa5, 0x5a, 0x01]));
    expect(r.frames).toHaveLength(0);
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 0, field: 'length' });
  });

  it('完整帧内的错误优先于尾部残缺被报告（按文件顺序首次非法）', () => {
    // 第一帧湿度越界 + 尾部多余字节：应报湿度（偏移 10），而非长度
    const frame = makeFrame({ humidity: 200 });
    const r = parseFrames(new Uint8Array([...frame, 0x00]));
    expect(r.error).toMatchObject({ frameIndex: 0, offset: 10, field: 'humidity' });
  });
});

describe('序号连续性', () => {
  function continuityOf(...seqs: number[]) {
    const r = parseFrames(bytes(...seqs.map((seq) => makeFrame({ seq }))));
    expect(r.error).toBeNull();
    return checkSequenceContinuity(r.frames);
  }

  it('正常递增：未发现断点', () => {
    const c = continuityOf(0, 1, 2, 3, 4);
    expect(c.continuous).toBe(true);
    expect(c.gaps).toEqual([]);
  });

  it('首帧不参与比较：任意起始序号都算连续', () => {
    const c = continuityOf(137, 138, 139);
    expect(c.continuous).toBe(true);
    expect(c.gaps).toEqual([]);
  });

  it('255 -> 0 回绕视为连续', () => {
    const c = continuityOf(253, 254, 255, 0, 1);
    expect(c.continuous).toBe(true);
    expect(c.gaps).toEqual([]);
  });

  it('空文件与单帧文件按无断点处理', () => {
    expect(continuityOf()).toEqual({ continuous: true, gaps: [] });
    expect(continuityOf(200)).toEqual({ continuous: true, gaps: [] });
  });

  it('跳号：记录前后帧号、两侧序号、期望序号与后帧字节偏移', () => {
    const c = continuityOf(1, 2, 5);
    expect(c.continuous).toBe(false);
    expect(c.gaps).toEqual([
      {
        prevIndex: 1,
        nextIndex: 2,
        prevSequence: 2,
        nextSequence: 5,
        expectedSequence: 3,
        nextOffset: 2 * FRAME_SIZE,
      },
    ]);
  });

  it('重复序号视为断点，期望序号为前帧序号 + 1', () => {
    const c = continuityOf(7, 7);
    expect(c.continuous).toBe(false);
    expect(c.gaps).toEqual([
      {
        prevIndex: 0,
        nextIndex: 1,
        prevSequence: 7,
        nextSequence: 7,
        expectedSequence: 8,
        nextOffset: FRAME_SIZE,
      },
    ]);
  });

  it('255 之后期望 0，直接跳到 1 也算断点', () => {
    const c = continuityOf(255, 1);
    expect(c.continuous).toBe(false);
    expect(c.gaps).toEqual([
      {
        prevIndex: 0,
        nextIndex: 1,
        prevSequence: 255,
        nextSequence: 1,
        expectedSequence: 0,
        nextOffset: FRAME_SIZE,
      },
    ]);
  });

  it('多处断点按文件顺序全部记录', () => {
    const c = continuityOf(0, 1, 4, 5, 5, 6, 9);
    expect(c.continuous).toBe(false);
    expect(c.gaps).toEqual([
      {
        prevIndex: 1,
        nextIndex: 2,
        prevSequence: 1,
        nextSequence: 4,
        expectedSequence: 2,
        nextOffset: 2 * FRAME_SIZE,
      },
      {
        prevIndex: 3,
        nextIndex: 4,
        prevSequence: 5,
        nextSequence: 5,
        expectedSequence: 6,
        nextOffset: 4 * FRAME_SIZE,
      },
      {
        prevIndex: 5,
        nextIndex: 6,
        prevSequence: 6,
        nextSequence: 9,
        expectedSequence: 7,
        nextOffset: 6 * FRAME_SIZE,
      },
    ]);
  });

  it('下载报告中的连续性摘要与断点明细和检查函数一致', () => {
    const data = bytes(
      makeFrame({ seq: 10 }),
      makeFrame({ seq: 11 }),
      makeFrame({ seq: 20 }),
    );
    const r = parseFrames(data);
    expect(r.error).toBeNull();
    const report = buildReport('gap.bin', data.length, r.frames);
    expect(report.continuity).toEqual(checkSequenceContinuity(r.frames));
    expect(report.continuity.continuous).toBe(false);
    expect(report.continuity.gaps).toEqual([
      {
        prevIndex: 1,
        nextIndex: 2,
        prevSequence: 11,
        nextSequence: 20,
        expectedSequence: 12,
        nextOffset: 24,
      },
    ]);
  });

  it('连续文件的报告摘要为无断点', () => {
    const data = bytes(makeFrame({ seq: 255 }), makeFrame({ seq: 0 }));
    const r = parseFrames(data);
    const report = buildReport('ok.bin', data.length, r.frames);
    expect(report.continuity).toEqual({ continuous: true, gaps: [] });
  });
});

describe('下载报告', () => {
  it('buildReport 与帧数据一致', () => {
    const data = bytes(
      makeFrame({ timestamp: 1_700_000_000, tempRaw: -155, humidity: 45, seq: 7 }),
    );
    const r = parseFrames(data);
    expect(r.error).toBeNull();
    const report = buildReport('log.bin', data.length, r.frames);
    expect(report.fileName).toBe('log.bin');
    expect(report.fileSize).toBe(12);
    expect(report.frameCount).toBe(1);
    expect(report.frames[0].temperatureC).toBe('-15.5');
    expect(report.frames[0].fields.map((x) => x.offset)).toEqual([
      0, 2, 3, 4, 8, 10, 11,
    ]);
    expect(report.frames[0].fields[3]).toEqual({
      name: 'timestamp',
      offset: 4,
      value: 1_700_000_000,
    });
  });
});
