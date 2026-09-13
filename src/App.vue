<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  buildReport,
  calibratedTemperatureC,
  checkSequenceContinuity,
  formatOffsetC,
  formatTemperature,
  mergeAlarmSegments,
  parseCalibrationInput,
  parseFrames,
  type AlarmResult,
  type AlarmType,
  type ContinuityResult,
  type ErrorField,
  type FieldName,
  type ParseResult,
  type ParsedFrame,
} from './parser';

const ERROR_FIELD_LABELS: Record<ErrorField, string> = {
  length: '帧长度',
  magic: '魔数',
  version: '版本',
  flags: '标志保留位',
  humidity: '湿度',
};

const FIELD_LABELS: Record<FieldName, string> = {
  magic: '魔数',
  version: '版本',
  flags: '标志',
  timestamp: '时间戳',
  temperature: '温度',
  humidity: '湿度',
  sequence: '序号',
};

const ALARM_LABELS: Record<AlarmType, string> = {
  highTemp: '高温',
  lowTemp: '低温',
  lowBattery: '低电量',
};

const fileName = ref<string | null>(null);
const fileSize = ref(0);
const result = ref<ParseResult | null>(null);
/** 正在异步读取文件：此期间不展示任何批次结果，下载入口隐藏 */
const reading = ref(false);
/** 本次选择的文件读取失败（非解析失败），与旧批次结果严格区分 */
const readError = ref<string | null>(null);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * 当前生效的温度校准偏移（0.1 °C 整数），初始为零偏移。
 * 更换文件后继续使用当前偏移；仅"重置"恢复零偏移。
 */
const calibrationTenths = ref(0);
/** 校准偏移输入框文本，更换文件后重新同步为当前生效偏移 */
const calibrationInput = ref('0.0');
/**
 * 校准输入校验错误（超范围 / 非数字 / 小数位过多）：
 * 在输入处反馈，生效偏移保持上次有效结果不变。
 */
const calibrationError = ref<string | null>(null);
/** 当前生效偏移的摄氏度表示，如 "+1.5"、"0.0" */
const calibrationOffsetC = computed(() => formatOffsetC(calibrationTenths.value));

const error = computed(() => result.value?.error ?? null);
const frames = computed(() => result.value?.frames ?? []);
/** 完全合法（无任何错误）才允许下载 */
const canDownload = computed(() => result.value !== null && result.value.error === null);
/**
 * 仅在整文件解析成功后执行连续性检查；文件不合格时为 null，
 * 页面据此显示"未执行"，不会把已保留的前置帧误报为完整批次结论。
 */
const continuity = computed<ContinuityResult | null>(() => {
  const r = result.value;
  if (!r || r.error !== null) return null;
  return checkSequenceContinuity(r.frames);
});
/** 作为断点后帧的帧号集合，用于在帧表中标记 */
const gapAfterIndexes = computed(
  () => new Set((continuity.value?.gaps ?? []).map((g) => g.nextIndex)),
);
/**
 * 仅在整文件解析成功后归并告警片段；文件不合格时为 null，
 * 页面据此显示"未执行"，不会依据已保留的前置帧生成片段。
 */
const alarms = computed<AlarmResult | null>(() => {
  const r = result.value;
  if (!r || r.error !== null) return null;
  return mergeAlarmSegments(r.frames);
});
/** 点击片段表后定位到的片段；选择其他文件时清除 */
const selectedSegmentId = ref<string | null>(null);
const selectedSegment = computed(() => {
  const id = selectedSegmentId.value;
  if (id === null || !alarms.value) return null;
  // 新批次的片段 id 重新生成，旧 id 匹配不上即视为无定位
  return alarms.value.segments.find((s) => segmentId(s) === id) ?? null;
});
/** 当前定位片段覆盖的帧号集合，用于在帧表中高亮 */
const highlightedFrameIndexes = computed(() => {
  const seg = selectedSegment.value;
  if (!seg) return new Set<number>();
  const set = new Set<number>();
  for (let i = seg.startFrameIndex; i <= seg.endFrameIndex; i++) set.add(i);
  return set;
});

/** 片段在当前批次内的稳定标识：类型 + 起始帧号 */
function segmentId(s: { type: AlarmType; startFrameIndex: number }): string {
  return `${s.type}:${s.startFrameIndex}`;
}

function selectSegment(id: string): void {
  selectedSegmentId.value = selectedSegmentId.value === id ? null : id;
  if (selectedSegmentId.value === null) return;
  const seg = selectedSegment.value;
  if (!seg) return;
  requestAnimationFrame(() => {
    document
      .querySelector(`#frames tbody tr[data-frame-index="${seg.startFrameIndex}"]`)
      ?.scrollIntoView({ block: 'center' });
  });
}

function frameRowClass(f: { index: number }): Record<string, boolean> {
  return {
    'gap-after': gapAfterIndexes.value.has(f.index),
    'alarm-highlight': highlightedFrameIndexes.value.has(f.index),
  };
}

/**
 * 帧表校准温度实际使用的偏移：文件不合格时校准不作用于该批次
 * （与校准区的声明一致），保留帧的校准温度与原始温度相同。
 */
const frameTableOffsetTenths = computed(() =>
  error.value !== null ? 0 : calibrationTenths.value,
);

/**
 * 逐帧校准温度：原始值 + 偏移，按十分之一度整数相加，避免浮点漂移。
 * 仅用于展示与报告；原始字段、湿度、连续性与告警结论不受影响。
 */
function frameCalibratedC(f: ParsedFrame): string {
  return calibratedTemperatureC(f.temperatureRaw, frameTableOffsetTenths.value);
}

/** 应用校准偏移：校验通过立即刷新全部校准温度；失败保留上次有效结果 */
function applyCalibration(): void {
  // 坏文件禁止应用（按钮此时本不渲染，此处作防御）
  if (!canDownload.value) return;
  const parsed = parseCalibrationInput(calibrationInput.value);
  if (!parsed.ok || parsed.offsetTenths === null) {
    calibrationError.value = parsed.message;
    return;
  }
  calibrationError.value = null;
  calibrationTenths.value = parsed.offsetTenths;
  // 输入框规范化为固定一位小数，与生效值一致
  calibrationInput.value = formatTemperature(parsed.offsetTenths);
}

/** 重置：恢复零偏移并清除输入反馈 */
function resetCalibration(): void {
  calibrationTenths.value = 0;
  calibrationInput.value = '0.0';
  calibrationError.value = null;
}

/**
 * 读取令牌：每次选择文件递增。异步读取完成时若令牌已过期
 * （等待期间又选择了更新的文件），结果直接丢弃，保证页面
 * 始终只保留最后选择文件的结果，慢读取的旧批次不得覆盖新批次。
 */
let readToken = 0;

async function handleFile(file: File): Promise<void> {
  const token = ++readToken;
  // 选择瞬间即进入读取中状态：清空旧批次结果与旧读取错误，
  // 避免等待期间旧报告被当作新文件的结果展示或下载
  reading.value = true;
  readError.value = null;
  result.value = null;
  // 更换文件即清除上一批次的片段定位与帧区间高亮
  selectedSegmentId.value = null;
  // 校准偏移跨文件保留（继续使用当前偏移）；输入框重新同步为当前
  // 生效值——上一批次未应用的输入（含非法文本）不得残留到本批次，
  // 否则输入框会与当前生效偏移不一致；同时清除上一批次的输入校验反馈
  calibrationError.value = null;
  calibrationInput.value = formatTemperature(calibrationTenths.value);
  fileName.value = file.name;
  fileSize.value = file.size;
  try {
    // 纯浏览器内读取，不上传、不访问任何外部服务
    const buffer = await file.arrayBuffer();
    if (token !== readToken) return; // 已有更新的选择，丢弃过期结果
    result.value = parseFrames(new Uint8Array(buffer));
  } catch {
    if (token !== readToken) return;
    // 读取失败：旧结果已在选择时清空，此处明确标记本次失败，
    // 下载入口保持隐藏，旧批次结果不得被误用
    readError.value = `无法读取文件「${file.name}」（${file.size} 字节）：浏览器读取失败。本次选择未产生任何结果，请检查文件后重新选择。`;
  } finally {
    if (token === readToken) reading.value = false;
  }
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void handleFile(file);
  input.value = '';
}

function downloadJson(): void {
  if (!canDownload.value || !result.value || !fileName.value || !alarms.value) return;
  const report = buildReport(
    fileName.value,
    fileSize.value,
    result.value.frames,
    alarms.value,
    // 与页面一致：报告始终携带当前生效的校准说明与逐帧校准温度
    { offsetTenths: calibrationTenths.value },
  );
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName.value}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <main class="page">
    <header>
      <h1>冷库记录器帧校验器</h1>
      <p class="hint">
        每帧 12 字节：A5 5A 魔数 · 版本 01 · 标志位（高温/低温/低电量）·
        小端秒时间戳 · 小端温度原始值（÷10 得 °C）· 湿度 0-100 · 序号。
        文件仅在浏览器内解析，不会上传。
      </p>
    </header>

    <div
      id="drop-zone"
      class="drop-zone"
      :class="{ over: dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
      @click="fileInput?.click()"
    >
      <p v-if="reading" data-testid="reading">
        正在读取 <strong data-testid="file-name">{{ fileName }}</strong>
        （{{ fileSize }} 字节），请稍候……读取完成前不会展示或下载任何批次结果。
      </p>
      <p v-else-if="!fileName">将记录文件拖放到此处，或点击选择文件</p>
      <p v-else>
        当前文件：<strong data-testid="file-name">{{ fileName }}</strong>
        （{{ fileSize }} 字节）—— 拖放或点击可更换文件
      </p>
      <input
        ref="fileInput"
        data-testid="file-input"
        type="file"
        hidden
        @change="onPick"
      />
    </div>

    <section v-if="readError" class="error" role="alert">
      <h2>读取失败 —— 未能读取本次选择的文件，此前批次结果已作废</h2>
      <p data-testid="read-error" class="mono">{{ readError }}</p>
      <p>
        此前批次的任何结果与下载入口均已清除，不会被当作本次文件的结果。
      </p>
    </section>

    <section v-if="error" class="error" role="alert">
      <h2>解析失败 —— 整文件判定不合格，已禁止下载</h2>
      <p data-testid="error-detail" class="mono">
        第 {{ error.frameIndex }} 帧 · 字节偏移 {{ error.offset }} ·
        {{ ERROR_FIELD_LABELS[error.field] }}：{{ error.message }}
      </p>
      <p v-if="frames.length">
        已保留之前 {{ frames.length }} 个合法帧（见下表），但解析在出错字节处停止，
        其后数据一律不予采信。
      </p>
      <p v-else>第一个帧即损坏，没有可保留的合法帧。</p>
    </section>

    <section v-if="result" id="calibration" class="calibration">
      <h2>温度校准（复核用，不改写原始读数）</h2>
      <p v-if="error" data-testid="calibration-blocked" class="calibration-skipped">
        文件不合格，禁止应用校准偏移：解析已在首个非法字节停止，
        当前生效偏移 {{ calibrationOffsetC }} °C 不会作用于该批次，下载同样被禁止；
        重置入口仍然可用，可将跨文件保留的偏移恢复为零。
      </p>
      <p v-else class="hint">
        探头定期校准后会产生统一温度偏移。输入当前校准值（0.1 °C 步进，
        -10.0 至 +10.0 °C）并应用后，帧表将并列显示原始温度与校准温度；
        湿度、序号连续性与告警结论仍基于原始字段。更换文件后继续使用当前偏移，
        重置则恢复零偏移。
      </p>
      <p data-testid="calibration-current" class="calibration-current">
        当前生效偏移：{{ calibrationOffsetC }} °C
      </p>
      <div class="calibration-controls">
        <template v-if="!error">
          <label for="calibration-input">校准偏移（°C）</label>
          <input
            id="calibration-input"
            v-model="calibrationInput"
            data-testid="calibration-input"
            type="text"
            inputmode="decimal"
            placeholder="-10.0 ~ +10.0"
            @keydown.enter="applyCalibration"
          />
          <button id="calibration-apply" type="button" @click="applyCalibration">
            应用
          </button>
        </template>
        <button id="calibration-reset" type="button" @click="resetCalibration">
          重置
        </button>
      </div>
      <p
        v-if="calibrationError"
        data-testid="calibration-error"
        class="calibration-error"
      >
        {{ calibrationError }}
      </p>
    </section>

    <section v-if="result" id="continuity" class="continuity">
      <h2>序号连续性（0-255 循环）</h2>
      <p v-if="error" data-testid="continuity-skipped" class="continuity-skipped">
        文件不合格，未执行连续性检查：解析已在首个非法字节停止，
        已保留的帧仅为文件前缀，不能据此得出完整批次结论。
      </p>
      <template v-else-if="continuity">
        <p v-if="continuity.continuous" data-testid="continuity-ok" class="continuity-ok">
          未发现断点：全部相邻帧序号在 0-255 循环下连续（255 → 0 视为连续）。
        </p>
        <template v-else>
          <p data-testid="continuity-gaps" class="continuity-gaps">
            存在断点：共 {{ continuity.gaps.length }} 处，帧表中已标记对应后帧。
          </p>
          <table id="gaps">
            <thead>
              <tr>
                <th>前帧 #</th>
                <th>后帧 #</th>
                <th>前帧序号</th>
                <th>后帧序号</th>
                <th>期望序号</th>
                <th>后帧字节偏移</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in continuity.gaps" :key="g.nextIndex">
                <td>{{ g.prevIndex }}</td>
                <td>{{ g.nextIndex }}</td>
                <td>{{ g.prevSequence }}</td>
                <td>{{ g.nextSequence }}</td>
                <td>{{ g.expectedSequence }}</td>
                <td>{{ g.nextOffset }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </section>

    <section v-if="result" id="alarms" class="alarms">
      <h2>告警片段归并（高温 / 低温 / 低电量）</h2>
      <p v-if="error" data-testid="alarms-skipped" class="continuity-skipped">
        文件不合格，未分析告警片段：解析已在首个非法字节停止，
        不会依据已保留的合法帧前缀生成任何片段。
      </p>
      <template v-else-if="alarms">
        <p v-if="alarms.summary.totalSegments === 0" data-testid="alarms-empty" class="continuity-ok">
          未发现任何告警：高温、低温、低电量三类标志在全部帧均为假，没有持续告警区间。
        </p>
        <template v-else>
          <p data-testid="alarms-summary" class="continuity-gaps">
            共 {{ alarms.summary.totalSegments }} 段持续告警：
            高温 {{ alarms.summary.highTemp }} 段 ·
            低温 {{ alarms.summary.lowTemp }} 段 ·
            低电量 {{ alarms.summary.lowBattery }} 段。
            点击下表片段可定位并高亮对应帧区间，再次点击取消定位；更换文件后定位自动清除。
          </p>
          <table id="alarm-segments">
            <thead>
              <tr>
                <th>类型</th>
                <th>起始帧 #</th>
                <th>结束帧 #</th>
                <th>帧数</th>
                <th>起始字节偏移</th>
                <th>结束字节偏移</th>
                <th>起始时间戳（秒）</th>
                <th>结束时间戳（秒）</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in alarms.segments"
                :id="`alarm-segment-${segmentId(s)}`"
                :key="segmentId(s)"
                data-testid="alarm-row"
                :class="['alarm-row', `alarm-${s.type}`, { selected: selectedSegmentId === segmentId(s) }]"
                @click="selectSegment(segmentId(s))"
              >
                <td>{{ ALARM_LABELS[s.type] }}</td>
                <td>{{ s.startFrameIndex }}</td>
                <td>{{ s.endFrameIndex }}</td>
                <td>{{ s.frameCount }}</td>
                <td>{{ s.startOffset }}</td>
                <td>{{ s.endOffset }}</td>
                <td>{{ s.startTimestamp }}</td>
                <td>{{ s.endTimestamp }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </section>

    <template v-if="result && frames.length">
      <section>
        <h2>帧概览（{{ frames.length }} 帧）</h2>
        <table id="frames">
          <thead>
            <tr>
              <th>帧 #</th>
              <th>帧偏移</th>
              <th>魔数</th>
              <th>版本</th>
              <th>高温</th>
              <th>低温</th>
              <th>低电量</th>
              <th>时间戳（秒）</th>
              <th>原始温度（°C）</th>
              <th>校准温度（°C）</th>
              <th>湿度（%）</th>
              <th>序号</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="f in frames"
              :key="f.index"
              :data-frame-index="f.index"
              :class="frameRowClass(f)"
            >
              <td>
                {{ f.index }}
                <span
                  v-if="gapAfterIndexes.has(f.index)"
                  data-testid="gap-flag"
                  class="gap-flag"
                  >断点后帧</span
                >
              </td>
              <td>{{ f.offset }}</td>
              <td class="mono">{{ f.magic }}</td>
              <td>{{ f.version }}</td>
              <td>{{ f.flags.highTemp ? '是' : '否' }}</td>
              <td>{{ f.flags.lowTemp ? '是' : '否' }}</td>
              <td>{{ f.flags.lowBattery ? '是' : '否' }}</td>
              <td>{{ f.timestamp }}</td>
              <td>{{ f.temperatureC }}</td>
              <td class="calibrated-temp">{{ frameCalibratedC(f) }}</td>
              <td>{{ f.humidity }}</td>
              <td>{{ f.sequence }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>字段明细（按文件顺序，偏移为文件内绝对字节偏移）</h2>
        <table id="fields">
          <thead>
            <tr>
              <th>帧 #</th>
              <th>字段</th>
              <th>起始偏移</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="f in frames" :key="f.index">
              <tr v-for="field in f.fields" :key="field.offset">
                <td>{{ f.index }}</td>
                <td>{{ FIELD_LABELS[field.name] }}</td>
                <td>{{ field.offset }}</td>
                <td class="mono">{{ field.value }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>
    </template>

    <p v-if="result && canDownload && !frames.length" class="hint">
      文件长度为 0：没有任何帧。
    </p>

    <button v-if="canDownload" id="download" type="button" @click="downloadJson">
      下载 JSON
    </button>
  </main>
</template>
