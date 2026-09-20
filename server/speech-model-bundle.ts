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
      file: "model_quantized.onnx",
      bytes: 92_361_116,
      sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
      url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
    }),
    voice: Object.freeze({
      id: "af_heart",
      file: "af_heart.bin",
      bytes: 522_240,
      sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
      url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
    }),
  }),
});

export const SPEECH_MODEL_BUNDLE_BYTES =
  SPEECH_MODEL_BUNDLE.stt.bytes + SPEECH_MODEL_BUNDLE.tts.model.bytes + SPEECH_MODEL_BUNDLE.tts.voice.bytes;
