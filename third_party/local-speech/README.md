# Local speech runtime provenance

The runtime contract is intentionally unavailable unless every executable and model file is present and the `features.localSpeech` preview flag is enabled.

- STT: `whisper-cli` from `ggml-org/whisper.cpp` v1.9.3 (`7246b7311e089fe092c4abe7cfad5d0921f8be00`), MIT. The official project publishes source releases and documents CMake builds; it does not publish a reviewed executable set for every Dani target.
- TTS CLI contract: `nazdridoy/kokoro-tts` v2.3.2 (`8353f696856ace6a4fc60abd29bee3672b0f3b00`), MIT, backed by `thewh1teagle/kokoro-onnx` and ONNX Runtime. Its upstream distribution is a Python package rather than reviewed native executables.
- Kokoro model: Apache-2.0. The pinned `kokoro-v1.0.int8.onnx` and combined `voices-v1.0.bin` are the payload shape consumed by that CLI. A single per-voice embedding is not a valid drop-in for this runtime.

No third-party binary is checked in or downloaded without a pinned hash. Until target-specific runtime artifacts and their transitive notices are reviewed and staged under `speech-runtime/<platform>-<arch>/`, capability reporting stays unavailable. Developers can point at locally built real executables with `DANI_WHISPER_CLI` and `DANI_KOKORO_CLI`; this does not change packaged readiness.
