import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

async function inspectBackend() {
  const output = document.querySelector<HTMLPreElement>("#output");
  if (!output) return;

  output.textContent = "Inspecting inherited backend...";

  try {
    const [
      system,
      ffmpeg,
      standard,
      cuda,
      vulkan,
      openvino,
    ] = await Promise.all([
      invoke("get_system_specs"),

      // Explicitly test system FFmpeg for now so we don't depend
      // on Whisper Desktop's existing settings path yet.
      invoke("get_ffmpeg_status", { source: "system" }),

      invoke("check_build", { backend: "Standard" }),
      invoke("check_build", { backend: "CUDA" }),
      invoke("check_build", { backend: "Vulkan" }),
      invoke("check_build", { backend: "OpenVINO" }),
    ]);

    output.textContent = JSON.stringify(
        {
          system,
          ffmpeg,
          whisperBackends: {
            standard,
            cuda,
            vulkan,
            openvino,
          },
        },
        null,
        2,
    );
  } catch (error) {
    output.textContent = `Backend inspection failed:\n${String(error)}`;
  }
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main>
    <h1>Transcriber</h1>
    <p>Inherited backend verification</p>

    <button id="inspect-button">
      Inspect Backend
    </button>

    <pre id="output">Ready.</pre>
  </main>
`;

document
    .querySelector<HTMLButtonElement>("#inspect-button")
    ?.addEventListener("click", inspectBackend);