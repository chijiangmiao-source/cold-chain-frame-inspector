import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface FrameOpts {
  magic?: [number, number];
  version?: number;
  flags?: number;
  timestamp?: number;
  tempRaw?: number;
  humidity?: number;
  seq?: number;
}

/** 与固件帧布局一致地构造 12 字节帧 */
function makeFrame(o: FrameOpts = {}): number[] {
  const b = new Array<number>(12).fill(0);
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

/** 通过 DataTransfer 在拖放区真实派发 drop 事件 */
async function dropFile(page: Page, name: string, bytes: number[]): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    (payload) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array(payload.bytes)], payload.name, {
          type: 'application/octet-stream',
        }),
      );
      return dt;
    },
    { name, bytes },
  );
  await page.locator('#drop-zone').dispatchEvent('drop', { dataTransfer });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('拖放合法文件后按顺序列出帧与字段起始偏移', async ({ page }) => {
  await dropFile(page, 'ok.bin', [
    ...makeFrame({ timestamp: 1_700_000_000, tempRaw: 235, humidity: 45, seq: 1, flags: 0b101 }),
    ...makeFrame({ timestamp: 1_700_000_060, tempRaw: -155, humidity: 60, seq: 2 }),
  ]);

  await expect(page.getByTestId('file-name')).toHaveText('ok.bin');
  const rows = page.locator('#frames tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('23.5');
  await expect(rows.nth(0)).toContainText('1700000000');
  await expect(rows.nth(1)).toContainText('-15.5');

  // 字段明细：每帧 7 个字段，偏移为文件内绝对偏移
  const fields = page.locator('#fields tbody tr');
  await expect(fields).toHaveCount(14);
  await expect(fields.nth(6)).toContainText('11'); // 第一帧序号字段偏移
  await expect(fields.nth(7)).toContainText('12'); // 第二帧魔数字段偏移

  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#download')).toBeVisible();
});

test('换文件后表格整体替换', async ({ page }) => {
  await dropFile(page, 'a.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ tempRaw: 236, seq: 2 }),
  ]);
  await expect(page.locator('#frames tbody tr')).toHaveCount(2);

  await dropFile(page, 'b.bin', makeFrame({ tempRaw: -155, seq: 9 }));
  await expect(page.getByTestId('file-name')).toHaveText('b.bin');
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);
  await expect(page.locator('#frames')).toContainText('-15.5');
  await expect(page.locator('#frames')).not.toContainText('23.6');
});

test('换为坏文件后清除下载入口并显示错误', async ({ page }) => {
  await dropFile(page, 'good.bin', makeFrame({ tempRaw: 235, seq: 1 }));
  await expect(page.locator('#download')).toBeVisible();

  await dropFile(page, 'bad.bin', makeFrame({ magic: [0x00, 0x00] }));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#download')).toHaveCount(0);
});

test('坏文件精确定位出错帧与字节，保留此前合法帧且禁止下载', async ({ page }) => {
  await dropFile(page, 'bad.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ magic: [0x00, 0x00], seq: 2 }),
  ]);

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('第 1 帧');
  await expect(alert).toContainText('字节偏移 12');
  await expect(alert).toContainText('魔数');
  // 保留此前合法帧
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);
  // 禁止下载
  await expect(page.locator('#download')).toHaveCount(0);
});

test('湿度越界指向湿度字节（偏移 10）', async ({ page }) => {
  await dropFile(page, 'hum.bin', makeFrame({ humidity: 101 }));
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('第 0 帧');
  await expect(alert).toContainText('字节偏移 10');
  await expect(alert).toContainText('湿度');
  await expect(page.locator('#download')).toHaveCount(0);
});

test('长度不是 12 的倍数时停在不完整帧起点', async ({ page }) => {
  await dropFile(page, 'tail.bin', [
    ...makeFrame({ seq: 1 }),
    0xa5, 0x5a, 0x01, 0x00, 0x00, // 残缺的第二帧
  ]);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('第 1 帧');
  await expect(alert).toContainText('字节偏移 12');
  await expect(alert).toContainText('帧长度');
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);
  await expect(page.locator('#download')).toHaveCount(0);
});

test('下载的 JSON 与表格一致', async ({ page }) => {
  await dropFile(page, 'ok.bin', [
    ...makeFrame({ timestamp: 1_700_000_000, tempRaw: 235, humidity: 45, seq: 1 }),
    ...makeFrame({ timestamp: 1_700_000_060, tempRaw: -155, humidity: 60, seq: 2 }),
  ]);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('ok.bin.json');

  const path = await download.path();
  const report = JSON.parse(readFileSync(path!, 'utf8')) as {
    fileName: string;
    frameCount: number;
    frames: Array<{
      index: number;
      offset: number;
      temperatureC: string;
      humidity: number;
      sequence: number;
      timestamp: number;
      fields: Array<{ name: string; offset: number }>;
    }>;
  };

  expect(report.fileName).toBe('ok.bin');
  expect(report.frameCount).toBe(2);

  // 与帧概览表格逐格一致
  const row1 = page.locator('#frames tbody tr').nth(1).locator('td');
  await expect(row1.nth(7)).toHaveText('1700000060');
  await expect(row1.nth(8)).toHaveText('-15.5');
  await expect(row1.nth(9)).toHaveText('60');
  await expect(row1.nth(10)).toHaveText('2');
  expect(report.frames[1].timestamp).toBe(1_700_000_060);
  expect(report.frames[1].temperatureC).toBe('-15.5');
  expect(report.frames[1].humidity).toBe(60);
  expect(report.frames[1].sequence).toBe(2);
  expect(report.frames[1].offset).toBe(12);

  // 与字段明细表格的偏移一致
  expect(report.frames[0].fields.map((f) => f.offset)).toEqual([0, 2, 3, 4, 8, 10, 11]);
  expect(report.frames[1].fields.map((f) => f.offset)).toEqual([12, 14, 15, 16, 20, 22, 23]);
});

test('连续文件显示未发现断点，255 -> 0 回绕视为连续', async ({ page }) => {
  await dropFile(page, 'wrap.bin', [
    ...makeFrame({ seq: 254 }),
    ...makeFrame({ seq: 255 }),
    ...makeFrame({ seq: 0 }),
    ...makeFrame({ seq: 1 }),
  ]);

  await expect(page.getByTestId('continuity-ok')).toHaveText(/未发现断点/);
  await expect(page.getByTestId('continuity-gaps')).toHaveCount(0);
  await expect(page.locator('#gaps')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr.gap-after')).toHaveCount(0);
  await expect(page.locator('#download')).toBeVisible();
});

test('含断点文件：列出断点证据、标记后帧，下载 JSON 含一致摘要', async ({ page }) => {
  await dropFile(page, 'gap.bin', [
    ...makeFrame({ seq: 10 }),
    ...makeFrame({ seq: 11 }),
    ...makeFrame({ seq: 20 }), // 跳号断点，后帧为第 2 帧
    ...makeFrame({ seq: 20 }), // 重复号断点，后帧为第 3 帧
  ]);

  // 结论与断点明细
  await expect(page.getByTestId('continuity-gaps')).toHaveText(/存在断点：共 2 处/);
  await expect(page.getByTestId('continuity-ok')).toHaveCount(0);
  const gapRows = page.locator('#gaps tbody tr');
  await expect(gapRows).toHaveCount(2);
  // 第一处：前帧 1（序号 11）-> 后帧 2（序号 20），期望 12，后帧偏移 24
  const cells1 = gapRows.nth(0).locator('td');
  await expect(cells1.nth(0)).toHaveText('1');
  await expect(cells1.nth(1)).toHaveText('2');
  await expect(cells1.nth(2)).toHaveText('11');
  await expect(cells1.nth(3)).toHaveText('20');
  await expect(cells1.nth(4)).toHaveText('12');
  await expect(cells1.nth(5)).toHaveText('24');
  // 第二处：前帧 2（序号 20）-> 后帧 3（序号 20），期望 21，后帧偏移 36
  const cells2 = gapRows.nth(1).locator('td');
  await expect(cells2.nth(0)).toHaveText('2');
  await expect(cells2.nth(1)).toHaveText('3');
  await expect(cells2.nth(2)).toHaveText('20');
  await expect(cells2.nth(3)).toHaveText('20');
  await expect(cells2.nth(4)).toHaveText('21');
  await expect(cells2.nth(5)).toHaveText('36');

  // 帧表中标记对应后帧（第 2、3 帧），其余帧不标记
  const marked = page.locator('#frames tbody tr.gap-after');
  await expect(marked).toHaveCount(2);
  await expect(page.getByTestId('gap-flag')).toHaveCount(2);
  await expect(marked.nth(0)).toContainText('断点后帧');
  await expect(marked.nth(0).locator('td').nth(0)).toContainText('2');
  await expect(marked.nth(1).locator('td').nth(0)).toContainText('3');

  // 合法帧全部可见且仍可下载
  await expect(page.locator('#frames tbody tr')).toHaveCount(4);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  const path = await download.path();
  const report = JSON.parse(readFileSync(path!, 'utf8')) as {
    continuity: {
      continuous: boolean;
      gaps: Array<{
        prevIndex: number;
        nextIndex: number;
        prevSequence: number;
        nextSequence: number;
        expectedSequence: number;
        nextOffset: number;
      }>;
    };
  };
  // 报告中的连续性摘要及断点明细与页面一致
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
    {
      prevIndex: 2,
      nextIndex: 3,
      prevSequence: 20,
      nextSequence: 20,
      expectedSequence: 21,
      nextOffset: 36,
    },
  ]);
});

test('换文件后连续性结论完全替换', async ({ page }) => {
  await dropFile(page, 'gap.bin', [
    ...makeFrame({ seq: 1 }),
    ...makeFrame({ seq: 5 }),
  ]);
  await expect(page.getByTestId('continuity-gaps')).toHaveText(/存在断点：共 1 处/);
  await expect(page.locator('#frames tbody tr.gap-after')).toHaveCount(1);

  await dropFile(page, 'ok.bin', [
    ...makeFrame({ seq: 3 }),
    ...makeFrame({ seq: 4 }),
    ...makeFrame({ seq: 5 }),
  ]);
  await expect(page.getByTestId('continuity-ok')).toHaveText(/未发现断点/);
  await expect(page.getByTestId('continuity-gaps')).toHaveCount(0);
  await expect(page.locator('#gaps')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr.gap-after')).toHaveCount(0);
  await expect(page.getByTestId('gap-flag')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr')).toHaveCount(3);

  // 再换回断点文件，结论再次完整替换
  await dropFile(page, 'gap2.bin', [
    ...makeFrame({ seq: 0 }),
    ...makeFrame({ seq: 2 }),
  ]);
  await expect(page.getByTestId('continuity-gaps')).toHaveText(/存在断点：共 1 处/);
  await expect(page.getByTestId('continuity-ok')).toHaveCount(0);
  await expect(page.locator('#gaps tbody tr')).toHaveCount(1);
  await expect(page.locator('#frames tbody tr.gap-after')).toHaveCount(1);
});

test('坏文件：连续性区域显示未执行，保留帧不被误报为完整批次', async ({ page }) => {
  await dropFile(page, 'bad.bin', [
    ...makeFrame({ seq: 1 }),
    ...makeFrame({ seq: 3 }), // 前置帧本身序号不连续，但文件不合格时不做判断
    ...makeFrame({ magic: [0x00, 0x00], seq: 4 }),
  ]);

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('continuity-skipped')).toHaveText(/文件不合格，未执行/);
  await expect(page.getByTestId('continuity-ok')).toHaveCount(0);
  await expect(page.getByTestId('continuity-gaps')).toHaveCount(0);
  await expect(page.locator('#gaps')).toHaveCount(0);
  // 保留的前置帧仍在，但不带任何断点标记
  await expect(page.locator('#frames tbody tr')).toHaveCount(2);
  await expect(page.locator('#frames tbody tr.gap-after')).toHaveCount(0);
  await expect(page.locator('#download')).toHaveCount(0);
});

test('告警摘要与片段表：三类重叠告警按类型归并，断点处切段', async ({ page }) => {
  await dropFile(page, 'alarms.bin', [
    ...makeFrame({ flags: 0b111, seq: 0, timestamp: 1_700_000_000 }),
    ...makeFrame({ flags: 0b111, seq: 1, timestamp: 1_700_000_060 }),
    ...makeFrame({ flags: 0b000, seq: 2, timestamp: 1_700_000_120 }),
    ...makeFrame({ flags: 0b111, seq: 4, timestamp: 1_700_000_180 }), // 序号断点 3 -> 4
  ]);

  // 摘要：每类各两段（[0,1] 与 [3,3]），共 6 段
  await expect(page.getByTestId('alarms-summary')).toHaveText(
    /共 6 段持续告警：\s*高温 2 段\s*·\s*低温 2 段\s*·\s*低电量 2 段/,
  );
  await expect(page.getByTestId('alarms-empty')).toHaveCount(0);
  await expect(page.getByTestId('alarms-skipped')).toHaveCount(0);

  const segRows = page.locator('#alarm-segments tbody tr');
  await expect(segRows).toHaveCount(6);
  // 顺序：高温两段、低温两段、低电量两段，组内按文件顺序
  const expectRow = async (
    n: number,
    cells: string[],
  ) => {
    const tds = segRows.nth(n).locator('td');
    for (const [i, text] of cells.entries()) {
      await expect(tds.nth(i)).toHaveText(text);
    }
  };
  // 高温 [0,1]：2 帧，字节区间 0..23，时间戳 1700000000..1700000060
  await expectRow(0, ['高温', '0', '1', '2', '0', '23', '1700000000', '1700000060']);
  // 高温 [3,3]：1 帧，字节区间 36..47
  await expectRow(1, ['高温', '3', '3', '1', '36', '47', '1700000180', '1700000180']);
  await expectRow(2, ['低温', '0', '1', '2', '0', '23', '1700000000', '1700000060']);
  await expectRow(3, ['低温', '3', '3', '1', '36', '47', '1700000180', '1700000180']);
  await expectRow(4, ['低电量', '0', '1', '2', '0', '23', '1700000000', '1700000060']);
  await expectRow(5, ['低电量', '3', '3', '1', '36', '47', '1700000180', '1700000180']);
});

test('点击片段定位并高亮对应帧区间，再次点击取消', async ({ page }) => {
  await dropFile(page, 'locate.bin', [
    ...makeFrame({ flags: 0b001, seq: 0 }),
    ...makeFrame({ flags: 0b001, seq: 1 }),
    ...makeFrame({ flags: 0b000, seq: 2 }),
    ...makeFrame({ flags: 0b001, seq: 3 }),
  ]);

  const segRows = page.locator('#alarm-segments tbody tr');
  const frameRows = page.locator('#frames tbody tr');
  await expect(segRows).toHaveCount(2);
  await expect(page.locator('#frames tbody tr.alarm-highlight')).toHaveCount(0);

  // 点击第一段（帧 0-1）：恰好这两帧高亮，片段行呈选中态
  await segRows.nth(0).click();
  await expect(segRows.nth(0)).toHaveClass(/selected/);
  await expect(segRows.nth(1)).not.toHaveClass(/selected/);
  await expect(frameRows.nth(0)).toHaveClass(/alarm-highlight/);
  await expect(frameRows.nth(1)).toHaveClass(/alarm-highlight/);
  await expect(frameRows.nth(2)).not.toHaveClass(/alarm-highlight/);
  await expect(frameRows.nth(3)).not.toHaveClass(/alarm-highlight/);

  // 改点第二段（帧 3）：高亮整体切换到帧 3
  await segRows.nth(1).click();
  await expect(segRows.nth(0)).not.toHaveClass(/selected/);
  await expect(segRows.nth(1)).toHaveClass(/selected/);
  await expect(frameRows.nth(0)).not.toHaveClass(/alarm-highlight/);
  await expect(frameRows.nth(1)).not.toHaveClass(/alarm-highlight/);
  await expect(frameRows.nth(3)).toHaveClass(/alarm-highlight/);

  // 再次点击同一片段取消定位
  await segRows.nth(1).click();
  await expect(segRows.nth(1)).not.toHaveClass(/selected/);
  await expect(page.locator('#frames tbody tr.alarm-highlight')).toHaveCount(0);
});

test('选择其他文件后清除片段定位与帧区间高亮', async ({ page }) => {
  await dropFile(page, 'a.bin', [
    ...makeFrame({ flags: 0b001, seq: 1 }),
    ...makeFrame({ flags: 0b001, seq: 2 }),
  ]);
  await page.locator('#alarm-segments tbody tr').nth(0).click();
  await expect(page.locator('#frames tbody tr.alarm-highlight')).toHaveCount(2);
  await expect(page.locator('#alarm-segments tbody tr.selected')).toHaveCount(1);

  // 换成同样有告警的另一文件：旧定位不得残留
  await dropFile(page, 'b.bin', [
    ...makeFrame({ flags: 0b100, seq: 7 }),
  ]);
  await expect(page.getByTestId('file-name')).toHaveText('b.bin');
  await expect(page.locator('#alarm-segments tbody tr')).toHaveCount(1);
  await expect(page.locator('#alarm-segments tbody tr.selected')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr.alarm-highlight')).toHaveCount(0);

  // 再换成无告警文件：片段表消失，依旧无高亮
  await dropFile(page, 'c.bin', [
    ...makeFrame({ flags: 0b000, seq: 0 }),
    ...makeFrame({ flags: 0b000, seq: 1 }),
  ]);
  await expect(page.getByTestId('alarms-empty')).toBeVisible();
  await expect(page.locator('#alarm-segments')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr.alarm-highlight')).toHaveCount(0);
});

test('无告警时给出明确空态，下载 JSON 中摘要为零且片段为空', async ({ page }) => {
  await dropFile(page, 'quiet.bin', [
    ...makeFrame({ flags: 0b000, seq: 0 }),
    ...makeFrame({ flags: 0b000, seq: 1 }),
    ...makeFrame({ flags: 0b000, seq: 2 }),
  ]);

  await expect(page.getByTestId('alarms-empty')).toHaveText(/未发现任何告警/);
  await expect(page.getByTestId('alarms-summary')).toHaveCount(0);
  await expect(page.locator('#alarm-segments')).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    alarms: {
      summary: { totalSegments: number; highTemp: number; lowTemp: number; lowBattery: number };
      segments: unknown[];
    };
  };
  expect(report.alarms.summary).toEqual({
    totalSegments: 0,
    highTemp: 0,
    lowTemp: 0,
    lowBattery: 0,
  });
  expect(report.alarms.segments).toEqual([]);
});

test('坏文件：告警区域显示未分析，不依据保留前缀生成片段且禁止下载', async ({ page }) => {
  await dropFile(page, 'bad.bin', [
    ...makeFrame({ flags: 0b001, seq: 1 }), // 保留前缀本身带高温，但不得据此生成片段
    ...makeFrame({ flags: 0b001, seq: 2 }),
    ...makeFrame({ magic: [0x00, 0x00], flags: 0b001, seq: 3 }),
  ]);

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('alarms-skipped')).toHaveText(/文件不合格，未分析/);
  await expect(page.getByTestId('alarms-summary')).toHaveCount(0);
  await expect(page.getByTestId('alarms-empty')).toHaveCount(0);
  await expect(page.locator('#alarm-segments')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr.alarm-highlight')).toHaveCount(0);
  await expect(page.locator('#download')).toHaveCount(0);
});

test('下载 JSON 的告警摘要与片段明细和页面一致', async ({ page }) => {
  await dropFile(page, 'alarms.bin', [
    ...makeFrame({ flags: 0b111, seq: 0, timestamp: 1_700_000_000 }),
    ...makeFrame({ flags: 0b111, seq: 1, timestamp: 1_700_000_060 }),
    ...makeFrame({ flags: 0b000, seq: 2, timestamp: 1_700_000_120 }),
    ...makeFrame({ flags: 0b111, seq: 4, timestamp: 1_700_000_180 }), // 序号断点
  ]);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    alarms: {
      summary: { totalSegments: number; highTemp: number; lowTemp: number; lowBattery: number };
      segments: Array<{
        type: string;
        startFrameIndex: number;
        endFrameIndex: number;
        startOffset: number;
        endOffset: number;
        startTimestamp: number;
        endTimestamp: number;
        frameCount: number;
      }>;
    };
  };

  expect(report.alarms.summary).toEqual({
    totalSegments: 6,
    highTemp: 2,
    lowTemp: 2,
    lowBattery: 2,
  });
  expect(report.alarms.segments).toEqual([
    { type: 'highTemp', startFrameIndex: 0, endFrameIndex: 1, startOffset: 0, endOffset: 23, startTimestamp: 1_700_000_000, endTimestamp: 1_700_000_060, frameCount: 2 },
    { type: 'highTemp', startFrameIndex: 3, endFrameIndex: 3, startOffset: 36, endOffset: 47, startTimestamp: 1_700_000_180, endTimestamp: 1_700_000_180, frameCount: 1 },
    { type: 'lowTemp', startFrameIndex: 0, endFrameIndex: 1, startOffset: 0, endOffset: 23, startTimestamp: 1_700_000_000, endTimestamp: 1_700_000_060, frameCount: 2 },
    { type: 'lowTemp', startFrameIndex: 3, endFrameIndex: 3, startOffset: 36, endOffset: 47, startTimestamp: 1_700_000_180, endTimestamp: 1_700_000_180, frameCount: 1 },
    { type: 'lowBattery', startFrameIndex: 0, endFrameIndex: 1, startOffset: 0, endOffset: 23, startTimestamp: 1_700_000_000, endTimestamp: 1_700_000_060, frameCount: 2 },
    { type: 'lowBattery', startFrameIndex: 3, endFrameIndex: 3, startOffset: 36, endOffset: 47, startTimestamp: 1_700_000_180, endTimestamp: 1_700_000_180, frameCount: 1 },
  ]);

  // 页面片段表行数与下载明细一致
  await expect(page.locator('#alarm-segments tbody tr')).toHaveCount(
    report.alarms.segments.length,
  );
});
