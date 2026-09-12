<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  buildReport,
  parseFrames,
  type ErrorField,
  type FieldName,
  type ParseResult,
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

const fileName = ref<string | null>(null);
const fileSize = ref(0);
const result = ref<ParseResult | null>(null);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const error = computed(() => result.value?.error ?? null);
const frames = computed(() => result.value?.frames ?? []);
/** 完全合法（无任何错误）才允许下载 */
const canDownload = computed(() => result.value !== null && result.value.error === null);

async function handleFile(file: File): Promise<void> {
  // 纯浏览器内读取，不上传、不访问任何外部服务
  const buffer = await file.arrayBuffer();
  result.value = parseFrames(new Uint8Array(buffer));
  fileName.value = file.name;
  fileSize.value = file.size;
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
  if (!canDownload.value || !result.value || !fileName.value) return;
  const report = buildReport(fileName.value, fileSize.value, result.value.frames);
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
      <p v-if="!fileName">将记录文件拖放到此处，或点击选择文件</p>
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
              <th>温度（°C）</th>
              <th>湿度（%）</th>
              <th>序号</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in frames" :key="f.index">
              <td>{{ f.index }}</td>
              <td>{{ f.offset }}</td>
              <td class="mono">{{ f.magic }}</td>
              <td>{{ f.version }}</td>
              <td>{{ f.flags.highTemp ? '是' : '否' }}</td>
              <td>{{ f.flags.lowTemp ? '是' : '否' }}</td>
              <td>{{ f.flags.lowBattery ? '是' : '否' }}</td>
              <td>{{ f.timestamp }}</td>
              <td>{{ f.temperatureC }}</td>
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
