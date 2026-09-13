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

/** 帧表格单元格：列 8 = 原始温度，列 9 = 校准温度 */
function frameCell(page: Page, row: number, col: number) {
  return page.locator('#frames tbody tr').nth(row).locator('td').nth(col);
}

async function applyOffset(page: Page, value: string): Promise<void> {
  await page.getByTestId('calibration-input').fill(value);
  await page.locator('#calibration-apply').click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('合法文件解析成功后出现校准区，零偏移时校准温度与原始温度一致', async ({ page }) => {
  await dropFile(page, 'cal.bin', [
    ...makeFrame({ tempRaw: 235, humidity: 45, seq: 1 }),
    ...makeFrame({ tempRaw: -155, humidity: 60, seq: 2 }),
  ]);

  await expect(page.locator('#calibration')).toBeVisible();
  await expect(page.getByTestId('calibration-current')).toContainText('0.0 °C');
  await expect(page.getByTestId('calibration-input')).toHaveValue('0.0');
  // 帧表并列显示原始温度与校准温度，零偏移时两列一致
  await expect(frameCell(page, 0, 8)).toHaveText('23.5');
  await expect(frameCell(page, 0, 9)).toHaveText('23.5');
  await expect(frameCell(page, 1, 8)).toHaveText('-15.5');
  await expect(frameCell(page, 1, 9)).toHaveText('-15.5');
  await expect(page.getByTestId('calibration-error')).toHaveCount(0);
});

test('应用正偏移后立即刷新全部校准温度，原始温度与既有结论不变', async ({ page }) => {
  await dropFile(page, 'cal.bin', [
    ...makeFrame({ tempRaw: 235, humidity: 45, seq: 1, flags: 0b001 }),
    ...makeFrame({ tempRaw: -155, humidity: 60, seq: 2 }),
    ...makeFrame({ tempRaw: 268, humidity: 50, seq: 3 }),
  ]);

  await applyOffset(page, '1.5');

  await expect(page.getByTestId('calibration-current')).toContainText('+1.5 °C');
  await expect(page.getByTestId('calibration-input')).toHaveValue('1.5');
  // 校准温度 = 原始 + 1.5（0.1 °C 整数相加：235+15=250、-155+15=-140、268+15=283）
  await expect(frameCell(page, 0, 9)).toHaveText('25.0');
  await expect(frameCell(page, 1, 9)).toHaveText('-14.0');
  await expect(frameCell(page, 2, 9)).toHaveText('28.3');
  // 原始温度列不变
  await expect(frameCell(page, 0, 8)).toHaveText('23.5');
  await expect(frameCell(page, 1, 8)).toHaveText('-15.5');
  await expect(frameCell(page, 2, 8)).toHaveText('26.8');
  // 湿度与告警等既有结论仍基于原始字段
  await expect(frameCell(page, 0, 10)).toHaveText('45');
  await expect(page.getByTestId('alarms-summary')).toContainText('高温 1 段');
  await expect(page.getByTestId('continuity-ok')).toBeVisible();
});

test('负偏移应用后校准温度按整数相减', async ({ page }) => {
  await dropFile(page, 'neg.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ tempRaw: -155, seq: 2 }),
  ]);

  await applyOffset(page, '-2.0');

  await expect(page.getByTestId('calibration-current')).toContainText('-2.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('21.5');
  await expect(frameCell(page, 1, 9)).toHaveText('-17.5');
});

test('正负边界 -10.0 与 +10.0 均可应用', async ({ page }) => {
  await dropFile(page, 'bound.bin', makeFrame({ tempRaw: 235, seq: 1 }));

  await applyOffset(page, '-10.0');
  await expect(page.getByTestId('calibration-current')).toContainText('-10.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('13.5');
  await expect(page.getByTestId('calibration-error')).toHaveCount(0);

  await applyOffset(page, '+10.0');
  await expect(page.getByTestId('calibration-current')).toContainText('+10.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('33.5');
  await expect(page.getByTestId('calibration-error')).toHaveCount(0);
});

test('超范围输入在输入处反馈并保留上次有效结果', async ({ page }) => {
  await dropFile(page, 'range.bin', makeFrame({ tempRaw: 235, seq: 1 }));

  await applyOffset(page, '1.0');
  await expect(frameCell(page, 0, 9)).toHaveText('24.5');

  // 10.1 超出 +10.0 上限：提示错误，生效值保持 1.0
  await applyOffset(page, '10.1');
  await expect(page.getByTestId('calibration-error')).toContainText('超出范围');
  await expect(page.getByTestId('calibration-current')).toContainText('+1.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('24.5');

  // -10.1 超出下限同样被拒绝
  await applyOffset(page, '-10.1');
  await expect(page.getByTestId('calibration-error')).toContainText('超出范围');
  await expect(page.getByTestId('calibration-current')).toContainText('+1.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('24.5');

  // 再次输入合法值后错误清除、立即生效
  await applyOffset(page, '0.5');
  await expect(page.getByTestId('calibration-error')).toHaveCount(0);
  await expect(frameCell(page, 0, 9)).toHaveText('24.0');
});

test('非数字与小数位过多均在输入处反馈且保留上次有效结果', async ({ page }) => {
  await dropFile(page, 'invalid.bin', makeFrame({ tempRaw: 235, seq: 1 }));

  await applyOffset(page, '2.0');
  await expect(frameCell(page, 0, 9)).toHaveText('25.5');

  await applyOffset(page, 'abc');
  await expect(page.getByTestId('calibration-error')).toContainText('不是有效数字');
  await expect(page.getByTestId('calibration-current')).toContainText('+2.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('25.5');

  await applyOffset(page, '0.05');
  await expect(page.getByTestId('calibration-error')).toContainText('小数位过多');
  await expect(page.getByTestId('calibration-current')).toContainText('+2.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('25.5');

  await applyOffset(page, '1.55');
  await expect(page.getByTestId('calibration-error')).toContainText('小数位过多');
  await expect(frameCell(page, 0, 9)).toHaveText('25.5');
});

test('重置恢复零偏移并清除输入反馈', async ({ page }) => {
  await dropFile(page, 'reset.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ tempRaw: -155, seq: 2 }),
  ]);

  await applyOffset(page, '3.5');
  await expect(frameCell(page, 0, 9)).toHaveText('27.0');

  await page.locator('#calibration-reset').click();
  await expect(page.getByTestId('calibration-current')).toContainText('0.0 °C');
  await expect(page.getByTestId('calibration-input')).toHaveValue('0.0');
  await expect(frameCell(page, 0, 9)).toHaveText('23.5');
  await expect(frameCell(page, 1, 9)).toHaveText('-15.5');
  await expect(page.getByTestId('calibration-error')).toHaveCount(0);

  // 先制造输入错误再重置：错误一并清除
  await applyOffset(page, '99');
  await expect(page.getByTestId('calibration-error')).toBeVisible();
  await page.locator('#calibration-reset').click();
  await expect(page.getByTestId('calibration-error')).toHaveCount(0);
  await expect(page.getByTestId('calibration-current')).toContainText('0.0 °C');
});

test('更换文件后继续使用当前偏移', async ({ page }) => {
  await dropFile(page, 'a.bin', makeFrame({ tempRaw: 235, seq: 1 }));
  await applyOffset(page, '2.0');
  await expect(frameCell(page, 0, 9)).toHaveText('25.5');

  // 换成另一合法文件：偏移继承，新文件校准温度立即按 +2.0 计算
  await dropFile(page, 'b.bin', [
    ...makeFrame({ tempRaw: 100, seq: 5 }),
    ...makeFrame({ tempRaw: -50, seq: 6 }),
  ]);
  await expect(page.getByTestId('file-name')).toHaveText('b.bin');
  await expect(page.getByTestId('calibration-current')).toContainText('+2.0 °C');
  await expect(page.getByTestId('calibration-input')).toHaveValue('2.0');
  await expect(frameCell(page, 0, 8)).toHaveText('10.0');
  await expect(frameCell(page, 0, 9)).toHaveText('12.0');
  await expect(frameCell(page, 1, 8)).toHaveText('-5.0');
  await expect(frameCell(page, 1, 9)).toHaveText('-3.0');
});

test('坏文件禁止应用校准与下载，合法文件恢复后偏移仍在', async ({ page }) => {
  await dropFile(page, 'good.bin', makeFrame({ tempRaw: 235, seq: 1 }));
  await applyOffset(page, '1.0');
  await expect(frameCell(page, 0, 9)).toHaveText('24.5');

  // 换成坏文件：无校准输入入口、无下载入口
  await dropFile(page, 'bad.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ magic: [0x00, 0x00], seq: 2 }),
  ]);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('calibration-blocked')).toContainText('禁止应用校准偏移');
  await expect(page.getByTestId('calibration-input')).toHaveCount(0);
  await expect(page.locator('#calibration-apply')).toHaveCount(0);
  await expect(page.locator('#calibration-reset')).toHaveCount(0);
  await expect(page.locator('#download')).toHaveCount(0);

  // 换回合法文件：偏移继续生效
  await dropFile(page, 'good2.bin', makeFrame({ tempRaw: 100, seq: 9 }));
  await expect(page.getByTestId('calibration-input')).toBeVisible();
  await expect(page.getByTestId('calibration-current')).toContainText('+1.0 °C');
  await expect(frameCell(page, 0, 9)).toHaveText('11.0');
});

test('下载报告包含校准说明与逐帧校准温度，与页面一致', async ({ page }) => {
  await dropFile(page, 'report.bin', [
    ...makeFrame({ timestamp: 1_700_000_000, tempRaw: 235, humidity: 45, seq: 1, flags: 0b001 }),
    ...makeFrame({ timestamp: 1_700_000_060, tempRaw: -155, humidity: 60, seq: 2 }),
  ]);
  await applyOffset(page, '-2.0');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    calibration?: { offsetTenths: number; offsetC: string; note: string };
    continuity: { continuous: boolean };
    alarms: { summary: { totalSegments: number; highTemp: number } };
    frames: Array<{
      temperatureRaw: number;
      temperatureC: string;
      humidity: number;
      calibratedTemperatureRaw?: number;
      calibratedTemperatureC?: string;
    }>;
  };

  // 校准说明
  expect(report.calibration).toBeDefined();
  expect(report.calibration!.offsetTenths).toBe(-20);
  expect(report.calibration!.offsetC).toBe('-2.0');
  expect(report.calibration!.note).toContain('0.1 °C 整数相加');

  // 逐帧校准温度与页面校准温度列一致
  expect(report.frames[0].calibratedTemperatureRaw).toBe(215);
  expect(report.frames[0].calibratedTemperatureC).toBe('21.5');
  expect(report.frames[1].calibratedTemperatureRaw).toBe(-175);
  expect(report.frames[1].calibratedTemperatureC).toBe('-17.5');
  await expect(frameCell(page, 0, 9)).toHaveText(report.frames[0].calibratedTemperatureC!);
  await expect(frameCell(page, 1, 9)).toHaveText(report.frames[1].calibratedTemperatureC!);

  // 原始字段与既有结论保留
  expect(report.frames[0].temperatureRaw).toBe(235);
  expect(report.frames[0].temperatureC).toBe('23.5');
  expect(report.frames[0].humidity).toBe(45);
  expect(report.continuity.continuous).toBe(true);
  expect(report.alarms.summary.highTemp).toBe(1);
});

test('零偏移时下载报告同样携带校准说明，与页面一致', async ({ page }) => {
  await dropFile(page, 'zero.bin', makeFrame({ tempRaw: 235, seq: 1 }));

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    calibration?: { offsetTenths: number; offsetC: string };
    frames: Array<{ temperatureC: string; calibratedTemperatureC?: string }>;
  };
  expect(report.calibration).toBeDefined();
  expect(report.calibration!.offsetTenths).toBe(0);
  expect(report.calibration!.offsetC).toBe('0.0');
  expect(report.frames[0].calibratedTemperatureC).toBe(report.frames[0].temperatureC);
  await expect(frameCell(page, 0, 9)).toHaveText(report.frames[0].calibratedTemperatureC!);
});
