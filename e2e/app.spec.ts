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
