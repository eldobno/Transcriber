import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type JobStatus =
  | "inspecting"
  | "ready"
  | "queued"
  | "converting"
  | "transcribing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

type QueueJob = {
  id: string;
  sourcePath: string;
  fileName: string;
  format: string;
  size: string;
  durationSec: number;
  status: JobStatus;
  progress: number;
  message: string | null;
  outputFiles: string[];
  error: string | null;
  durationMs: number | null;
  speedFactor: number | null;
  conversionMs: number | null;
  diarizationMs: number | null;
  transcriptionMs: number | null;
  finalizationMs: number | null;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

type QueueSnapshot = {
  jobs: QueueJob[];
  running: boolean;
  totalDurationSec: number;
};

type AddJobsResult = {
  queue: QueueSnapshot;
  ignoredPaths: string[];
};

type TranscribeProgress = {
  progress: number;
  message: string;
  active: boolean;
  stage?: string;
};

type TranscribeMetrics = {
  progress: number;
  elapsedSec: number;
  speedFactor: number;
  etaSec: number;
};

type HistoryEntry = {
  id: string;
  sourcePath: string;
  fileName: string;
  mediaDurationSec: number;
  status: string;
  model: string;
  backend: string;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  processingDurationMs: number | null;
  speedFactor: number | null;
  outputFiles: string[];
  error: string | null;
};

type ModelScanResult = {
  transModels: string[];
  vadModels: string[];
};

type ModelDownloadProgress = {
  modelName: string;
  phase:
    | "starting"
    | "downloading"
    | "paused"
    | "completed"
    | "failed";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  error: string | null;
};

type ModelInfo = {
  name: string;
  label: string;
  size: string;
  note: string;
};

const MODEL_CATALOG: ModelInfo[] = [
  { name: "tiny", label: "Tiny", size: "77 MB", note: "Fastest multilingual model" },
  { name: "tiny-q5_1", label: "Tiny Q5", size: "32 MB", note: "Very small quantized model" },
  { name: "tiny-q8_0", label: "Tiny Q8", size: "44 MB", note: "Small quantized model" },
  { name: "tiny.en", label: "Tiny English", size: "78 MB", note: "Fast English-only model" },
  { name: "tiny.en-q5_1", label: "Tiny English Q5", size: "32 MB", note: "English-only quantized" },
  { name: "tiny.en-q8_0", label: "Tiny English Q8", size: "44 MB", note: "English-only quantized" },

  { name: "base", label: "Base", size: "148 MB", note: "Light multilingual model" },
  { name: "base-q5_1", label: "Base Q5", size: "60 MB", note: "Light quantized model" },
  { name: "base-q8_0", label: "Base Q8", size: "82 MB", note: "Light quantized model" },
  { name: "base.en", label: "Base English", size: "148 MB", note: "English-only" },
  { name: "base.en-q5_1", label: "Base English Q5", size: "60 MB", note: "English-only quantized" },
  { name: "base.en-q8_0", label: "Base English Q8", size: "82 MB", note: "English-only quantized" },

  { name: "small", label: "Small", size: "488 MB", note: "Good speed/quality balance" },
  { name: "small-q5_1", label: "Small Q5", size: "190 MB", note: "Efficient quantized model" },
  { name: "small-q8_0", label: "Small Q8", size: "264 MB", note: "Higher-quality quantized model" },
  { name: "small.en", label: "Small English", size: "488 MB", note: "English-only" },
  { name: "small.en-q5_1", label: "Small English Q5", size: "190 MB", note: "English-only quantized" },
  { name: "small.en-q8_0", label: "Small English Q8", size: "264 MB", note: "English-only quantized" },
  { name: "small.en-tdrz", label: "Small English TDRZ", size: "488 MB", note: "TinyDiarize-compatible English model" },

  { name: "medium", label: "Medium", size: "1.53 GB", note: "High multilingual quality" },
  { name: "medium-q5_0", label: "Medium Q5", size: "539 MB", note: "Efficient high-quality model" },
  { name: "medium-q8_0", label: "Medium Q8", size: "823 MB", note: "High-quality quantized model" },
  { name: "medium.en", label: "Medium English", size: "1.53 GB", note: "High-quality English-only" },
  { name: "medium.en-q5_0", label: "Medium English Q5", size: "539 MB", note: "English-only quantized" },
  { name: "medium.en-q8_0", label: "Medium English Q8", size: "823 MB", note: "English-only quantized" },

  { name: "large-v1", label: "Large v1", size: "3.09 GB", note: "Legacy large model" },
  { name: "large-v2", label: "Large v2", size: "3.09 GB", note: "Legacy large model" },
  { name: "large-v2-q5_0", label: "Large v2 Q5", size: "1.08 GB", note: "Quantized large v2" },
  { name: "large-v2-q8_0", label: "Large v2 Q8", size: "1.66 GB", note: "Quantized large v2" },

  { name: "large-v3", label: "Large v3", size: "3.10 GB", note: "Maximum transcription quality" },
  { name: "large-v3-q5_0", label: "Large v3 Q5", size: "1.08 GB", note: "Efficient large-v3" },
  { name: "large-v3-turbo", label: "Large v3 Turbo", size: "1.62 GB", note: "Recommended: excellent quality + speed" },
  { name: "large-v3-turbo-q5_0", label: "Large v3 Turbo Q5", size: "574 MB", note: "Fast, compact turbo model" },
  { name: "large-v3-turbo-q8_0", label: "Large v3 Turbo Q8", size: "874 MB", note: "High-quality compact turbo model" },
];

const DEFAULT_MODEL = "large-v3-turbo";

const LANGUAGE_OPTIONS = [
  ["auto", "Auto detect"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
] as const;

type WhisperSettings = Record<string, any>;
type AppView = "convert" | "history" | "settings";

type SpeakerDetectionStatus = {
  available: boolean;
  runtimeFound: boolean;
  segmentationModelFound: boolean;
  embeddingModelFound: boolean;
  missing: string[];
};

let settings: WhisperSettings | null = null;
let queue: QueueSnapshot = { jobs: [], running: false, totalDurationSec: 0 };
let historyEntries: HistoryEntry[] = [];
let activeProgress = 0;
let activeMessage = "";
let activeMetrics: TranscribeMetrics | null = null;
let activeView: AppView = "convert";
let selectedModel = DEFAULT_MODEL;
let installedModels = new Set<string>();
let modelDownload: ModelDownloadProgress | null = null;
let speakerDetectionStatus: SpeakerDetectionStatus | null = null;
let speakerDetectionStatusError: string | null = null;
let historyQuery = "";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main class="app-shell">
    <header class="app-header">
      <div class="brand-block">
        <div class="brand-mark">T</div>
        <div>
          <div class="brand-row">
            <h1>Transcriber</h1>
            <span class="local-badge">LOCAL</span>
          </div>
          <p>Fast private transcription, subtitles and speaker detection.</p>
        </div>
      </div>

      <nav class="tabs" aria-label="Main navigation">
        <button id="nav-convert" class="tab active" type="button">Convert</button>
        <button id="nav-history" class="tab" type="button">History</button>
        <button id="nav-settings" class="tab" type="button">Settings</button>
      </nav>
    </header>

    <section id="convert-view" class="view">
      <div class="quick-settings-grid">
        <label class="control-card">
          <span class="control-label">Model</span>
          <select id="model-select" class="control-select"></select>
          <span id="model-status" class="control-help"></span>
        </label>

        <label class="control-card">
          <span class="control-label">Language</span>
          <select id="language-select" class="control-select"></select>
          <span class="control-help">Auto works well for mixed queues.</span>
        </label>

        <div class="control-card">
          <div class="switch-row">
            <div>
              <span class="control-label">Speaker Detection</span>
              <span class="beta-badge">BETA</span>
            </div>
            <label class="switch">
              <input id="speaker-detection" type="checkbox">
              <span class="switch-track"></span>
            </label>
          </div>
          <span id="speaker-status" class="control-help"></span>
        </div>
      </div>

      <section id="drop-zone" class="drop-zone" role="button" tabindex="0" aria-label="Add audio or video files">
        <div class="drop-icon">＋</div>
        <div class="drop-copy">
          <strong>Drop files or folders here</strong>
          <span>Audio and video are detected automatically. Folders are scanned recursively.</span>
        </div>
        <button id="browse-files" class="button secondary" type="button">Browse files</button>
      </section>

      <div class="action-bar">
        <div class="action-group">
          <button id="add-files" class="button secondary" type="button">Add Files</button>
          <button id="add-folder" class="button secondary" type="button">Add Folder</button>
        </div>
        <div class="action-group">
          <button id="clear-queue" class="button ghost" type="button">Clear</button>
          <button id="start-queue" class="button primary" type="button" disabled>Start Queue</button>
        </div>
      </div>

      <div class="policy-note">
        <span class="status-dot"></span>
        <span><strong>Automatic V1 output:</strong> audio → TXT · video → subtitled MKV · speaker labels only when 2+ speakers are detected.</span>
      </div>

      <div id="queue-summary"></div>
      <div id="jobs" class="stack"></div>
    </section>

    <section id="history-view" class="view" hidden>
      <div class="section-toolbar">
        <div>
          <h2>History</h2>
          <p>Recent completed, cancelled and failed jobs.</p>
        </div>
        <div class="toolbar-actions">
          <button id="refresh-history" class="button secondary" type="button">Refresh</button>
          <button id="clear-history" class="button ghost danger" type="button">Clear History</button>
        </div>
      </div>

      <label class="search-box">
        <span>⌕</span>
        <input id="history-search" type="search" placeholder="Search filenames, paths or outputs">
      </label>

      <div id="history-summary"></div>
      <div id="history-list" class="stack"></div>
    </section>

    <section id="settings-view" class="view" hidden>
      <div class="section-toolbar">
        <div>
          <h2>Settings</h2>
          <p>Keep the common choices simple. Advanced transcription tuning stays automatic for V1.</p>
        </div>
      </div>

      <div class="settings-grid">
        <section class="settings-card">
          <div class="settings-card-heading">
            <div>
              <h3>Transcription</h3>
              <p>Default model, backend and spoken language.</p>
            </div>
          </div>

          <label class="field">
            <span>Model</span>
            <select id="settings-model-select"></select>
          </label>
          <div id="settings-model-status" class="field-help"></div>
          <button id="settings-download-model" class="button secondary compact" type="button">Download Model</button>

          <label class="field">
            <span>Backend</span>
            <select id="backend-select">
              <option value="CUDA">NVIDIA CUDA</option>
              <option value="Standard">CPU</option>
            </select>
          </label>
          <div class="field-help">CUDA is recommended on NVIDIA systems. Speaker Detection falls back to CPU if its CUDA runtime cannot start.</div>

          <label class="field">
            <span>Default language</span>
            <select id="settings-language-select"></select>
          </label>
        </section>

        <section class="settings-card">
          <div class="settings-card-heading">
            <div>
              <h3>Speaker Detection</h3>
              <p>Native speakrs PLDA + VBx diarization.</p>
            </div>
            <label class="switch">
              <input id="settings-speaker-detection" type="checkbox">
              <span class="switch-track"></span>
            </label>
          </div>
          <div id="settings-speaker-status" class="field-help"></div>
          <div class="settings-fact"><span>Speaker count</span><strong>Auto</strong></div>
          <div class="settings-fact"><span>Single-speaker files</span><strong>No labels</strong></div>
          <div class="settings-fact"><span>Multi-speaker files</span><strong>Speaker 1 / Speaker 2 / …</strong></div>
        </section>

        <section class="settings-card">
          <div class="settings-card-heading">
            <div>
              <h3>Output</h3>
              <p>Choose where finished files are written.</p>
            </div>
          </div>

          <label class="field">
            <span>Save outputs</span>
            <select id="output-mode-select">
              <option value="input_dir">Next to the source file</option>
              <option value="custom">Custom folder</option>
            </select>
          </label>

          <div id="custom-output-row" class="output-path-row">
            <input id="output-path" type="text" readonly placeholder="Choose a folder">
            <button id="choose-output-folder" class="button secondary compact" type="button">Choose</button>
          </div>
          <div id="output-status" class="field-help">Audio exports as TXT. Video exports as a soft-subtitle MKV without re-encoding.</div>
        </section>

        <section class="settings-card">
          <div class="settings-card-heading">
            <div>
              <h3>App</h3>
              <p>Appearance and queue behaviour.</p>
            </div>
          </div>

          <label class="field">
            <span>Theme</span>
            <select id="theme-select">
              <option value="carbon">Carbon</option>
              <option value="royal-blue">Royal Blue</option>
              <option value="emerald">Emerald</option>
              <option value="fire-orange">Fire Orange</option>
            </select>
          </label>

          <div class="settings-fact"><span>Keep PC awake while queue runs</span><strong>Enabled</strong></div>
          <div class="settings-fact"><span>Queue completion notification</span><strong>Enabled</strong></div>
          <div class="settings-fact"><span>Processing</span><strong>Local only</strong></div>
        </section>
      </div>
    </section>

    <div id="toast" class="toast" hidden></div>
  </main>
`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

const convertView = $("#convert-view") as HTMLElement;
const historyView = $("#history-view") as HTMLElement;
const settingsView = $("#settings-view") as HTMLElement;
const convertNav = $("#nav-convert") as HTMLButtonElement;
const historyNav = $("#nav-history") as HTMLButtonElement;
const settingsNav = $("#nav-settings") as HTMLButtonElement;
const queueSummary = $("#queue-summary") as HTMLDivElement;
const jobsContainer = $("#jobs") as HTMLDivElement;
const historySummary = $("#history-summary") as HTMLDivElement;
const historyContainer = $("#history-list") as HTMLDivElement;
const addButton = $("#add-files") as HTMLButtonElement;
const browseFilesButton = $("#browse-files") as HTMLButtonElement;
const addFolderButton = $("#add-folder") as HTMLButtonElement;
const dropZone = $("#drop-zone") as HTMLDivElement;
const toast = $("#toast") as HTMLDivElement;
const startButton = $("#start-queue") as HTMLButtonElement;
const clearQueueButton = $("#clear-queue") as HTMLButtonElement;
const modelSelect = $("#model-select") as HTMLSelectElement;
const settingsModelSelect = $("#settings-model-select") as HTMLSelectElement;
const settingsDownloadModelButton = $("#settings-download-model") as HTMLButtonElement;
const modelStatus = $("#model-status") as HTMLSpanElement;
const settingsModelStatus = $("#settings-model-status") as HTMLDivElement;
const languageSelect = $("#language-select") as HTMLSelectElement;
const settingsLanguageSelect = $("#settings-language-select") as HTMLSelectElement;
const speakerDetectionCheckbox = $("#speaker-detection") as HTMLInputElement;
const settingsSpeakerDetectionCheckbox = $("#settings-speaker-detection") as HTMLInputElement;
const speakerStatus = $("#speaker-status") as HTMLSpanElement;
const settingsSpeakerStatus = $("#settings-speaker-status") as HTMLDivElement;
const refreshHistoryButton = $("#refresh-history") as HTMLButtonElement;
const clearHistoryButton = $("#clear-history") as HTMLButtonElement;
const historySearch = $("#history-search") as HTMLInputElement;
const backendSelect = $("#backend-select") as HTMLSelectElement;
const outputModeSelect = $("#output-mode-select") as HTMLSelectElement;
const customOutputRow = $("#custom-output-row") as HTMLDivElement;
const outputPathInput = $("#output-path") as HTMLInputElement;
const chooseOutputFolderButton = $("#choose-output-folder") as HTMLButtonElement;
const outputStatus = $("#output-status") as HTMLDivElement;
const themeSelect = $("#theme-select") as HTMLSelectElement;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatDurationMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatDate(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleString();
}

function normalizeModelName(value: string): string {
  let name = value.trim().toLowerCase().replace(/\\/g, "/").split("/").pop() ?? value;
  if (name.startsWith("ggml-")) name = name.slice(5);
  if (name.endsWith(".bin")) name = name.slice(0, -4);
  return name;
}

function modelFileName(name: string): string {
  return `ggml-${name}.bin`;
}

function selectedModelInfo(): ModelInfo {
  return MODEL_CATALOG.find((model) => model.name === selectedModel)
    ?? MODEL_CATALOG.find((model) => model.name === DEFAULT_MODEL)!;
}

function renderLanguageOptions() {
  const html = LANGUAGE_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  languageSelect.innerHTML = html;
  settingsLanguageSelect.innerHTML = html;
  const language = String(settings?.language ?? "auto");
  languageSelect.value = LANGUAGE_OPTIONS.some(([value]) => value === language) ? language : "auto";
  settingsLanguageSelect.value = languageSelect.value;
}

function renderModelOptions() {
  const html = MODEL_CATALOG.map((model) => {
    const installed = installedModels.has(model.name) ? " ✓" : "";
    const recommended = model.name === DEFAULT_MODEL ? " · Recommended" : "";
    return `<option value="${escapeHtml(model.name)}">${escapeHtml(model.label)} · ${escapeHtml(model.size)}${recommended}${installed}</option>`;
  }).join("");
  modelSelect.innerHTML = html;
  settingsModelSelect.innerHTML = html;
  modelSelect.value = selectedModel;
  settingsModelSelect.value = selectedModel;
}

function renderModelStatus() {
  const info = selectedModelInfo();
  const installed = installedModels.has(selectedModel);
  const downloading = modelDownload?.modelName === selectedModel
    && ["starting", "downloading", "paused"].includes(modelDownload.phase);

  let text = `${info.label} · ${info.size}`;
  let buttonText = installed ? "Installed" : "Download Model";
  let buttonDisabled = installed || queue.running;

  if (downloading && modelDownload) {
    const percent = Math.round(modelDownload.progress * 100);
    text = `${info.label} · Downloading ${percent}%`;
    buttonText = "Downloading…";
    buttonDisabled = true;
  } else if (modelDownload?.modelName === selectedModel && modelDownload.phase === "failed") {
    text = `Download failed · ${modelDownload.error ?? "Unknown error"}`;
    buttonText = "Retry Download";
    buttonDisabled = false;
  } else if (installed) {
    text += selectedModel === DEFAULT_MODEL ? " · Installed · Recommended" : " · Installed";
  } else {
    text += " · Not installed";
  }

  modelStatus.textContent = text;
  settingsModelStatus.textContent = `${text}. ${info.note}`;
  settingsDownloadModelButton.textContent = buttonText;
  settingsDownloadModelButton.disabled = buttonDisabled;
  modelSelect.disabled = queue.running || downloading;
  settingsModelSelect.disabled = queue.running || downloading;
}

function speakerStatusText(): string {
  if (!settings?.speakerDetection) return "Off · enable for multi-speaker transcripts.";
  if (speakerDetectionStatusError) return `Status unavailable · ${speakerDetectionStatusError}`;
  if (!speakerDetectionStatus) return "Checking local speaker runtime…";
  if (speakerDetectionStatus.available) {
    return speakerDetectionStatus.missing.length > 0
      ? "Ready · models download automatically on first use."
      : "Ready · automatic speaker count.";
  }
  return `Unavailable · missing ${speakerDetectionStatus.missing.join(", ")}`;
}

function renderSpeakerDetectionStatus() {
  if (!settings) return;
  const enabled = Boolean(settings.speakerDetection);
  speakerDetectionCheckbox.checked = enabled;
  settingsSpeakerDetectionCheckbox.checked = enabled;
  speakerDetectionCheckbox.disabled = queue.running;
  settingsSpeakerDetectionCheckbox.disabled = queue.running;
  const text = speakerStatusText();
  speakerStatus.textContent = text;
  settingsSpeakerStatus.textContent = text;
}

function applyTheme() {
  const theme = String(settings?.theme ?? "carbon");
  document.documentElement.dataset.theme = theme;
  themeSelect.value = ["carbon", "royal-blue", "emerald", "fire-orange"].includes(theme)
    ? theme
    : "carbon";
}

function renderSettings() {
  if (!settings) return;
  backendSelect.value = settings.selectedBackend === "Standard" ? "Standard" : "CUDA";
  outputModeSelect.value = settings.outputDirMode === "custom" ? "custom" : "input_dir";
  outputPathInput.value = String(settings.outputDirPath ?? "");
  customOutputRow.hidden = outputModeSelect.value !== "custom";
  outputStatus.textContent = outputModeSelect.value === "custom"
    ? (outputPathInput.value ? `Outputs will be written to ${outputPathInput.value}` : "Choose a writable output folder.")
    : "Outputs are written next to each source file.";
  renderLanguageOptions();
  renderModelOptions();
  renderModelStatus();
  renderSpeakerDetectionStatus();
  applyTheme();
}

async function persistSettings() {
  if (!settings) return;
  await invoke("save_settings", { settings });
}

async function refreshSpeakerDetectionStatus() {
  if (!settings) return;
  try {
    speakerDetectionStatus = await invoke<SpeakerDetectionStatus>("get_speaker_detection_status", {
      modelsDir: settings.modelsDir,
    });
    speakerDetectionStatusError = null;
  } catch (error) {
    speakerDetectionStatus = null;
    speakerDetectionStatusError = String(error);
  }
  renderSpeakerDetectionStatus();
}

async function refreshInstalledModels() {
  if (!settings) return;
  const scan = await invoke<ModelScanResult>("scan_models", {
    modelsDir: settings.modelsDir,
    backend: settings.selectedBackend === "Standard" ? "Standard" : "CUDA",
  });
  installedModels = new Set(scan.transModels.map(normalizeModelName));
  renderModelOptions();
  renderModelStatus();
}

async function applySelectedModel(name: string) {
  if (!settings) return;
  selectedModel = name;
  settings.modelPath = modelFileName(selectedModel);
  modelDownload = null;
  await persistSettings();
  renderModelOptions();
  renderModelStatus();
  renderQueue();
}

async function applyLanguage(language: string) {
  if (!settings) return;
  settings.language = language;
  await persistSettings();
  renderLanguageOptions();
}

async function setSpeakerDetection(enabled: boolean) {
  if (!settings) return;
  settings.speakerDetection = enabled;
  settings.speakerCount = 0;
  await persistSettings();
  await refreshSpeakerDetectionStatus();
  renderQueue();
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    inspecting: "Inspecting",
    ready: "Ready",
    queued: "Queued",
    converting: "Converting",
    transcribing: "Transcribing",
    finalizing: "Finalizing",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    running: "Running",
  };
  return labels[status] ?? status;
}

function statusClass(status: string): string {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled" || status === "interrupted") return "muted";
  if (["converting", "transcribing", "finalizing"].includes(status)) return "active";
  return "neutral";
}

function isPending(job: QueueJob): boolean {
  return ["inspecting", "ready", "queued"].includes(job.status);
}

function isActive(job: QueueJob): boolean {
  return ["converting", "transcribing", "finalizing"].includes(job.status);
}

function canMove(job: QueueJob): boolean {
  return job.status === "ready" || job.status === "queued";
}

function canCancel(job: QueueJob): boolean {
  return isPending(job) || isActive(job);
}

function referenceSpeed(): number {
  const speeds = queue.jobs
    .filter((job) => job.status === "completed" && job.speedFactor && job.speedFactor > 0 && job.durationSec >= 5)
    .map((job) => job.speedFactor as number);
  return speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0;
}

function estimatedJobSeconds(job: QueueJob, speed: number): number | null {
  if (["completed", "failed", "cancelled"].includes(job.status)) return 0;
  if (["converting", "transcribing"].includes(job.status) && activeMetrics) {
    return Math.max(0, activeMetrics.etaSec);
  }
  return speed > 0 && job.durationSec > 0 ? job.durationSec / speed : null;
}

function queueEtaSeconds(): number | null {
  const speed = referenceSpeed();
  let total = 0;
  let hasEstimate = false;
  for (const job of queue.jobs) {
    const estimate = estimatedJobSeconds(job, speed);
    if (estimate !== null) {
      total += estimate;
      if (!["completed", "failed", "cancelled"].includes(job.status)) hasEstimate = true;
    }
  }
  return hasEstimate ? total : 0;
}

function renderQueue() {
  const completed = queue.jobs.filter((job) => job.status === "completed").length;
  const failed = queue.jobs.filter((job) => job.status === "failed").length;
  const cancelled = queue.jobs.filter((job) => job.status === "cancelled").length;
  const speed = referenceSpeed();
  const eta = queueEtaSeconds();

  queueSummary.innerHTML = queue.jobs.length === 0 ? "" : `
    <section class="summary-card">
      <div class="summary-primary">
        <span class="summary-state ${queue.running ? "running" : "idle"}">${queue.running ? "Queue running" : "Queue ready"}</span>
        <strong>${queue.jobs.length} ${queue.jobs.length === 1 ? "file" : "files"}</strong>
        <span>${formatDuration(queue.totalDurationSec)} media</span>
      </div>
      <div class="summary-stats">
        <span>${completed} done</span>
        ${failed ? `<span class="text-error">${failed} failed</span>` : ""}
        ${cancelled ? `<span>${cancelled} cancelled</span>` : ""}
        ${queue.running ? `<span>${speed > 0 ? `${speed.toFixed(2)}× realtime` : "measuring speed"}</span><span>${eta !== null ? `${formatDuration(eta)} remaining` : "measuring ETA"}</span>` : ""}
      </div>
    </section>`;

  if (queue.jobs.length === 0) {
    jobsContainer.innerHTML = `<div class="empty-state"><strong>Your queue is empty.</strong><span>Drop media above or add a folder to start.</span></div>`;
  } else {
    jobsContainer.innerHTML = queue.jobs.map((job, index) => {
      const active = isActive(job);
      const progress = active && job.status === "transcribing"
        ? Math.round(activeProgress * 100)
        : job.status === "completed" ? 100 : active ? 8 : 0;
      const detailMessage = activeMessage && active ? activeMessage : job.message ?? "";
      const estimate = estimatedJobSeconds(job, referenceSpeed());
      const timingText = job.status === "transcribing" && activeMetrics
        ? `Whisper ${activeMetrics.speedFactor.toFixed(2)}× · ${formatDuration(activeMetrics.etaSec)} remaining`
        : job.status === "queued" && estimate !== null
          ? `~${formatDuration(estimate)} estimated`
          : job.status === "completed" && job.speedFactor
            ? `${formatDurationMs(job.durationMs)} · ${job.speedFactor.toFixed(2)}× realtime`
            : "";
      const stageTiming = job.status === "completed"
        ? [
            job.conversionMs !== null ? `Convert ${formatDurationMs(job.conversionMs)}` : null,
            job.diarizationMs !== null ? `Speakers ${formatDurationMs(job.diarizationMs)}` : null,
            job.transcriptionMs !== null ? `Whisper ${formatDurationMs(job.transcriptionMs)}` : null,
            job.finalizationMs !== null ? `Finalize ${formatDurationMs(job.finalizationMs)}` : null,
          ].filter((value): value is string => value !== null).join(" · ")
        : "";
      const outputs = job.outputFiles.length
        ? `<div class="output-list">${job.outputFiles.map((file) => `<span>${escapeHtml(file)}</span>`).join("")}</div>`
        : "";
      const error = job.error ? `<div class="error-box">${escapeHtml(job.error)}</div>` : "";

      return `
        <article class="job-card ${active ? "is-active" : ""}">
          <div class="job-index">${index + 1}</div>
          <div class="job-main">
            <div class="job-title-row">
              <strong class="job-title">${escapeHtml(job.fileName)}</strong>
              <span class="status-chip ${statusClass(job.status)}">${statusLabel(job.status)}</span>
            </div>
            <div class="job-meta">${escapeHtml(job.format || "Media")} ${job.size ? `· ${escapeHtml(job.size)}` : ""} ${job.durationSec > 0 ? `· ${formatDuration(job.durationSec)}` : ""}</div>
            ${timingText || detailMessage ? `<div class="job-detail">${escapeHtml([timingText, detailMessage].filter(Boolean).join(" · "))}</div>` : ""}
            ${stageTiming ? `<div class="stage-timing">${escapeHtml(stageTiming)}</div>` : ""}
            ${active ? `<div class="progress-track"><span style="width:${Math.max(3, progress)}%"></span></div>` : ""}
            ${outputs}
            ${error}
          </div>
          <div class="job-actions">
            <button class="icon-button" data-action="up" data-job-id="${escapeHtml(job.id)}" ${!canMove(job) || index === 0 ? "disabled" : ""} title="Move up">↑</button>
            <button class="icon-button" data-action="down" data-job-id="${escapeHtml(job.id)}" ${!canMove(job) || index === queue.jobs.length - 1 ? "disabled" : ""} title="Move down">↓</button>
            <button class="button ghost compact" data-action="cancel" data-job-id="${escapeHtml(job.id)}" ${!canCancel(job) ? "disabled" : ""}>${active ? "Cancel" : "Remove"}</button>
          </div>
        </article>`;
    }).join("");
  }

  const hasRunnableJobs = queue.jobs.some((job) => job.status === "ready" || job.status === "queued");
  startButton.disabled = queue.running || !hasRunnableJobs || !installedModels.has(selectedModel);
  addButton.disabled = queue.running;
  browseFilesButton.disabled = queue.running;
  addFolderButton.disabled = queue.running;
  clearQueueButton.disabled = queue.running || queue.jobs.length === 0;
  dropZone.classList.toggle("disabled", queue.running);
  renderModelStatus();
  renderSpeakerDetectionStatus();
}

function filteredHistory(): HistoryEntry[] {
  const needle = historyQuery.trim().toLowerCase();
  if (!needle) return historyEntries;
  return historyEntries.filter((entry) => [
    entry.fileName,
    entry.sourcePath,
    entry.model,
    entry.backend,
    ...entry.outputFiles,
  ].some((value) => value.toLowerCase().includes(needle)));
}

function renderHistory() {
  const filtered = filteredHistory();
  const completed = historyEntries.filter((entry) => entry.status === "completed").length;
  const failed = historyEntries.filter((entry) => entry.status === "failed").length;

  historySummary.innerHTML = `
    <section class="summary-card">
      <div class="summary-primary"><strong>${historyEntries.length} records</strong><span>${completed} completed</span>${failed ? `<span class="text-error">${failed} failed</span>` : ""}</div>
      ${historyQuery ? `<div class="summary-stats"><span>${filtered.length} matching search</span></div>` : ""}
    </section>`;

  if (filtered.length === 0) {
    historyContainer.innerHTML = `<div class="empty-state"><strong>${historyEntries.length ? "No matching history." : "No history yet."}</strong><span>${historyEntries.length ? "Try a different search." : "Finished jobs will appear here."}</span></div>`;
    return;
  }

  historyContainer.innerHTML = filtered.map((entry) => {
    const outputs = entry.outputFiles.length
      ? `<div class="history-outputs"><span>Outputs</span>${entry.outputFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>`
      : "";
    const error = entry.error ? `<div class="error-box">${escapeHtml(entry.error)}</div>` : "";
    return `
      <article class="history-card">
        <div class="history-main">
          <div class="job-title-row">
            <strong class="job-title">${escapeHtml(entry.fileName)}</strong>
            <span class="status-chip ${statusClass(entry.status)}">${statusLabel(entry.status)}</span>
          </div>
          <div class="history-performance">
            ${entry.speedFactor !== null ? `<strong>${entry.speedFactor.toFixed(2)}× realtime</strong>` : ""}
            ${entry.processingDurationMs !== null ? `<span>${formatDurationMs(entry.processingDurationMs)}</span>` : ""}
            <span>${formatDuration(entry.mediaDurationSec)} media</span>
          </div>
          <div class="job-meta">${escapeHtml(entry.backend || "—")} · ${escapeHtml(entry.model || "—")}</div>
          <div class="path-text">${escapeHtml(entry.sourcePath)}</div>
          <details class="history-details">
            <summary>Details</summary>
            <div>Created ${formatDate(entry.createdAtMs)}</div>
            <div>Started ${formatDate(entry.startedAtMs)}</div>
            <div>Finished ${formatDate(entry.completedAtMs)}</div>
          </details>
          ${outputs}
          ${error}
        </div>
        <button class="button ghost compact danger" data-delete-history-id="${escapeHtml(entry.id)}">Delete</button>
      </article>`;
  }).join("");
}

let toastTimer: number | null = null;
function showToast(message: string) {
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
    toastTimer = null;
  }, 3200);
}

async function addPathsToQueue(paths: string[]) {
  if (!paths.length) return;
  try {
    const result = await invoke<AddJobsResult>("add_job_queue_files", { paths });
    queue = result.queue;
    renderQueue();
    if (result.ignoredPaths.length) {
      const count = result.ignoredPaths.length;
      showToast(`${count} unsupported ${count === 1 ? "item" : "items"} skipped.`);
    }
  } catch (error) {
    showToast(`Adding files failed: ${String(error)}`);
  }
}

async function refreshQueue() {
  queue = await invoke<QueueSnapshot>("get_job_queue");
  renderQueue();
}

async function loadHistory() {
  try {
    historyEntries = await invoke<HistoryEntry[]>("get_history_entries", { limit: 100, offset: 0 });
    renderHistory();
  } catch (error) {
    historySummary.innerHTML = `<div class="error-box">History load failed: ${escapeHtml(String(error))}</div>`;
  }
}

async function showView(view: AppView) {
  activeView = view;
  convertView.hidden = view !== "convert";
  historyView.hidden = view !== "history";
  settingsView.hidden = view !== "settings";
  convertNav.classList.toggle("active", view === "convert");
  historyNav.classList.toggle("active", view === "history");
  settingsNav.classList.toggle("active", view === "settings");
  if (view === "history") await loadHistory();
  if (view === "settings") renderSettings();
}

async function startModelDownload() {
  if (!settings || installedModels.has(selectedModel)) return;
  try {
    modelDownload = {
      modelName: selectedModel,
      phase: "starting",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      error: null,
    };
    renderModelStatus();
    await invoke("start_download_model_task", {
      modelsDir: settings.modelsDir,
      modelName: selectedModel,
    });
  } catch (error) {
    modelDownload = {
      modelName: selectedModel,
      phase: "failed",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      error: String(error),
    };
    renderModelStatus();
  }
}

async function initialize() {
  const loadedSettings = await invoke<WhisperSettings>("load_settings");
  settings = loadedSettings;
  const savedModel = normalizeModelName(String(loadedSettings.modelPath ?? ""));
  selectedModel = MODEL_CATALOG.some((model) => model.name === savedModel) ? savedModel : DEFAULT_MODEL;

  // Keep the backend's V1 output policy automatic, but preserve genuine user
  // choices (language, output folder, theme, backend and Speaker Detection).
  loadedSettings.modelPath = modelFileName(selectedModel);
  loadedSettings.speakerDetection = Boolean(loadedSettings.speakerDetection ?? false);
  loadedSettings.speakerCount = 0;
  loadedSettings.language = String(loadedSettings.language || "auto");
  loadedSettings.outputDirMode = loadedSettings.outputDirMode === "custom" ? "custom" : "input_dir";
  loadedSettings.outputDirPath = String(loadedSettings.outputDirPath ?? "");
  loadedSettings.selectedBackend = loadedSettings.selectedBackend === "Standard" ? "Standard" : "CUDA";
  loadedSettings.theme = ["carbon", "royal-blue", "emerald", "fire-orange"].includes(String(loadedSettings.theme))
    ? loadedSettings.theme
    : "carbon";
  loadedSettings.ffmpegSource = "bundled";

  await persistSettings();
  renderLanguageOptions();
  applyTheme();
  await refreshInstalledModels();
  await refreshSpeakerDetectionStatus();
  await refreshQueue();
  renderSettings();
}

await listen<ModelDownloadProgress>("model-download-status", async (event) => {
  modelDownload = event.payload;
  if (event.payload.phase === "completed") {
    await refreshInstalledModels();
    modelDownload = null;
  }
  renderModelStatus();
});

await listen<QueueSnapshot>("job-queue-updated", async (event) => {
  queue = event.payload;
  if (!queue.jobs.some(isActive)) {
    activeProgress = 0;
    activeMessage = "";
    activeMetrics = null;
  }
  renderQueue();
  if (activeView === "history") await loadHistory();
});

await listen<TranscribeMetrics>("transcribe-metrics", (event) => {
  activeMetrics = event.payload;
  activeProgress = event.payload.progress;
  renderQueue();
});

await listen<TranscribeProgress>("transcribe-status", (event) => {
  activeProgress = event.payload.progress ?? 0;
  activeMessage = event.payload.message ?? "";
  if (event.payload.stage !== "transcribing") activeMetrics = null;
  renderQueue();
});

convertNav.addEventListener("click", () => void showView("convert"));
historyNav.addEventListener("click", () => void showView("history"));
settingsNav.addEventListener("click", () => void showView("settings"));

modelSelect.addEventListener("change", () => void applySelectedModel(modelSelect.value));
settingsModelSelect.addEventListener("change", () => void applySelectedModel(settingsModelSelect.value));
languageSelect.addEventListener("change", () => void applyLanguage(languageSelect.value));
settingsLanguageSelect.addEventListener("change", () => void applyLanguage(settingsLanguageSelect.value));
speakerDetectionCheckbox.addEventListener("change", () => void setSpeakerDetection(speakerDetectionCheckbox.checked));
settingsSpeakerDetectionCheckbox.addEventListener("change", () => void setSpeakerDetection(settingsSpeakerDetectionCheckbox.checked));
settingsDownloadModelButton.addEventListener("click", () => void startModelDownload());

backendSelect.addEventListener("change", async () => {
  if (!settings) return;
  settings.selectedBackend = backendSelect.value;
  await persistSettings();
  await refreshInstalledModels();
  await refreshSpeakerDetectionStatus();
  renderQueue();
  showToast(backendSelect.value === "CUDA" ? "CUDA backend selected." : "CPU backend selected.");
});

outputModeSelect.addEventListener("change", async () => {
  if (!settings) return;
  settings.outputDirMode = outputModeSelect.value;
  await persistSettings();
  renderSettings();
});

chooseOutputFolderButton.addEventListener("click", async () => {
  if (!settings) return;
  const path = await invoke<string | null>("select_directory");
  if (!path) return;
  try {
    await invoke("verify_directory_writable", { dirPath: path });
    settings.outputDirMode = "custom";
    settings.outputDirPath = path;
    await persistSettings();
    renderSettings();
    showToast("Output folder saved.");
  } catch (error) {
    showToast(`Cannot use that folder: ${String(error)}`);
  }
});

themeSelect.addEventListener("change", async () => {
  if (!settings) return;
  settings.theme = themeSelect.value;
  applyTheme();
  await persistSettings();
});

async function browseFiles() {
  const paths = await invoke<string[] | null>("select_files");
  if (paths) await addPathsToQueue(paths);
}

addButton.addEventListener("click", () => void browseFiles());
browseFilesButton.addEventListener("click", (event) => {
  event.stopPropagation();
  void browseFiles();
});
addFolderButton.addEventListener("click", async () => {
  const path = await invoke<string | null>("select_directory");
  if (path) await addPathsToQueue([path]);
});
dropZone.addEventListener("click", () => { if (!queue.running) void browseFiles(); });
dropZone.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !queue.running) {
    event.preventDefault();
    void browseFiles();
  }
});

await listen<boolean>("transcriber-native-drag-enter", (event) => {
  dropZone.classList.toggle("drag-active", event.payload && !queue.running);
});
await listen<string[]>("transcriber-native-file-drop", async (event) => {
  dropZone.classList.remove("drag-active");
  if (!queue.running) await addPathsToQueue(event.payload);
});

startButton.addEventListener("click", async () => {
  if (!settings) return;
  try {
    await invoke<QueueSnapshot>("start_job_queue", { settings });
  } catch (error) {
    showToast(`Queue failed: ${String(error)}`);
    await refreshQueue();
  }
});

clearQueueButton.addEventListener("click", async () => {
  try {
    queue = await invoke<QueueSnapshot>("clear_job_queue");
    activeProgress = 0;
    activeMessage = "";
    activeMetrics = null;
    renderQueue();
  } catch (error) {
    showToast(`Clear failed: ${String(error)}`);
  }
});

jobsContainer.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action][data-job-id]");
  if (!button) return;
  const action = button.dataset.action;
  const jobId = button.dataset.jobId;
  if (!action || !jobId) return;
  const index = queue.jobs.findIndex((job) => job.id === jobId);
  if (index < 0) return;
  button.disabled = true;
  try {
    if (action === "up" && index > 0) {
      queue = await invoke<QueueSnapshot>("move_queue_job", { jobId, newIndex: index - 1 });
    } else if (action === "down" && index < queue.jobs.length - 1) {
      queue = await invoke<QueueSnapshot>("move_queue_job", { jobId, newIndex: index + 1 });
    } else if (action === "cancel") {
      queue = await invoke<QueueSnapshot>("cancel_queue_job", { jobId });
    }
    renderQueue();
  } catch (error) {
    showToast(`${action} failed: ${String(error)}`);
    await refreshQueue();
  }
});

refreshHistoryButton.addEventListener("click", () => void loadHistory());
clearHistoryButton.addEventListener("click", async () => {
  if (historyEntries.length && !window.confirm("Clear all Transcriber history records? Output files will not be deleted.")) return;
  try {
    await invoke("clear_history");
    await loadHistory();
  } catch (error) {
    showToast(`Clear history failed: ${String(error)}`);
  }
});
historySearch.addEventListener("input", () => {
  historyQuery = historySearch.value;
  renderHistory();
});
historyContainer.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-delete-history-id]");
  if (!button) return;
  const id = button.dataset.deleteHistoryId;
  if (!id) return;
  button.disabled = true;
  try {
    await invoke<boolean>("delete_history_entry", { id });
    await loadHistory();
  } catch (error) {
    showToast(`Delete failed: ${String(error)}`);
  }
});

initialize().catch((error) => {
  queueSummary.innerHTML = `<div class="error-box">Initialization failed: ${escapeHtml(String(error))}</div>`;
});
