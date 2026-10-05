import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  speakerCount: number | null;
  speakerBackend: string | null;
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
  alreadyProcessedPaths: string[];
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
  phase: "starting" | "downloading" | "paused" | "completed" | "failed";
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

type SpeakerDetectionStatus = {
  available: boolean;
  runtimeFound: boolean;
  segmentationModelFound: boolean;
  embeddingModelFound: boolean;
  missing: string[];
};

type SystemSpecs = {
  total_ram_gb: number;
  cpu_cores: number;
  gpu_type: string;
  gpu_name: string;
  is_discrete_gpu: boolean;
};

type SpeakerWarmState = "idle" | "warming" | "ready" | "error";

type WhisperSettings = Record<string, any>;
type AppView = "convert" | "history" | "settings";

const MODEL_CATALOG: ModelInfo[] = [
  { name: "tiny", label: "Tiny", size: "77 MB", note: "Fastest multilingual model" },
  { name: "tiny-q5_1", label: "Tiny Q5", size: "32 MB", note: "Very small quantized model" },
  { name: "tiny-q8_0", label: "Tiny Q8", size: "44 MB", note: "Small quantized model" },
  { name: "tiny.en", label: "Tiny English", size: "78 MB", note: "Fast English-only model" },
  { name: "base", label: "Base", size: "148 MB", note: "Light multilingual model" },
  { name: "base-q5_1", label: "Base Q5", size: "60 MB", note: "Light quantized model" },
  { name: "base-q8_0", label: "Base Q8", size: "82 MB", note: "Light quantized model" },
  { name: "base.en", label: "Base English", size: "148 MB", note: "English-only" },
  { name: "small", label: "Small", size: "488 MB", note: "Good speed/quality balance" },
  { name: "small-q5_1", label: "Small Q5", size: "190 MB", note: "Efficient quantized model" },
  { name: "small-q8_0", label: "Small Q8", size: "264 MB", note: "Higher-quality quantized model" },
  { name: "small.en", label: "Small English", size: "488 MB", note: "English-only" },
  { name: "medium", label: "Medium", size: "1.53 GB", note: "High multilingual quality" },
  { name: "medium-q5_0", label: "Medium Q5", size: "539 MB", note: "Efficient high-quality model" },
  { name: "medium-q8_0", label: "Medium Q8", size: "823 MB", note: "High-quality quantized model" },
  { name: "medium.en", label: "Medium English", size: "1.53 GB", note: "High-quality English-only" },
  { name: "large-v1", label: "Large v1", size: "3.09 GB", note: "Legacy large model" },
  { name: "large-v2", label: "Large v2", size: "3.09 GB", note: "Legacy large model" },
  { name: "large-v2-q5_0", label: "Large v2 Q5", size: "1.08 GB", note: "Quantized large v2" },
  { name: "large-v2-q8_0", label: "Large v2 Q8", size: "1.66 GB", note: "Quantized large v2" },
  { name: "large-v3", label: "Large v3", size: "3.10 GB", note: "Maximum transcription quality" },
  { name: "large-v3-q5_0", label: "Large v3 Q5", size: "1.08 GB", note: "Efficient large-v3" },
  { name: "large-v3-turbo", label: "Large v3 Turbo", size: "1.62 GB", note: "Excellent quality and speed" },
  { name: "large-v3-turbo-q5_0", label: "Large v3 Turbo Q5", size: "574 MB", note: "Fast, compact turbo model" },
  { name: "large-v3-turbo-q8_0", label: "Large v3 Turbo Q8", size: "874 MB", note: "High-quality compact turbo model" },
];

const DEFAULT_MODEL = "large-v3-turbo";

const QUALITY_PRESETS = [
  { model: "large-v3-turbo", label: "Recommended", note: "Best default for most modern PCs" },
  { model: "small", label: "Fast", note: "Prioritizes speed" },
  { model: "medium", label: "Balanced", note: "More accuracy, moderate processing" },
  { model: "large-v3", label: "Accurate", note: "Maximum transcription quality" },
] as const;

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

let settings: WhisperSettings | null = null;
let queue: QueueSnapshot = { jobs: [], running: false, totalDurationSec: 0 };
let historyEntries: HistoryEntry[] = [];
let activeProgress = 0;
let activeJobId: string | null = null;
let activeMessage = "";
let activeMetrics: TranscribeMetrics | null = null;
let activeView: AppView = "convert";
let selectedModel = DEFAULT_MODEL;
let installedModels = new Set<string>();
let modelDownload: ModelDownloadProgress | null = null;
let speakerDetectionStatus: SpeakerDetectionStatus | null = null;
let speakerDetectionStatusError: string | null = null;
let historyQuery = "";
let lastDropSignature = "";
let lastDropAt = 0;
type QueuePointerDrag = {
  pointerId: number;
  jobId: string;
  originalIndex: number;
  targetIndex: number;
  startY: number;
  rowRects: Map<string, DOMRect>;
};

let queuePointerDrag: QueuePointerDrag | null = null;
let cancellingAll = false;
let speakerWarmPromise: Promise<void> | null = null;
let speakerWarmState: SpeakerWarmState = "idle";
let speakerWarmBackend = "";
let lastOverallProgress = 0;
let displayedOverallPercent = 0;
let progressPercentAnimation = 0;
const lastJobProgress = new Map<string, number>();
const videoThumbnailCache = new Map<string, string>();
const videoThumbnailPending = new Map<string, Promise<string>>();
let wasQueueRunning = false;
const NETWORK_ACTIVITY_KEY = "transcriber:last-network-activity";

const icons = {
  logo: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13v-2M8.5 16V8M12 19V5M15.5 16V8M19 13v-2"/></svg>`,
  convert: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 18.5h14"/></svg>`,
  history: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5A8.5 8.5 0 1 1 3.5 12"/><path d="M3.5 5.5v5h5"/><path d="M12 7.5V12l3 1.8"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.2 14.7a1.7 1.7 0 0 0 .34 1.87l.05.05-2.97 2.97-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05-2.97-2.97.05-.05a1.7 1.7 0 0 0 .34-1.87A1.7 1.7 0 0 0 2.6 13.84H2.5v-4h.1a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.05-.05 2.97-2.97.05.05a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1.03-1.56V2.7h4v.07a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05 2.97 2.97-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.03h.1v4h-.1a1.7 1.7 0 0 0-1.56 1.03Z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11Z"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5m0 0L8 9m4-4 4 4"/><path d="M4.5 15.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.8"/><path d="m15.3 15.3 4.2 4.2"/></svg>`,
  close: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8M10 2 2 10"/></svg>`,
  maximize: `<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7"/></svg>`,
  minimize: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5h8"/></svg>`,
  file: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M14 3.5v4h4"/></svg>`,
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`,
  grip: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M7 7l1 13h8l1-13"/></svg>`,
  chevronUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg>`,
  chevronDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`,
  open: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5h6v6M19 5l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`,
};

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="window-root">
    <header class="titlebar" data-tauri-drag-region>
      <div class="titlebar-brand" data-tauri-drag-region>
        <span class="app-logo"><img src="/src/assets/app-icon.png" alt="" /></span>
        <span class="app-name" data-tauri-drag-region>Transcriber</span>
      </div>
      <div class="titlebar-drag" data-tauri-drag-region></div>
      <div class="window-controls">
        <button id="window-minimize" class="window-button" type="button" aria-label="Minimize">${icons.minimize}</button>
        <button id="window-maximize" class="window-button" type="button" aria-label="Maximize">${icons.maximize}</button>
        <button id="window-close" class="window-button close" type="button" aria-label="Close">${icons.close}</button>
      </div>
    </header>

    <div class="app-shell">
      <aside class="sidebar" aria-label="Application navigation">
        <nav class="primary-nav">
          <button id="nav-convert" class="nav-button active" type="button"><span class="nav-icon">${icons.convert}</span><span class="nav-label">Convert</span></button>
          <button id="nav-history" class="nav-button" type="button"><span class="nav-icon">${icons.history}</span><span class="nav-label">History</span></button>
          <button id="nav-settings" class="nav-button" type="button"><span class="nav-icon">${icons.settings}</span><span class="nav-label">Settings</span></button>
        </nav>
        <div class="sidebar-status-wrap">
          <button id="local-status-button" class="sidebar-foot status-trigger" type="button" aria-expanded="false" aria-controls="health-popover">
            <span class="privacy-dot"></span>
            <span>Runs locally</span>
          </button>
          <div id="health-popover" class="health-popover" hidden>
            <div class="health-head">
              <div><strong>System status</strong><span>Transcriber health at a glance</span></div>
              <button id="health-refresh" class="icon-action subtle" type="button" title="Refresh status" aria-label="Refresh status">↻</button>
            </div>
            <div class="health-list">
              <div class="health-row"><span class="health-dot ready"></span><div><strong>Transcriber core</strong><span id="health-core">Running locally</span></div></div>
              <div class="health-row"><span id="health-cuda-dot" class="health-dot"></span><div><strong>CUDA backend</strong><span id="health-cuda">Checking…</span></div></div>
              <div class="health-row"><span id="health-speaker-dot" class="health-dot"></span><div><strong>Speaker Detection</strong><span id="health-speaker">Checking…</span></div></div>
              <div class="health-row"><span id="health-network-dot" class="health-dot ready"></span><div><strong>Network</strong><span id="health-network">No recorded use</span></div></div>
            </div>
            <div class="health-note">Only network activity initiated by Transcriber is recorded here.</div>
          </div>
        </div>
      </aside>

      <main class="workspace">
        <section id="convert-view" class="view convert-view">
          <div class="view-header">
            <div>
              <h1>Convert</h1>
              <p>Audio, video, meetings, lectures, movies.</p>
            </div>
            <div id="convert-header-actions" class="header-actions" hidden>
              <button id="header-add-files" class="button secondary small" type="button">${icons.plus}<span>Add files</span></button>
              <button id="header-add-folder" class="button secondary small" type="button">${icons.folder}<span>Add folder</span></button>
            </div>
          </div>

          <div id="convert-scroll" class="view-scroll convert-scroll">
            <div id="drop-zone" class="drop-zone" aria-label="Drop audio, video, files, or folders here">
              <div class="drop-orbit"><span class="drop-orbit-ring ring-a"></span><span class="drop-orbit-ring ring-b"></span><span class="drop-orbit-icon">${icons.upload}</span></div>
              <div class="drop-copy">
                <h2>Drop files or folders here</h2>
                <p>Audio and video are detected automatically</p>
              </div>
              <div class="drop-actions">
                <button id="browse-files" class="button primary" type="button">${icons.plus}<span>Add files</span></button>
                <button id="browse-folder" class="button secondary" type="button">${icons.folder}<span>Add folder</span></button>
              </div>
              <div class="drop-footnote">Drag and drop is the fastest way to start</div>
            </div>

            <div id="queue-panel" class="queue-panel" hidden>
              <div id="queue-overview" class="queue-overview"></div>
              <div id="jobs" class="queue-list"></div>
              <div class="queue-bottom-actions">
                <button id="clear-queue" class="text-button" type="button">Clear finished</button>
              </div>
            </div>
          </div>

          <footer class="convert-dock">
            <div id="dock-progress" class="dock-progress" hidden>
              <div class="dock-progress-heading">
                <span>Completion</span>
                <strong id="dock-progress-percent">0%</strong>
              </div>
              <div class="dock-progress-track"><span id="dock-progress-fill"></span></div>
              <div class="dock-progress-status">
                <span class="dock-progress-dot" aria-hidden="true"></span>
                <strong id="dock-progress-label">Ready to convert</strong>
                <span id="dock-progress-detail"></span>
              </div>
            </div>
            <div class="dock-main">
              <div class="dock-controls">
                <label class="dock-field">
                  <span>Quality</span>
                  <select id="model-select"></select>
                </label>
                <span class="dock-divider"></span>
                <label class="dock-field language-field">
                  <span>Language</span>
                  <select id="language-select"></select>
                </label>
                <span class="dock-divider"></span>
                <label class="dock-toggle">
                  <span class="dock-toggle-copy"><strong>Speaker Detection</strong><small id="speaker-status"></small></span>
                  <input id="speaker-detection" type="checkbox" class="sr-only">
                  <span class="switch-track" aria-hidden="true"><span></span></span>
                </label>
              </div>
              <button id="start-queue" class="button primary convert-button" type="button" disabled>
                <span>Convert</span>
                <span class="convert-arrow">→</span>
              </button>
            </div>
          </footer>

          <div id="drag-overlay" class="drag-overlay" aria-hidden="true">
            <div class="drag-overlay-inner">${icons.plus}<strong>Drop to add</strong></div>
          </div>
        </section>

        <section id="history-view" class="view" hidden>
          <div class="view-header history-header">
            <div>
              <h1>History</h1>
              <p>Recent conversions and outputs.</p>
            </div>
            <label class="search-control">${icons.search}<input id="history-search" type="search" placeholder="Search"></label>
          </div>
          <div class="view-scroll standard-scroll">
            <div id="history-summary" class="section-caption"></div>
            <div id="history-list" class="history-list"></div>
          </div>
          <div class="view-footer slim-footer">
            <button id="refresh-history" class="text-button" type="button">Refresh</button>
            <button id="clear-history" class="text-button danger" type="button">Clear history</button>
          </div>
        </section>

        <section id="settings-view" class="view" hidden>
          <div class="view-header">
            <div>
              <h1>Settings</h1>
              <p>Only the defaults worth changing.</p>
            </div>
          </div>
          <div class="view-scroll settings-scroll">
            <div class="settings-column">
              <section class="settings-group">
                <div class="settings-group-title">Transcription</div>
                <label class="settings-row">
                  <div class="settings-copy"><strong>Default language</strong><span>Auto detect is recommended.</span></div>
                  <select id="settings-language-select" class="settings-control compact-select"></select>
                </label>
                <div class="settings-row">
                  <div class="settings-copy"><strong>Speaker Detection</strong><span id="settings-speaker-status"></span></div>
                  <label class="settings-switch">
                    <input id="settings-speaker-detection" type="checkbox" class="sr-only">
                    <span class="switch-track" aria-hidden="true"><span></span></span>
                  </label>
                </div>
              </section>

              <section class="settings-group">
                <div class="settings-group-title">Model</div>
                <div class="settings-row model-row">
                  <div class="settings-copy"><strong>Transcription model</strong><span id="settings-model-status"></span></div>
                  <div class="settings-inline-control">
                    <select id="settings-model-select" class="settings-control model-select"></select>
                    <button id="settings-download-model" class="button secondary small" type="button">Download</button>
                  </div>
                </div>
              </section>

              <section class="settings-group">
                <div class="settings-group-title">Files</div>
                <label class="settings-row">
                  <div class="settings-copy"><strong>Save completed files</strong><span id="output-status"></span></div>
                  <select id="output-mode-select" class="settings-control compact-select">
                    <option value="input_dir">Next to source</option>
                    <option value="custom">Custom folder</option>
                  </select>
                </label>
                <div id="custom-output-row" class="settings-row sub-row" hidden>
                  <div class="path-value" id="output-path"></div>
                  <button id="choose-output-folder" class="button secondary small" type="button">Choose folder</button>
                </div>
              </section>

              <details class="advanced-group">
                <summary>Advanced</summary>
                <div class="advanced-body">
                  <label class="settings-row">
                    <div class="settings-copy"><strong>Processing backend</strong><span>Automatic CUDA is recommended. Change this only for troubleshooting.</span></div>
                    <select id="backend-select" class="settings-control compact-select">
                      <option value="CUDA">NVIDIA CUDA</option>
                      <option value="Standard">CPU</option>
                    </select>
                  </label>
                </div>
              </details>
            </div>
          </div>
        </section>
      </main>
    </div>

    <div id="notification-stack" class="notification-stack" aria-live="polite" aria-atomic="false"></div>
  </div>
`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

const appWindow = getCurrentWindow();
const convertView = $("#convert-view") as HTMLElement;
const historyView = $("#history-view") as HTMLElement;
const settingsView = $("#settings-view") as HTMLElement;
const convertNav = $("#nav-convert") as HTMLButtonElement;
const historyNav = $("#nav-history") as HTMLButtonElement;
const settingsNav = $("#nav-settings") as HTMLButtonElement;
const localStatusButton = $("#local-status-button") as HTMLButtonElement;
const healthPopover = $("#health-popover") as HTMLDivElement;
const healthRefreshButton = $("#health-refresh") as HTMLButtonElement;
const healthCuda = $("#health-cuda") as HTMLSpanElement;
const healthCudaDot = $("#health-cuda-dot") as HTMLSpanElement;
const healthSpeaker = $("#health-speaker") as HTMLSpanElement;
const healthSpeakerDot = $("#health-speaker-dot") as HTMLSpanElement;
const healthNetwork = $("#health-network") as HTMLSpanElement;
const healthNetworkDot = $("#health-network-dot") as HTMLSpanElement;
const dropZone = $("#drop-zone") as HTMLDivElement;
const dragOverlay = $("#drag-overlay") as HTMLDivElement;
const queuePanel = $("#queue-panel") as HTMLDivElement;
const queueOverview = $("#queue-overview") as HTMLDivElement;
const jobsContainer = $("#jobs") as HTMLDivElement;
const convertHeaderActions = $("#convert-header-actions") as HTMLDivElement;
const clearQueueButton = $("#clear-queue") as HTMLButtonElement;
const browseFilesButton = $("#browse-files") as HTMLButtonElement;
const browseFolderButton = $("#browse-folder") as HTMLButtonElement;
const headerAddFilesButton = $("#header-add-files") as HTMLButtonElement;
const headerAddFolderButton = $("#header-add-folder") as HTMLButtonElement;
const dockProgress = $("#dock-progress") as HTMLDivElement;
const dockProgressPercent = $("#dock-progress-percent") as HTMLElement;
const dockProgressLabel = $("#dock-progress-label") as HTMLElement;
const dockProgressDetail = $("#dock-progress-detail") as HTMLSpanElement;
const dockProgressFill = $("#dock-progress-fill") as HTMLSpanElement;
const notificationStack = $("#notification-stack") as HTMLDivElement;
const startButton = $("#start-queue") as HTMLButtonElement;
const modelSelect = $("#model-select") as HTMLSelectElement;
const languageSelect = $("#language-select") as HTMLSelectElement;
const speakerDetectionCheckbox = $("#speaker-detection") as HTMLInputElement;
const speakerStatus = $("#speaker-status") as HTMLSpanElement;
const historySummary = $("#history-summary") as HTMLDivElement;
const historyContainer = $("#history-list") as HTMLDivElement;
const historySearch = $("#history-search") as HTMLInputElement;
const refreshHistoryButton = $("#refresh-history") as HTMLButtonElement;
const clearHistoryButton = $("#clear-history") as HTMLButtonElement;
const settingsLanguageSelect = $("#settings-language-select") as HTMLSelectElement;
const settingsSpeakerDetectionCheckbox = $("#settings-speaker-detection") as HTMLInputElement;
const settingsSpeakerStatus = $("#settings-speaker-status") as HTMLSpanElement;
const settingsModelSelect = $("#settings-model-select") as HTMLSelectElement;
const settingsModelStatus = $("#settings-model-status") as HTMLSpanElement;
const settingsDownloadModelButton = $("#settings-download-model") as HTMLButtonElement;
const outputModeSelect = $("#output-mode-select") as HTMLSelectElement;
const outputStatus = $("#output-status") as HTMLSpanElement;
const customOutputRow = $("#custom-output-row") as HTMLDivElement;
const outputPath = $("#output-path") as HTMLDivElement;
const chooseOutputFolderButton = $("#choose-output-folder") as HTMLButtonElement;
const backendSelect = $("#backend-select") as HTMLSelectElement;


function revealApplication() {
  const root = document.documentElement;
  root.classList.add("ready", "app-ready");
  root.classList.remove("booting");

  const failSafe = (window as any).__transcriberBootFailsafe as number | undefined;
  if (failSafe) window.clearTimeout(failSafe);

  const splash = document.getElementById("boot-splash");
  if (!splash) return;

  const bootStarted = Number((window as any).__transcriberBootStarted ?? performance.now());
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const minimumVisible = reducedMotion ? 80 : 940;
  const delay = Math.max(0, minimumVisible - (performance.now() - bootStarted));

  window.setTimeout(() => {
    splash.classList.add("leaving");
    window.setTimeout(() => splash.remove(), reducedMotion ? 110 : 360);
  }, delay);
}

function animateViewIn(view: HTMLElement) {
  view.classList.remove("view-appear");
  void view.offsetWidth;
  view.classList.add("view-appear");
  window.setTimeout(() => view.classList.remove("view-appear"), 360);
}

function setupMicroInteractions() {
  document.querySelectorAll<HTMLElement>(".nav-button, .drop-zone, .button").forEach((element) => {
    element.addEventListener("pointermove", (event) => {
      const rect = element.getBoundingClientRect();
      element.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
      element.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
    });
  });

  document.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
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
  return value < 60_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s` : formatDuration(value / 1000);
}

function formatDate(value: number | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    inspecting: "Inspecting",
    ready: "Ready",
    queued: "Queued",
    converting: "Preparing",
    transcribing: "Transcribing",
    finalizing: "Finishing",
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

function isActive(job: QueueJob): boolean {
  return ["converting", "transcribing", "finalizing"].includes(job.status);
}

function canMove(job: QueueJob): boolean {
  return job.status === "ready" || job.status === "queued";
}

function compositeJobProgress(stage: string | undefined, rawProgress: number): number {
  const raw = Math.max(0, Math.min(1, Number.isFinite(rawProgress) ? rawProgress : 0));
  const withSpeakers = Boolean(settings?.speakerDetection);

  switch (stage) {
    case "converting":
      return raw * (withSpeakers ? 0.10 : 0.12);
    case "wav_ready":
      return withSpeakers ? 0.10 : 0.12;
    case "diarizing":
      return 0.10 + raw * 0.30;
    case "diarization_complete":
      return 0.40;
    case "model_init":
      return withSpeakers ? 0.42 : 0.14;
    case "transcribing": {
      const start = withSpeakers ? 0.44 : 0.16;
      const end = 0.96;
      return start + raw * (end - start);
    }
    case "completed":
      return 1;
    case "aborted":
    case "failed":
      return activeProgress;
    default:
      return raw;
  }
}

function isVideoName(name: string): boolean {
  return /\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv|mpeg|mpg)$/i.test(name);
}

function mediaGlyph(fileName: string): string {
  if (isVideoName(fileName)) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h2m2-4v8m3-11v14m3-11v8m3-5v2m3-5v8"/></svg>`;
}

function mediaIconMarkup(fileName: string, sourcePath: string, small = false): string {
  const video = isVideoName(fileName);
  return `<div class="media-icon${small ? " small" : ""}${video ? " video-media-icon" : ""}"${video ? ` data-video-preview-path="${escapeHtml(sourcePath)}"` : ""}><span class="media-glyph">${mediaGlyph(fileName)}</span></div>`;
}

function attachVideoThumbnail(icon: HTMLElement, url: string) {
  let image = icon.querySelector<HTMLImageElement>("img.media-thumbnail");
  if (!image) {
    image = document.createElement("img");
    image.className = "media-thumbnail";
    image.alt = "";
    image.draggable = false;
    icon.appendChild(image);
  }
  image.src = url;
  icon.classList.add("thumbnail-ready");
}

async function ensureVideoThumbnail(icon: HTMLElement) {
  const sourcePath = icon.dataset.videoPreviewPath;
  if (!sourcePath || icon.classList.contains("thumbnail-ready")) return;

  const cached = videoThumbnailCache.get(sourcePath);
  if (cached) {
    attachVideoThumbnail(icon, cached);
    return;
  }

  let pending = videoThumbnailPending.get(sourcePath);
  if (!pending) {
    pending = invoke<string>("get_video_thumbnail", { filePath: sourcePath })
      .then((path: string) => {
        const url = convertFileSrc(path);
        videoThumbnailCache.set(sourcePath, url);
        return url;
      })
      .finally(() => videoThumbnailPending.delete(sourcePath));
    videoThumbnailPending.set(sourcePath, pending);
  }

  try {
    const url = await pending!;
    if (icon.isConnected && icon.dataset.videoPreviewPath === sourcePath) attachVideoThumbnail(icon, url);
  } catch {
    icon.classList.add("thumbnail-unavailable");
  }
}

function installVideoThumbnailHover(container: HTMLElement) {
  container.addEventListener("pointerover", (event) => {
    const icon = (event.target as HTMLElement).closest<HTMLElement>("[data-video-preview-path]");
    if (!icon || icon.contains(event.relatedTarget as Node | null)) return;
    void ensureVideoThumbnail(icon);
  });
}

function renderLanguageOptions() {
  const html = LANGUAGE_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  languageSelect.innerHTML = html;
  settingsLanguageSelect.innerHTML = html;
  const language = String(settings?.language ?? "auto");
  const normalized = LANGUAGE_OPTIONS.some(([value]) => value === language) ? language : "auto";
  languageSelect.value = normalized;
  settingsLanguageSelect.value = normalized;
}

function renderModelOptions() {
  const presetModels = new Set<string>(QUALITY_PRESETS.map((preset) => preset.model));
  modelSelect.innerHTML = QUALITY_PRESETS.map((preset) => {
    const notInstalled = installedModels.has(preset.model) ? "" : " · not downloaded";
    return `<option value="${escapeHtml(preset.model)}">${escapeHtml(preset.label)}${notInstalled}</option>`;
  }).join("") + (presetModels.has(selectedModel)
    ? ""
    : `<option value="${escapeHtml(selectedModel)}">Custom · ${escapeHtml(selectedModelInfo().label)}</option>`);
  modelSelect.value = selectedModel;

  settingsModelSelect.innerHTML = MODEL_CATALOG.map((model) => {
    const installed = installedModels.has(model.name) ? " · Installed" : "";
    const recommended = model.name === DEFAULT_MODEL ? " · Recommended" : "";
    return `<option value="${escapeHtml(model.name)}">${escapeHtml(model.label)} · ${escapeHtml(model.size)}${recommended}${installed}</option>`;
  }).join("");
  settingsModelSelect.value = selectedModel;
}

function renderModelStatus() {
  const info = selectedModelInfo();
  const installed = installedModels.has(selectedModel);
  const downloading = modelDownload?.modelName === selectedModel
    && ["starting", "downloading", "paused"].includes(modelDownload.phase);

  let status = `${info.label} · ${info.size}`;
  let buttonText = installed ? "Installed" : "Download";
  let buttonDisabled = installed || queue.running;

  if (downloading && modelDownload) {
    const percent = Math.round(modelDownload.progress * 100);
    status = `${info.label} · Downloading ${percent}%`;
    buttonText = `${percent}%`;
    buttonDisabled = true;
  } else if (modelDownload?.modelName === selectedModel && modelDownload.phase === "failed") {
    status = `Download failed · ${modelDownload.error ?? "Unknown error"}`;
    buttonText = "Retry";
    buttonDisabled = false;
  } else if (installed) {
    status += selectedModel === DEFAULT_MODEL ? " · Recommended" : " · Ready";
  } else {
    status += " · Not downloaded";
  }

  settingsModelStatus.textContent = status;
  settingsDownloadModelButton.textContent = buttonText;
  settingsDownloadModelButton.disabled = buttonDisabled;
  modelSelect.disabled = queue.running || downloading;
  settingsModelSelect.disabled = queue.running || downloading;
}

function speakerStatusText(compact = false): string {
  if (!settings?.speakerDetection) return compact ? "Off" : "Off by default";
  if (speakerWarmState === "warming") return compact ? "Warming" : "Warming local speaker pipeline…";
  if (speakerWarmState === "error" || speakerDetectionStatusError) return compact ? "Unavailable" : "Speaker Detection is unavailable";
  if (!speakerDetectionStatus) return compact ? "Checking" : "Checking local runtime…";
  if (speakerDetectionStatus.available) {
    if (speakerDetectionStatus.missing.length > 0) return compact ? "Preparing" : "Downloads what it needs on first use";
    if (speakerWarmState === "ready") return compact ? "Ready" : `Ready${speakerWarmBackend ? ` · ${speakerWarmBackend}` : ""} · speaker count is automatic`;
    return compact ? "On" : "Ready · speaker count is automatic";
  }
  return compact ? "Unavailable" : "Speaker Detection runtime is unavailable";
}

function renderSpeakerDetectionStatus() {
  if (!settings) return;
  const enabled = Boolean(settings.speakerDetection);
  speakerDetectionCheckbox.checked = enabled;
  settingsSpeakerDetectionCheckbox.checked = enabled;
  speakerDetectionCheckbox.disabled = queue.running;
  settingsSpeakerDetectionCheckbox.disabled = queue.running;
  speakerStatus.textContent = speakerStatusText(true);
  settingsSpeakerStatus.textContent = speakerStatusText(false);
}

function recordNetworkActivity(reason: string) {
  const value = JSON.stringify({ at: Date.now(), reason });
  localStorage.setItem(NETWORK_ACTIVITY_KEY, value);
  renderNetworkHealth();
}

function readNetworkActivity(): { at: number; reason: string } | null {
  try {
    const raw = localStorage.getItem(NETWORK_ACTIVITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(parsed?.at) || typeof parsed?.reason !== "string") return null;
    return { at: parsed.at, reason: parsed.reason };
  } catch {
    return null;
  }
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function renderNetworkHealth() {
  const activity = readNetworkActivity();
  healthNetwork.textContent = activity
    ? `${activity.reason} · ${relativeTime(activity.at)}`
    : "No recorded network use";
  healthNetworkDot.className = "health-dot ready";
}

function renderSpeakerHealth() {
  const enabled = Boolean(settings?.speakerDetection);
  healthSpeakerDot.className = "health-dot";
  if (!enabled) {
    healthSpeaker.textContent = "Off";
    healthSpeakerDot.classList.add("muted");
    return;
  }
  if (speakerWarmState === "warming") {
    healthSpeaker.textContent = "Warming local pipeline…";
    healthSpeakerDot.classList.add("working");
    return;
  }
  if (speakerWarmState === "error" || speakerDetectionStatusError || speakerDetectionStatus?.available === false) {
    healthSpeaker.textContent = "Unavailable";
    healthSpeakerDot.classList.add("error");
    return;
  }
  healthSpeaker.textContent = speakerWarmState === "ready"
    ? `Ready${speakerWarmBackend ? ` · ${speakerWarmBackend}` : ""}`
    : "Ready on demand";
  healthSpeakerDot.classList.add("ready");
}

async function refreshHealthPanel() {
  healthRefreshButton.disabled = true;
  renderNetworkHealth();
  renderSpeakerHealth();
  try {
    const [cudaBuild, specs] = await Promise.all([
      invoke<boolean>("check_build", { backend: "CUDA" }),
      invoke<SystemSpecs>("get_system_specs"),
    ]);
    const gpuReady = cudaBuild && specs.is_discrete_gpu && !/cpu only/i.test(specs.gpu_name);
    healthCuda.textContent = gpuReady ? `Ready · ${specs.gpu_name}` : cudaBuild ? "CUDA build available · GPU not detected" : "CUDA build unavailable";
    healthCudaDot.className = `health-dot ${gpuReady ? "ready" : "error"}`;
  } catch (error) {
    healthCuda.textContent = "Couldn't read CUDA status";
    healthCudaDot.className = "health-dot error";
  } finally {
    healthRefreshButton.disabled = false;
  }
}

function closeHealthPopover() {
  healthPopover.hidden = true;
  localStatusButton.setAttribute("aria-expanded", "false");
}

function renderSettings() {
  if (!settings) return;
  backendSelect.value = settings.selectedBackend === "Standard" ? "Standard" : "CUDA";
  outputModeSelect.value = settings.outputDirMode === "custom" ? "custom" : "input_dir";
  outputPath.textContent = String(settings.outputDirPath || "No folder selected");
  outputPath.title = String(settings.outputDirPath || "");
  customOutputRow.hidden = outputModeSelect.value !== "custom";
  outputStatus.textContent = outputModeSelect.value === "custom"
    ? (settings.outputDirPath ? basename(String(settings.outputDirPath)) : "Choose a folder")
    : "Next to each source file";
  renderLanguageOptions();
  renderModelOptions();
  renderModelStatus();
  renderSpeakerDetectionStatus();
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
  if (!enabled) {
    speakerWarmState = "idle";
    speakerWarmBackend = "";
  }
  renderQueue();
  renderSpeakerHealth();
  if (enabled) void warmSpeakerDetection();
}

function referenceSpeed(): number {
  const speeds = queue.jobs
    .filter((job) => job.status === "completed" && job.speedFactor && job.speedFactor > 0 && job.durationSec >= 5)
    .map((job) => job.speedFactor as number);
  return speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0;
}

function estimatedJobSeconds(job: QueueJob, speed: number): number | null {
  if (["completed", "failed", "cancelled"].includes(job.status)) return 0;
  if (isActive(job) && activeMetrics) return Math.max(0, activeMetrics.etaSec);
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
  return hasEstimate ? total : null;
}

function queueOverallProgress(): number {
  if (!queue.jobs.length) return 0;

  const weighted = queue.jobs.some((job) => job.durationSec > 0);
  let totalWeight = 0;
  let completedWeight = 0;

  for (const job of queue.jobs) {
    const weight = weighted ? Math.max(1, job.durationSec || 1) : 1;
    totalWeight += weight;

    if (["completed", "failed", "cancelled"].includes(job.status)) {
      completedWeight += weight;
    } else if (isActive(job)) {
      completedWeight += weight * Math.max(0, Math.min(1, activeProgress));
    }
  }

  return totalWeight > 0 ? completedWeight / totalWeight : 0;
}

function setTaskbarProgress() {
  if (!queue.running) {
    void appWindow.setProgressBar({ status: ProgressBarStatus.None }).catch(() => {});
    return;
  }
  const progress = Math.round(queueOverallProgress() * 100);
  void appWindow.setProgressBar(progress > 0
    ? { status: ProgressBarStatus.Normal, progress }
    : { status: ProgressBarStatus.Indeterminate }).catch(() => {});
}

function setDisplayedOverallPercent(target: number) {
  const clamped = Math.max(0, Math.min(100, target));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (progressPercentAnimation) cancelAnimationFrame(progressPercentAnimation);
  if (reducedMotion || Math.abs(clamped - displayedOverallPercent) < 0.5) {
    displayedOverallPercent = clamped;
    dockProgressPercent.textContent = `${Math.round(clamped)}%`;
    return;
  }

  const start = displayedOverallPercent;
  const delta = clamped - start;
  const startedAt = performance.now();
  const duration = 520;
  const tick = (now: number) => {
    const t = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    displayedOverallPercent = start + delta * eased;
    dockProgressPercent.textContent = `${Math.round(displayedOverallPercent)}%`;
    if (t < 1) progressPercentAnimation = requestAnimationFrame(tick);
    else progressPercentAnimation = 0;
  };
  progressPercentAnimation = requestAnimationFrame(tick);
}

function renderQueue() {
  const hasQueue = queue.jobs.length > 0;
  const completed = queue.jobs.filter((job) => job.status === "completed").length;
  const failed = queue.jobs.filter((job) => job.status === "failed").length;
  const cancelled = queue.jobs.filter((job) => job.status === "cancelled").length;
  const activeJob = queue.jobs.find(isActive);
  const eta = queueEtaSeconds();
  const overall = Math.max(0, Math.min(1, queueOverallProgress()));
  const overallPercent = overall * 100;

  dropZone.hidden = hasQueue;
  queuePanel.hidden = !hasQueue;
  convertHeaderActions.hidden = !hasQueue || queue.running;

  if (hasQueue) {
    const terminalCount = completed + failed + cancelled;
    const primary = queue.running && activeJob
      ? `${statusLabel(activeJob.status)} ${Math.min(terminalCount + 1, queue.jobs.length)} of ${queue.jobs.length}`
      : terminalCount === queue.jobs.length
        ? `${completed} completed${failed ? ` · ${failed} failed` : ""}${cancelled ? ` · ${cancelled} cancelled` : ""}`
        : `${queue.jobs.length} ${queue.jobs.length === 1 ? "file" : "files"}`;
    const secondary = queue.running && eta !== null
      ? `${formatDuration(eta)} remaining`
      : `${formatDuration(queue.totalDurationSec)} total`;

    queueOverview.innerHTML = `
      <div class="queue-overview-copy">
        <strong>${escapeHtml(primary)}</strong>
        <span>${escapeHtml(secondary)}</span>
      </div>
    `;

    jobsContainer.innerHTML = queue.jobs.map((job) => {
      const active = isActive(job);
      const progress = job.status === "completed"
        ? 100
        : active && job.status === "transcribing"
          ? Math.round(activeProgress * 100)
          : active ? Math.max(2, Math.round(job.progress * 100) || 2) : 0;
      const previousProgress = lastJobProgress.get(job.id) ?? 0;
      lastJobProgress.set(job.id, progress);

      const speakerDetail = job.speakerCount !== null && job.speakerCount > 0
        ? `${job.speakerCount} speaker${job.speakerCount === 1 ? "" : "s"}`
        : "";
      const speakerBackendDetail = speakerDetail && job.speakerBackend ? `${speakerDetail} · ${job.speakerBackend}` : speakerDetail;
      const timing = active && activeMetrics
        ? [speakerBackendDetail, `${activeMetrics.speedFactor.toFixed(1)}× realtime`, `${formatDuration(activeMetrics.etaSec)} left`].filter(Boolean).join(" · ")
        : job.status === "completed"
          ? [job.durationMs !== null ? `Done in ${formatDurationMs(job.durationMs)}` : "Done", job.speedFactor ? `${job.speedFactor.toFixed(1)}× realtime` : "", speakerBackendDetail].filter(Boolean).join(" · ")
          : [job.durationSec > 0 ? formatDuration(job.durationSec) : "", speakerBackendDetail].filter(Boolean).join(" · ");
      const message = active ? (activeMessage || job.message || "") : job.message ?? "";
      const output = job.outputFiles[0];
      const canReorder = canMove(job) && !queue.running;

      return `
        <article class="queue-row ${active ? "active" : ""} ${job.status === "failed" ? "failed" : ""}" data-job-row="${escapeHtml(job.id)}">
          <div class="drag-slot">
            ${canReorder ? `<span class="drag-handle" data-drag-job-id="${escapeHtml(job.id)}" title="Hold and drag to reorder" aria-label="Hold and drag to reorder">${icons.grip}</span>` : `<span class="drag-handle-placeholder"></span>`}
          </div>
          ${mediaIconMarkup(job.fileName, job.sourcePath)}
          <div class="queue-file">
            <div class="queue-file-top">
              <strong title="${escapeHtml(job.sourcePath)}">${escapeHtml(job.fileName)}</strong>
              <span class="status-text ${statusClass(job.status)}">${statusLabel(job.status)}</span>
            </div>
            <div class="queue-file-meta">
              ${timing ? `<span>${escapeHtml(timing)}</span>` : ""}
              ${message ? `<span>${escapeHtml(message)}</span>` : ""}
              ${job.error ? `<span class="error-copy">${escapeHtml(job.error)}</span>` : ""}
            </div>
            ${active ? `<div class="row-progress"><span data-progress-target="${progress}" style="width:${previousProgress}%"></span></div>` : ""}
          </div>
          <div class="row-actions">
            ${output ? `<button class="icon-action" data-open-path="${escapeHtml(output)}" data-source-path="${escapeHtml(job.sourcePath)}" title="Open output" aria-label="Open output">${icons.open}</button><button class="icon-action" data-reveal-path="${escapeHtml(output)}" data-source-path="${escapeHtml(job.sourcePath)}" title="Show in folder" aria-label="Show in folder">${icons.folder}</button>` : ""}
            <button class="icon-action ${active ? "danger" : "subtle"}" data-action="${active ? "cancel" : "remove"}" data-job-id="${escapeHtml(job.id)}" title="${active ? "Cancel" : "Remove"}" aria-label="${active ? "Cancel" : "Remove"}" ${!active && queue.running ? "disabled" : ""}>${active ? icons.close : icons.trash}</button>
          </div>
        </article>
      `;
    }).join("");
  } else {
    queueOverview.innerHTML = "";
    jobsContainer.innerHTML = "";
    lastJobProgress.clear();
  }

  // Queue-wide focus progress. The glow is anchored to the real progress edge;
  // it never sweeps independently across the bar.
  dockProgress.hidden = !hasQueue;
  if (hasQueue) {
    const previousOverall = lastOverallProgress * 100;
    dockProgressFill.style.width = `${previousOverall}%`;
    dockProgress.classList.toggle("running", queue.running);
    dockProgress.classList.toggle("finished", !queue.running && queue.jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status)));

    let target = 0;
    if (queue.running) {
      target = overallPercent;
      const terminalCount = completed + failed + cancelled;
      const currentNumber = Math.min(terminalCount + 1, queue.jobs.length);
      const focusStage = activeMessage || (activeJob ? statusLabel(activeJob.status) : "Processing queue");
      dockProgressLabel.textContent = activeJob
        ? `${focusStage} · ${currentNumber} of ${queue.jobs.length} · ${activeJob.fileName}`
        : "Processing queue";
      const activeSpeakerDetail = activeJob?.speakerCount
        ? `${activeJob.speakerCount} speaker${activeJob.speakerCount === 1 ? "" : "s"}${activeJob.speakerBackend ? ` · ${activeJob.speakerBackend}` : ""}`
        : "";
      dockProgressDetail.textContent = [
        eta !== null ? `${formatDuration(eta)} remaining` : "Estimating time…",
        activeMetrics?.speedFactor ? `${activeMetrics.speedFactor.toFixed(1)}× realtime` : "",
        activeSpeakerDetail,
      ].filter(Boolean).join(" · ");
    } else {
      const terminalCount = completed + failed + cancelled;
      const pendingCount = Math.max(0, queue.jobs.length - terminalCount);
      const finished = queue.jobs.length > 0 && pendingCount === 0;
      target = finished ? 100 : 0;
      dockProgressLabel.textContent = finished
        ? (failed ? `${completed} completed · ${failed} failed${cancelled ? ` · ${cancelled} cancelled` : ""}` : cancelled ? `${completed} completed · ${cancelled} cancelled` : "Queue complete")
        : `${pendingCount} ${pendingCount === 1 ? "file" : "files"} ready`;
      dockProgressDetail.textContent = finished ? "Finished" : `${formatDuration(queue.totalDurationSec)} total`;
    }

    setDisplayedOverallPercent(target);
    requestAnimationFrame(() => {
      dockProgressFill.style.width = `${target}%`;
      jobsContainer.querySelectorAll<HTMLElement>("[data-progress-target]").forEach((element) => {
        element.style.width = `${element.dataset.progressTarget ?? "0"}%`;
      });
    });
  } else {
    dockProgressFill.style.width = "0%";
    setDisplayedOverallPercent(0);
  }
  lastOverallProgress = hasQueue
    ? (queue.running ? overall : (queue.jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status)) ? 1 : 0))
    : 0;

  const runnable = queue.jobs.some((job) => job.status === "ready" || job.status === "queued");
  const modelReady = installedModels.has(selectedModel);

  startButton.classList.toggle("cancel-mode", queue.running);
  if (queue.running) {
    startButton.disabled = cancellingAll;
    startButton.querySelector("span")!.textContent = cancellingAll ? "Cancelling…" : "Cancel all";
    const arrow = startButton.querySelector(".convert-arrow");
    if (arrow) arrow.textContent = "×";
  } else {
    cancellingAll = false;
    startButton.disabled = !runnable || !modelReady;
    startButton.querySelector("span")!.textContent = modelReady ? "Convert" : "Model needed";
    const arrow = startButton.querySelector(".convert-arrow");
    if (arrow) arrow.textContent = "→";
  }

  browseFilesButton.disabled = queue.running;
  browseFolderButton.disabled = queue.running;
  headerAddFilesButton.disabled = queue.running;
  headerAddFolderButton.disabled = queue.running;
  clearQueueButton.disabled = queue.running || !hasQueue;
  renderModelStatus();
  renderSpeakerDetectionStatus();
  setTaskbarProgress();
}

function captureQueueRowRects(): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  jobsContainer.querySelectorAll<HTMLElement>("[data-job-row]").forEach((row) => {
    const id = row.dataset.jobRow;
    if (id) rects.set(id, row.getBoundingClientRect());
  });
  return rects;
}

function animateQueueReorder(before: Map<string, DOMRect>) {
  requestAnimationFrame(() => {
    jobsContainer.querySelectorAll<HTMLElement>("[data-job-row]").forEach((row) => {
      const id = row.dataset.jobRow;
      if (!id) return;
      const previous = before.get(id);
      if (!previous) return;
      const current = row.getBoundingClientRect();
      const deltaY = previous.top - current.top;
      if (Math.abs(deltaY) < 1) return;
      row.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    });
  });
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
  historySummary.textContent = historyEntries.length
    ? `${filtered.length} of ${historyEntries.length} recent conversions`
    : "";

  if (!filtered.length) {
    historyContainer.innerHTML = `
      <div class="empty-view">
        <span class="empty-icon">${icons.history}</span>
        <strong>${historyEntries.length ? "Nothing matches your search" : "No conversions yet"}</strong>
        <span>${historyEntries.length ? "Try a different search." : "Completed files will appear here."}</span>
      </div>`;
    return;
  }

  historyContainer.innerHTML = filtered.map((entry) => {
    const output = entry.outputFiles[0];
    const subtitle = [
      formatDate(entry.completedAtMs ?? entry.createdAtMs),
      entry.mediaDurationSec > 0 ? formatDuration(entry.mediaDurationSec) : "",
      entry.processingDurationMs !== null ? `Processed in ${formatDurationMs(entry.processingDurationMs)}` : "",
      entry.speedFactor !== null ? `${entry.speedFactor.toFixed(1)}×` : "",
    ].filter(Boolean).join(" · ");

    return `
      <article class="history-row">
        ${mediaIconMarkup(entry.fileName, entry.sourcePath, true)}
        <div class="history-copy">
          <div class="history-topline">
            <strong>${escapeHtml(entry.fileName)}</strong>
            <span class="status-text ${statusClass(entry.status)}">${statusLabel(entry.status)}</span>
          </div>
          <div class="history-meta">${escapeHtml(subtitle)}</div>
          ${entry.error ? `<div class="history-error">${escapeHtml(entry.error)}</div>` : ""}
        </div>
        <div class="history-actions">
          ${output ? `<button class="button secondary small" data-open-path="${escapeHtml(output)}" data-source-path="${escapeHtml(entry.sourcePath)}">Open</button><button class="button secondary small" data-reveal-path="${escapeHtml(output)}" data-source-path="${escapeHtml(entry.sourcePath)}">Folder</button>` : ""}
          <button class="icon-action subtle" data-delete-history-id="${escapeHtml(entry.id)}" title="Remove from history" aria-label="Remove from history">${icons.trash}</button>
        </div>
      </article>`;
  }).join("");
}

type NotificationTone = "info" | "success" | "warning" | "error";

function showToast(message: string, tone: NotificationTone = "info", duration = 3200) {
  const existing = Array.from(notificationStack.querySelectorAll<HTMLElement>(".notification"))
    .find((item) => item.dataset.message === message);
  if (existing) existing.remove();

  const item = document.createElement("div");
  item.className = `notification ${tone}`;
  item.dataset.message = message;
  item.innerHTML = `
    <span class="notification-mark" aria-hidden="true"></span>
    <span class="notification-copy">${escapeHtml(message)}</span>
  `;
  notificationStack.appendChild(item);

  requestAnimationFrame(() => item.classList.add("show"));

  const remove = () => {
    if (!item.isConnected) return;
    item.classList.remove("show");
    window.setTimeout(() => item.remove(), 180);
  };

  let timer = window.setTimeout(remove, duration);
  item.addEventListener("mouseenter", () => window.clearTimeout(timer));
  item.addEventListener("mouseleave", () => {
    timer = window.setTimeout(remove, Math.min(1800, duration));
  });
}

async function warmSpeakerDetection() {
  if (!settings?.speakerDetection || speakerWarmPromise) return;

  const modelsDir = String(settings.modelsDir ?? "");
  const backend = settings.selectedBackend === "Standard" ? "Standard" : "CUDA";
  if (!modelsDir) return;

  speakerWarmState = "warming";
  speakerWarmBackend = "";
  renderSpeakerDetectionStatus();
  renderSpeakerHealth();

  if ((speakerDetectionStatus?.missing.length ?? 0) > 0) {
    recordNetworkActivity("Speaker model setup");
  }

  speakerWarmPromise = (async () => {
    const started = performance.now();
    try {
      const warmedBackend = await invoke<string>("warm_speaker_detection", { modelsDir, backend });
      speakerWarmState = "ready";
      speakerWarmBackend = warmedBackend.toUpperCase();
      await refreshSpeakerDetectionStatus();
      if (performance.now() - started > 700) {
        showToast("Speaker Detection is ready.", "success", 2200);
      }
    } catch (error) {
      speakerWarmState = "error";
      speakerWarmBackend = "";
      showToast("Speaker Detection will retry when conversion starts.", "warning", 3600);
    } finally {
      speakerWarmPromise = null;
      renderSpeakerDetectionStatus();
      renderSpeakerHealth();
    }
  })();

  await speakerWarmPromise;
}

async function addPathsToQueue(paths: string[]) {
  const cleanPaths = [...new Set(paths.map((path) => String(path).trim()).filter(Boolean))];
  if (!cleanPaths.length || queue.running) return;

  const previousCount = queue.jobs.length;

  try {
    const result = await invoke<AddJobsResult>("add_job_queue_files", { paths: cleanPaths });
    queue = result.queue;
    renderQueue();

    const added = Math.max(0, queue.jobs.length - previousCount);
    if (added > 0) {
      showToast(`${added} ${added === 1 ? "file" : "files"} added.`, "success", 2200);
      if (settings?.speakerDetection) void warmSpeakerDetection();
    }

    if (result.alreadyProcessedPaths.length) {
      const count = result.alreadyProcessedPaths.length;
      showToast(`${count} already converted/generated ${count === 1 ? "file was" : "files were"} skipped.`, "info", 3000);
    }

    if (result.ignoredPaths.length) {
      const count = result.ignoredPaths.length;
      showToast(`${count} unsupported ${count === 1 ? "item was" : "items were"} skipped.`, "warning");
    }
  } catch (error) {
    showToast(`Couldn't add those files: ${String(error)}`, "error", 5000);
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
    historySummary.textContent = `History couldn't load: ${String(error)}`;
  }
}

async function showView(view: AppView) {
  if (activeView === view && !document.documentElement.classList.contains("booting")) return;

  activeView = view;
  const target = view === "convert" ? convertView : view === "history" ? historyView : settingsView;

  convertView.hidden = view !== "convert";
  historyView.hidden = view !== "history";
  settingsView.hidden = view !== "settings";
  convertNav.classList.toggle("active", view === "convert");
  historyNav.classList.toggle("active", view === "history");
  settingsNav.classList.toggle("active", view === "settings");
  setDragVisual(false);

  animateViewIn(target);
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
    recordNetworkActivity(`Model download · ${selectedModel}`);
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

async function browseFiles() {
  const paths = await invoke<string[] | null>("select_files");
  if (paths?.length) await addPathsToQueue(paths);
}

async function browseFolder() {
  const path = await invoke<string | null>("select_directory");
  if (path) await addPathsToQueue([path]);
}

async function openPath(path: string, sourcePath?: string) {
  try {
    await invoke("open_file_in_editor", {
      filePath: path,
      sourcePath: sourcePath || null,
    });
  } catch (error) {
    showToast(`Couldn't open output: ${String(error)}`, "error", 5000);
  }
}

async function revealPath(path: string, sourcePath?: string) {
  try {
    const revealed = await invoke<string>("show_output_in_folder", {
      filePath: path,
      sourcePath: sourcePath || null,
    });
    if (revealed === "source") {
      showToast("Output is missing — opened the source location instead.", "info", 3400);
    }
  } catch (error) {
    showToast(`Couldn't show that file location: ${String(error)}`, "error", 5000);
  }
}

function setDragVisual(active: boolean) {
  const enabled = active && activeView === "convert" && !queue.running;
  convertView.classList.toggle("dragging", enabled);
  dragOverlay.setAttribute("aria-hidden", enabled ? "false" : "true");
}

function shouldHandleDrop(paths: string[]): boolean {
  const signature = [...paths].sort().join("\n");
  const now = performance.now();
  if (signature && signature === lastDropSignature && now - lastDropAt < 900) return false;
  lastDropSignature = signature;
  lastDropAt = now;
  return true;
}

async function setupDragAndDrop() {
  await listen<boolean>("transcriber-native-drag-enter", (event) => {
    if (activeView !== "convert" || queue.running || queuePointerDrag) {
      setDragVisual(false);
      return;
    }
    setDragVisual(Boolean(event.payload));
  });

  await listen<string[]>("transcriber-native-file-drop", async (event) => {
    const paths = event.payload ?? [];
    setDragVisual(false);
    if (activeView !== "convert" || queue.running || queuePointerDrag) return;
    if (paths.length && shouldHandleDrop(paths)) await addPathsToQueue(paths);
  });

  try {
    const webview = getCurrentWebview();
    await webview.onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (activeView !== "convert" || queue.running || queuePointerDrag) {
        setDragVisual(false);
        return;
      }
      if (payload.type === "enter" || payload.type === "over") {
        setDragVisual(true);
        return;
      }
      if (payload.type === "leave") {
        setDragVisual(false);
        return;
      }
      const paths = payload.paths ?? [];
      setDragVisual(false);
      if (paths.length && shouldHandleDrop(paths)) await addPathsToQueue(paths);
    });
  } catch {
    // The Rust bridge above remains the primary Windows path.
  }

  document.addEventListener("dragenter", (event) => {
    if (activeView !== "convert" || queue.running || queuePointerDrag) return;
    event.preventDefault();
    setDragVisual(true);
  });
  document.addEventListener("dragover", (event) => {
    if (activeView !== "convert" || queue.running || queuePointerDrag) return;
    event.preventDefault();
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget && !queuePointerDrag) setDragVisual(false);
  });
  document.addEventListener("drop", (event) => {
    if (activeView !== "convert" || queue.running || queuePointerDrag) return;
    event.preventDefault();
    setDragVisual(false);
  });
}

function setupWindowControls() {
  $("#window-minimize").addEventListener("click", () => void appWindow.minimize());
  $("#window-maximize").addEventListener("click", () => void appWindow.toggleMaximize());
  $("#window-close").addEventListener("click", () => void invoke("exit_app"));
  const titlebar = document.querySelector<HTMLElement>(".titlebar");
  titlebar?.addEventListener("dblclick", (event) => {
    if (!(event.target as HTMLElement).closest("button")) void appWindow.toggleMaximize();
  });
}

async function initialize() {
  const loadedSettings = await invoke<WhisperSettings>("load_settings");
  settings = loadedSettings;
  const savedModel = normalizeModelName(String(loadedSettings.modelPath ?? ""));
  selectedModel = MODEL_CATALOG.some((model) => model.name === savedModel) ? savedModel : DEFAULT_MODEL;

  loadedSettings.modelPath = modelFileName(selectedModel);
  loadedSettings.speakerDetection = Boolean(loadedSettings.speakerDetection ?? false);
  loadedSettings.speakerCount = 0;
  loadedSettings.language = String(loadedSettings.language || "auto");
  loadedSettings.outputDirMode = loadedSettings.outputDirMode === "custom" ? "custom" : "input_dir";
  loadedSettings.outputDirPath = String(loadedSettings.outputDirPath ?? "");
  loadedSettings.selectedBackend = loadedSettings.selectedBackend === "Standard" ? "Standard" : "CUDA";
  loadedSettings.ffmpegSource = "bundled";

  await persistSettings();
  renderLanguageOptions();
  await refreshInstalledModels();
  await refreshSpeakerDetectionStatus();
  await refreshQueue();
  wasQueueRunning = queue.running;
  if (loadedSettings.speakerDetection) void warmSpeakerDetection();
  renderSettings();
  setupMicroInteractions();
  animateViewIn(convertView);
  revealApplication();
}

await listen<ModelDownloadProgress>("model-download-status", async (event: { payload: ModelDownloadProgress }) => {
  modelDownload = event.payload;
  if (event.payload.phase === "completed") {
    await refreshInstalledModels();
    modelDownload = null;
    showToast("Model download complete.", "success", 2600);
  } else if (event.payload.phase === "failed") {
    showToast(`Model download failed: ${event.payload.error ?? "Unknown error"}`, "error", 5200);
  }
  renderModelStatus();
});

await listen<QueueSnapshot>("job-queue-updated", async (event: { payload: QueueSnapshot }) => {
  const previousRunning = wasQueueRunning;
  queue = event.payload;
  wasQueueRunning = queue.running;

  const nextActiveJobId = queue.jobs.find(isActive)?.id ?? null;
  if (nextActiveJobId !== activeJobId) {
    activeJobId = nextActiveJobId;
    activeProgress = 0;
    activeMessage = "";
    activeMetrics = null;
  } else if (!nextActiveJobId) {
    activeProgress = 0;
    activeMessage = "";
    activeMetrics = null;
  }

  if (previousRunning && !queue.running) {
    cancellingAll = false;
    const completed = queue.jobs.filter((job) => job.status === "completed").length;
    const failed = queue.jobs.filter((job) => job.status === "failed").length;
    const cancelled = queue.jobs.filter((job) => job.status === "cancelled").length;
    if (failed > 0) {
      showToast(`${completed} completed · ${failed} failed.`, "warning", 4200);
    } else if (cancelled > 0 && completed === 0) {
      showToast("Queue cancelled.", "info", 2600);
    } else if (completed > 0) {
      showToast(`${completed} ${completed === 1 ? "conversion" : "conversions"} complete.`, "success", 3200);
    }
  }

  renderQueue();
  if (activeView === "history") await loadHistory();
});

await listen<TranscribeMetrics>("transcribe-metrics", (event: { payload: TranscribeMetrics }) => {
  activeMetrics = event.payload;
  activeProgress = compositeJobProgress("transcribing", event.payload.progress);
  renderQueue();
});

await listen<TranscribeProgress>("transcribe-status", (event: { payload: TranscribeProgress }) => {
  activeProgress = compositeJobProgress(event.payload.stage, event.payload.progress ?? 0);
  activeMessage = event.payload.message ?? "";
  if (event.payload.stage !== "transcribing") activeMetrics = null;
  renderQueue();
});

setupWindowControls();
void setupDragAndDrop().catch(() => showToast("Drag and drop couldn't initialize.", "warning", 4200));

localStatusButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = healthPopover.hidden;
  healthPopover.hidden = !opening;
  localStatusButton.setAttribute("aria-expanded", opening ? "true" : "false");
  if (opening) void refreshHealthPanel();
});
healthRefreshButton.addEventListener("click", (event) => {
  event.stopPropagation();
  void refreshHealthPanel();
});
document.addEventListener("pointerdown", (event) => {
  if (healthPopover.hidden) return;
  const target = event.target as Node;
  if (!healthPopover.contains(target) && !localStatusButton.contains(target)) closeHealthPopover();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeHealthPopover();
});

convertNav.addEventListener("click", () => void showView("convert"));
historyNav.addEventListener("click", () => void showView("history"));
settingsNav.addEventListener("click", () => void showView("settings"));

browseFilesButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!queue.running) void browseFiles();
});
browseFolderButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!queue.running) void browseFolder();
});
headerAddFilesButton.addEventListener("click", () => {
  if (!queue.running) void browseFiles();
});
headerAddFolderButton.addEventListener("click", () => {
  if (!queue.running) void browseFolder();
});
dropZone.addEventListener("click", (event) => {
  if (queue.running) return;
  if ((event.target as HTMLElement).closest("button")) return;
  void browseFiles();
});
dropZone.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !queue.running) {
    event.preventDefault();
    void browseFiles();
  }
});

modelSelect.addEventListener("change", () => void applySelectedModel(modelSelect.value));
settingsModelSelect.addEventListener("change", () => void applySelectedModel(settingsModelSelect.value));
languageSelect.addEventListener("change", () => void applyLanguage(languageSelect.value));
settingsLanguageSelect.addEventListener("change", () => void applyLanguage(settingsLanguageSelect.value));
speakerDetectionCheckbox.addEventListener("change", () => void setSpeakerDetection(speakerDetectionCheckbox.checked));
settingsSpeakerDetectionCheckbox.addEventListener("change", () => void setSpeakerDetection(settingsSpeakerDetectionCheckbox.checked));
settingsDownloadModelButton.addEventListener("click", () => void startModelDownload());

startButton.addEventListener("click", async () => {
  if (!settings) return;

  if (queue.running) {
    if (cancellingAll) return;
    cancellingAll = true;
    renderQueue();
    try {
      queue = await invoke<QueueSnapshot>("cancel_job_queue");
      wasQueueRunning = queue.running;
      renderQueue();
    } catch (error) {
      cancellingAll = false;
      showToast(`Couldn't cancel the queue: ${String(error)}`, "error", 5000);
      await refreshQueue();
    }
    return;
  }

  try {
    wasQueueRunning = true;
    await invoke<QueueSnapshot>("start_job_queue", { settings });
  } catch (error) {
    wasQueueRunning = false;
    showToast(`Couldn't start conversion: ${String(error)}`, "error", 5000);
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
    showToast(`Couldn't clear the queue: ${String(error)}`, "error", 5000);
  }
});

jobsContainer.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const openButton = target.closest<HTMLButtonElement>("button[data-open-path]");
  if (openButton?.dataset.openPath) {
    await openPath(openButton.dataset.openPath, openButton.dataset.sourcePath);
    return;
  }
  const revealButton = target.closest<HTMLButtonElement>("button[data-reveal-path]");
  if (revealButton?.dataset.revealPath) {
    await revealPath(revealButton.dataset.revealPath, revealButton.dataset.sourcePath);
    return;
  }

  const button = target.closest<HTMLButtonElement>("button[data-action][data-job-id]");
  if (!button) return;
  const action = button.dataset.action;
  const jobId = button.dataset.jobId;
  if (!action || !jobId) return;

  button.disabled = true;
  try {
    if (action === "cancel") {
      queue = await invoke<QueueSnapshot>("cancel_queue_job", { jobId });
    } else if (action === "remove") {
      queue = await invoke<QueueSnapshot>("remove_queue_job", { jobId });
    }
    renderQueue();
  } catch (error) {
    showToast(`Couldn't ${action} that item: ${String(error)}`, "error", 5000);
    await refreshQueue();
  }
});

function clearPointerReorderPreview() {
  jobsContainer.classList.remove("pointer-reordering");
  jobsContainer.querySelectorAll<HTMLElement>("[data-job-row]").forEach((row) => {
    row.classList.remove("dragging-row", "drop-before", "drop-after");
    row.style.removeProperty("transform");
    row.style.removeProperty("z-index");
  });
}

function targetIndexForPointer(clientY: number, drag: QueuePointerDrag): number {
  const ordered = queue.jobs.filter((job) => job.id !== drag.jobId);
  let index = 0;
  for (const job of ordered) {
    const rect = drag.rowRects.get(job.id);
    if (!rect) continue;
    if (clientY > rect.top + rect.height / 2) index += 1;
  }
  return Math.max(0, Math.min(ordered.length, index));
}

function previewPointerReorder(clientY: number) {
  const drag = queuePointerDrag;
  if (!drag) return;

  drag.targetIndex = targetIndexForPointer(clientY, drag);
  const draggedRect = drag.rowRects.get(drag.jobId);
  if (!draggedRect) return;

  const draggedRow = jobsContainer.querySelector<HTMLElement>(`[data-job-row="${CSS.escape(drag.jobId)}"]`);
  if (draggedRow) {
    draggedRow.style.transform = `translateY(${clientY - drag.startY}px) scale(.995)`;
    draggedRow.style.zIndex = "4";
  }

  const slot = draggedRect.height;
  queue.jobs.forEach((job, index) => {
    if (job.id === drag.jobId) return;
    const row = jobsContainer.querySelector<HTMLElement>(`[data-job-row="${CSS.escape(job.id)}"]`);
    if (!row) return;

    let shift = 0;
    if (drag.targetIndex > drag.originalIndex && index > drag.originalIndex && index <= drag.targetIndex) {
      shift = -slot;
    } else if (drag.targetIndex < drag.originalIndex && index >= drag.targetIndex && index < drag.originalIndex) {
      shift = slot;
    }
    row.style.transform = shift ? `translateY(${shift}px)` : "";
  });
}

jobsContainer.addEventListener("pointerdown", (event) => {
  const pointerEvent = event as PointerEvent;
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-drag-job-id]");
  if (!handle || queue.running || pointerEvent.button !== 0) return;

  const jobId = handle.dataset.dragJobId;
  if (!jobId) return;

  const originalIndex = queue.jobs.findIndex((job) => job.id === jobId);
  if (originalIndex < 0) return;

  event.preventDefault();
  event.stopPropagation();

  const rowRects = captureQueueRowRects();
  queuePointerDrag = {
    pointerId: pointerEvent.pointerId,
    jobId,
    originalIndex,
    targetIndex: originalIndex,
    startY: pointerEvent.clientY,
    rowRects,
  };

  handle.setPointerCapture?.(pointerEvent.pointerId);
  jobsContainer.classList.add("pointer-reordering");
  handle.closest<HTMLElement>("[data-job-row]")?.classList.add("dragging-row");
});

document.addEventListener("pointermove", (event) => {
  if (!queuePointerDrag || event.pointerId !== queuePointerDrag.pointerId) return;
  event.preventDefault();
  previewPointerReorder(event.clientY);
}, { passive: false });

async function finishPointerReorder(event: PointerEvent, commit: boolean) {
  const drag = queuePointerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;

  const before = captureQueueRowRects();
  const newIndex = drag.targetIndex;
  const jobId = drag.jobId;

  queuePointerDrag = null;
  clearPointerReorderPreview();

  if (!commit || newIndex === drag.originalIndex) return;

  try {
    queue = await invoke<QueueSnapshot>("move_queue_job", { jobId, newIndex });
    renderQueue();
    animateQueueReorder(before);
  } catch (error) {
    showToast(`Couldn't reorder that item: ${String(error)}`, "error", 4500);
    await refreshQueue();
  }
}

document.addEventListener("pointerup", (event) => {
  void finishPointerReorder(event, true);
});

document.addEventListener("pointercancel", (event) => {
  void finishPointerReorder(event, false);
});


historySearch.addEventListener("input", () => {
  historyQuery = historySearch.value;
  renderHistory();
});
refreshHistoryButton.addEventListener("click", () => void loadHistory());
clearHistoryButton.addEventListener("click", async () => {
  if (historyEntries.length && !window.confirm("Clear Transcriber history? Generated files will not be deleted.")) return;
  try {
    await invoke("clear_history");
    await loadHistory();
  } catch (error) {
    showToast(`Couldn't clear history: ${String(error)}`);
  }
});
historyContainer.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const openButton = target.closest<HTMLButtonElement>("button[data-open-path]");
  if (openButton?.dataset.openPath) {
    await openPath(openButton.dataset.openPath, openButton.dataset.sourcePath);
    return;
  }
  const revealButton = target.closest<HTMLButtonElement>("button[data-reveal-path]");
  if (revealButton?.dataset.revealPath) {
    await revealPath(revealButton.dataset.revealPath, revealButton.dataset.sourcePath);
    return;
  }
  const deleteButton = target.closest<HTMLButtonElement>("button[data-delete-history-id]");
  const id = deleteButton?.dataset.deleteHistoryId;
  if (!deleteButton || !id) return;
  deleteButton.disabled = true;
  try {
    await invoke<boolean>("delete_history_entry", { id });
    await loadHistory();
  } catch (error) {
    showToast(`Couldn't remove that history item: ${String(error)}`);
  }
});

installVideoThumbnailHover(jobsContainer);
installVideoThumbnailHover(historyContainer);

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
    showToast(`That folder can't be used: ${String(error)}`);
  }
});
backendSelect.addEventListener("change", async () => {
  if (!settings) return;
  settings.selectedBackend = backendSelect.value;
  await persistSettings();
  await refreshInstalledModels();
  await refreshSpeakerDetectionStatus();
  renderQueue();
  showToast(backendSelect.value === "CUDA" ? "CUDA selected." : "CPU selected for transcription.");
});

document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || activeView !== "convert" || queue.running) return;
  if (event.key.toLowerCase() === "o" && !event.shiftKey) {
    event.preventDefault();
    void browseFiles();
  } else if (event.key.toLowerCase() === "o" && event.shiftKey) {
    event.preventDefault();
    void browseFolder();
  }
});

document.addEventListener("contextmenu", (event) => {
  if (!(event.target as HTMLElement).closest("input, textarea, select")) event.preventDefault();
});

initialize().catch((error) => {
  showToast(`Transcriber couldn't start: ${String(error)}`);
  document.documentElement.classList.add("ready");
});
