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

/** 模拟拖动进度条：设置滑块值并派发 input 事件（与真实拖动一致） */
async function dragProgressTo(page: Page, value: number): Promise<void> {
  await page.locator('#replay-progress').evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function frameRows(page: Page) {
  return page.locator('#frames tbody tr');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // 可控时钟：页面内的 setInterval 由测试推进，复盘节拍完全可重复
  await page.clock.install();
});

test('播放逐帧推进并同步高亮当前帧，暂停后保持，抵达末帧立即结束', async ({ page }) => {
  await dropFile(page, 'review.bin', [
    ...makeFrame({ timestamp: 1_700_000_000, tempRaw: 235, humidity: 45, seq: 7, flags: 0b001 }),
    ...makeFrame({ timestamp: 1_700_000_060, tempRaw: -155, humidity: 60, seq: 8 }),
    ...makeFrame({ timestamp: 1_700_000_120, tempRaw: 268, humidity: 50, seq: 9, flags: 0b100 }),
  ]);

  // 初始：待播放，定位首帧并同步展示温度 / 湿度 / 序号 / 告警
  await expect(page.getByTestId('replay-status')).toHaveText('待播放');
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 3 帧');
  await expect(page.getByTestId('replay-temperature')).toHaveText('23.5 °C');
  await expect(page.getByTestId('replay-humidity')).toHaveText('45 %');
  await expect(page.getByTestId('replay-sequence')).toHaveText('7');
  await expect(page.getByTestId('replay-alarms')).toHaveText('高温');
  await expect(frameRows(page).nth(0)).toHaveClass(/replay-current/);
  await expect(frameRows(page).nth(1)).not.toHaveClass(/replay-current/);
  await expect(page.locator('#frames tbody tr.replay-current')).toHaveCount(1);

  // 播放：每拍前进一帧，高亮与展示同步切换
  await page.locator('#replay-play').click();
  await expect(page.getByTestId('replay-status')).toHaveText('播放中');

  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-position')).toHaveText('第 2 / 3 帧');
  await expect(page.getByTestId('replay-temperature')).toHaveText('-15.5 °C');
  await expect(page.getByTestId('replay-humidity')).toHaveText('60 %');
  await expect(page.getByTestId('replay-sequence')).toHaveText('8');
  await expect(page.getByTestId('replay-alarms')).toHaveText('无');
  await expect(frameRows(page).nth(0)).not.toHaveClass(/replay-current/);
  await expect(frameRows(page).nth(1)).toHaveClass(/replay-current/);

  // 暂停：保持当前帧，时间推进不再变化
  await page.locator('#replay-pause').click();
  await expect(page.getByTestId('replay-status')).toHaveText('已暂停');
  await page.clock.runFor(5000);
  await expect(page.getByTestId('replay-status')).toHaveText('已暂停');
  await expect(page.getByTestId('replay-position')).toHaveText('第 2 / 3 帧');
  await expect(frameRows(page).nth(1)).toHaveClass(/replay-current/);

  // 继续播放：抵达末帧立即结束（不多等一拍），高亮停在末帧
  await page.locator('#replay-play').click();
  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
  await expect(page.getByTestId('replay-position')).toHaveText('第 3 / 3 帧');
  await expect(page.getByTestId('replay-alarms')).toHaveText('低电量');
  await expect(frameRows(page).nth(2)).toHaveClass(/replay-current/);
});

test('拖动进度立即定位任意帧，播放中定位后继续推进', async ({ page }) => {
  await dropFile(page, 'seek.bin', [
    ...makeFrame({ tempRaw: 100, humidity: 41, seq: 0 }),
    ...makeFrame({ tempRaw: 110, humidity: 42, seq: 1 }),
    ...makeFrame({ tempRaw: 120, humidity: 43, seq: 2 }),
    ...makeFrame({ tempRaw: 130, humidity: 44, seq: 3, flags: 0b010 }),
    ...makeFrame({ tempRaw: 140, humidity: 45, seq: 4 }),
  ]);

  // 待播放时拖动：立即定位并展示对应帧
  await dragProgressTo(page, 3);
  await expect(page.getByTestId('replay-position')).toHaveText('第 4 / 5 帧');
  await expect(page.getByTestId('replay-temperature')).toHaveText('13.0 °C');
  await expect(page.getByTestId('replay-humidity')).toHaveText('44 %');
  await expect(page.getByTestId('replay-sequence')).toHaveText('3');
  await expect(page.getByTestId('replay-alarms')).toHaveText('低温');
  await expect(frameRows(page).nth(3)).toHaveClass(/replay-current/);
  await expect(page.locator('#frames tbody tr.replay-current')).toHaveCount(1);

  await dragProgressTo(page, 0);
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 5 帧');
  await expect(frameRows(page).nth(0)).toHaveClass(/replay-current/);

  // 播放中拖到中间帧：从定位处继续推进
  await page.locator('#replay-play').click();
  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-position')).toHaveText('第 2 / 5 帧');
  await dragProgressTo(page, 2);
  await expect(page.getByTestId('replay-status')).toHaveText('播放中');
  await expect(page.getByTestId('replay-position')).toHaveText('第 3 / 5 帧');
  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-position')).toHaveText('第 4 / 5 帧');
  await expect(page.getByTestId('replay-status')).toHaveText('播放中');

  // 播放中拖到末帧：立即结束，无需多等一拍
  await dragProgressTo(page, 4);
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
  await expect(page.getByTestId('replay-position')).toHaveText('第 5 / 5 帧');
  await expect(frameRows(page).nth(4)).toHaveClass(/replay-current/);
  await page.clock.runFor(3000);
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
  await expect(page.getByTestId('replay-position')).toHaveText('第 5 / 5 帧');
});

test('抵达末帧立即进入已结束，再次播放从首帧开始', async ({ page }) => {
  await dropFile(page, 'end.bin', [
    ...makeFrame({ tempRaw: 100, seq: 0 }),
    ...makeFrame({ tempRaw: 110, seq: 1 }),
    ...makeFrame({ tempRaw: 120, seq: 2 }),
  ]);

  await page.locator('#replay-play').click();
  // 3 帧批次两拍即抵达末帧：状态立即结束，无需多等一拍
  await page.clock.runFor(2000);
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
  await expect(page.getByTestId('replay-position')).toHaveText('第 3 / 3 帧');
  await expect(frameRows(page).nth(2)).toHaveClass(/replay-current/);

  // 再次播放：从首帧重新开始
  await page.locator('#replay-play').click();
  await expect(page.getByTestId('replay-status')).toHaveText('播放中');
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 3 帧');
  await expect(page.getByTestId('replay-temperature')).toHaveText('10.0 °C');
  await expect(frameRows(page).nth(0)).toHaveClass(/replay-current/);
  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-position')).toHaveText('第 2 / 3 帧');
  await expect(page.getByTestId('replay-status')).toHaveText('播放中');
});

test('换入合法文件时旧会话立即销毁并按新帧重建', async ({ page }) => {
  await dropFile(page, 'a.bin', [
    ...makeFrame({ tempRaw: 100, humidity: 40, seq: 1 }),
    ...makeFrame({ tempRaw: 110, humidity: 41, seq: 2 }),
    ...makeFrame({ tempRaw: 120, humidity: 42, seq: 3 }),
  ]);
  await page.locator('#replay-play').click();
  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-position')).toHaveText('第 2 / 3 帧');

  // 换入新的合法文件：面板按新帧重建，回到待播放首帧
  await dropFile(page, 'b.bin', [
    ...makeFrame({ tempRaw: -155, humidity: 60, seq: 8 }),
    ...makeFrame({ tempRaw: 268, humidity: 50, seq: 9, flags: 0b001 }),
  ]);
  await expect(page.getByTestId('file-name')).toHaveText('b.bin');
  await expect(page.getByTestId('replay-status')).toHaveText('待播放');
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 2 帧');
  await expect(page.getByTestId('replay-temperature')).toHaveText('-15.5 °C');
  await expect(page.getByTestId('replay-sequence')).toHaveText('8');
  await expect(frameRows(page).nth(0)).toHaveClass(/replay-current/);
  await expect(page.locator('#frames tbody tr.replay-current')).toHaveCount(1);

  // 旧会话的时钟不再推进新会话：时间流逝后仍在首帧待播放
  await page.clock.runFor(5000);
  await expect(page.getByTestId('replay-status')).toHaveText('待播放');
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 2 帧');

  // 新会话可正常播放：推进到末帧立即结束
  await page.locator('#replay-play').click();
  await page.clock.runFor(1000);
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
  await expect(page.getByTestId('replay-position')).toHaveText('第 2 / 2 帧');
  await expect(page.getByTestId('replay-alarms')).toHaveText('高温');
});

test('坏文件或空文件：面板解释无法复盘且不利用保留前缀', async ({ page }) => {
  await dropFile(page, 'good.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ tempRaw: 236, seq: 2 }),
  ]);
  await expect(page.locator('#replay-play')).toBeVisible();

  // 换入坏文件（含两个合法前缀帧）：面板解释无法复盘，不提供任何控件
  await dropFile(page, 'bad.bin', [
    ...makeFrame({ tempRaw: 235, seq: 1 }),
    ...makeFrame({ tempRaw: -155, seq: 2 }),
    ...makeFrame({ magic: [0x00, 0x00], seq: 3 }),
  ]);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('replay-unavailable')).toContainText('文件不合格，无法复盘');
  await expect(page.getByTestId('replay-unavailable')).toContainText('仅为文件前缀');
  await expect(page.locator('#replay-play')).toHaveCount(0);
  await expect(page.locator('#replay-pause')).toHaveCount(0);
  await expect(page.locator('#replay-progress')).toHaveCount(0);
  // 保留的合法前缀帧仍在帧表中，但不作为复盘内容高亮
  await expect(frameRows(page)).toHaveCount(2);
  await expect(page.locator('#frames tbody tr.replay-current')).toHaveCount(0);

  // 换入空文件：同样解释无法复盘
  await dropFile(page, 'empty.bin', []);
  await expect(page.getByTestId('replay-unavailable')).toContainText('没有任何帧，无法复盘');
  await expect(page.locator('#replay-play')).toHaveCount(0);
  await expect(page.locator('#replay-progress')).toHaveCount(0);

  // 换回合法文件：复盘面板恢复可用
  await dropFile(page, 'good2.bin', makeFrame({ tempRaw: 50, seq: 5 }));
  await expect(page.getByTestId('replay-unavailable')).toHaveCount(0);
  await expect(page.locator('#replay-play')).toBeVisible();
  await expect(page.getByTestId('replay-status')).toHaveText('待播放');
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 1 帧');

  // 单帧批次：首帧即末帧，播放立即结束；再次播放重新复盘
  await page.locator('#replay-play').click();
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
  await expect(page.getByTestId('replay-position')).toHaveText('第 1 / 1 帧');
  await page.locator('#replay-play').click();
  await expect(page.getByTestId('replay-status')).toHaveText('已结束');
});
