import { expect, test, type Page } from '@playwright/test';

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

interface ReadControl {
  delays: Record<string, number>;
  failures: string[];
}

/** 在页面内改写 File.prototype.arrayBuffer，按文件名注入读取延迟或读取失败 */
async function installReadControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control: ReadControl = { delays: {}, failures: [] };
    (window as unknown as { __readControl: ReadControl }).__readControl = control;
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function (this: File): Promise<ArrayBuffer> {
      const delay = control.delays[this.name] ?? 0;
      if (control.failures.includes(this.name)) {
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error('模拟读取失败')), delay),
        );
      }
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          original.call(this).then(resolve, reject);
        }, delay),
      );
    };
  });
}

async function setReadControl(page: Page, control: Partial<ReadControl>): Promise<void> {
  await page.evaluate((patch) => {
    const control = (window as unknown as { __readControl: ReadControl }).__readControl;
    if (patch.delays) control.delays = patch.delays;
    if (patch.failures) control.failures = patch.failures;
  }, control);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installReadControl(page);
});

test('连续选择慢读取的旧批次与快读取的新批次：旧批次不得覆盖新批次结果', async ({ page }) => {
  await setReadControl(page, { delays: { 'old.bin': 400, 'new.bin': 0 } });

  // 先选读取较慢的旧批次（3 帧），再立刻选读取较快的新批次（1 帧）
  await dropFile(page, 'old.bin', [
    ...makeFrame({ tempRaw: 100, seq: 1 }),
    ...makeFrame({ tempRaw: 101, seq: 2 }),
    ...makeFrame({ tempRaw: 102, seq: 3 }),
  ]);
  await dropFile(page, 'new.bin', makeFrame({ tempRaw: -155, seq: 9 }));

  // 新批次先读取完成并展示
  await expect(page.getByTestId('file-name')).toHaveText('new.bin');
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);
  await expect(page.locator('#frames')).toContainText('-15.5');

  // 等旧批次的读取也结束后，页面仍保留最后选择的新批次结果
  await page.waitForTimeout(700);
  await expect(page.getByTestId('file-name')).toHaveText('new.bin');
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);
  await expect(page.locator('#frames')).toContainText('-15.5');
  await expect(page.locator('#frames')).not.toContainText('10.2');
  await expect(page.getByTestId('reading')).toHaveCount(0);
});

test('已有合法批次时选择读取较慢的新文件：等待期间不展示旧结果、禁止下载', async ({ page }) => {
  // 先得到一个合法批次结果
  await dropFile(page, 'good.bin', makeFrame({ tempRaw: 235, seq: 1 }));
  await expect(page.locator('#download')).toBeVisible();
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);

  // 再选择读取较慢的新文件
  await setReadControl(page, { delays: { 'slow.bin': 500 } });
  await dropFile(page, 'slow.bin', [
    ...makeFrame({ tempRaw: -155, seq: 7 }),
    ...makeFrame({ tempRaw: 100, seq: 8 }),
  ]);

  // 等待期间：明确处于读取中状态，旧批次结果与下载入口不再展示，
  // 旧报告不会被当作新文件的结果
  await expect(page.getByTestId('reading')).toBeVisible();
  await expect(page.getByTestId('file-name')).toHaveText('slow.bin');
  await expect(page.locator('#download')).toHaveCount(0);
  await expect(page.locator('#frames')).toHaveCount(0);
  await expect(page.locator('#continuity')).toHaveCount(0);

  // 读取完成后展示新文件自己的结果，下载恢复
  await expect(page.locator('#frames tbody tr')).toHaveCount(2);
  await expect(page.locator('#frames')).toContainText('-15.5');
  await expect(page.locator('#frames')).not.toContainText('23.5');
  await expect(page.locator('#download')).toBeVisible();
});

test('已有合法结果后选择无法读取的批次：明确展示失败并阻止旧结果误用', async ({ page }) => {
  // 先得到一个合法批次结果
  await dropFile(page, 'good.bin', makeFrame({ tempRaw: 235, seq: 1 }));
  await expect(page.locator('#download')).toBeVisible();

  // 再选择无法读取的批次
  await setReadControl(page, { failures: ['broken.bin'] });
  await dropFile(page, 'broken.bin', makeFrame({ tempRaw: 100, seq: 2 }));

  // 页面明确反映本次读取失败
  await expect(page.getByTestId('read-error')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('读取失败');
  await expect(page.getByTestId('read-error')).toContainText('broken.bin');
  await expect(page.getByTestId('file-name')).toHaveText('broken.bin');

  // 旧批次结果与下载入口均已清除，不会被误当作本次文件的结果
  await expect(page.locator('#download')).toHaveCount(0);
  await expect(page.locator('#frames')).toHaveCount(0);
  await expect(page.locator('#continuity')).toHaveCount(0);
  await expect(page.getByTestId('reading')).toHaveCount(0);

  // 重新选择可读文件后恢复正常
  await dropFile(page, 'retry.bin', makeFrame({ tempRaw: 50, seq: 5 }));
  await expect(page.getByTestId('read-error')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#frames tbody tr')).toHaveCount(1);
  await expect(page.locator('#download')).toBeVisible();
});
