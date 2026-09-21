/** Pinned, redistributable model payload packaged for future local calls.
 * Native inference runtimes are tracked separately and are not implied here.
 */
export const SPEECH_MODEL_BUNDLE_VERSION = 1;

export const SPEECH_MODEL_BUNDLE = Object.freeze({
  stt: Object.freeze({
    id: "whisper-base-q5_1",
    engine: "whisper.cpp",
    languages: "multilingual",
    file: "ggml-base-q5_1.bin",
    bytes: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
  }),
  tts: Object.freeze({
    id: "kokoro-82m-quantized-af-heart",
    engine: "onnx",
    model: Object.freeze({
      file: "kokoro-v1.0.int8.onnx",
      bytes: 114_119_327,
      sha256: "ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c",
      url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx",
    }),
    voice: Object.freeze({
      id: "voices-v1.0",
      file: "voices-v1.0.bin",
      bytes: 28_214_398,
      sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
      url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin",
    }),
  }),
});

export const SPEECH_MODEL_BUNDLE_BYTES =
  SPEECH_MODEL_BUNDLE.stt.bytes + SPEECH_MODEL_BUNDLE.tts.model.bytes + SPEECH_MODEL_BUNDLE.tts.voice.bytes;
