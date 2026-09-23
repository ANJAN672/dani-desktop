"""Minimal Kokoro synthesis CLI matching the contract Dani's server calls.

server/local-speech-runtime.ts spawns:

    kokoro-cli <input.txt> <output.wav> --model <onnx> --voices <bin>
               --voice <name> --lang <code> --format wav

Written because the CLI the repository pins, nazdridoy/kokoro-tts v2.3.2, hard
pins kokoro-onnx==0.3.9, and that version feeds the ONNX graph an input named
`tokens` while the pinned kokoro-v1.0 model declares `input_ids`. The two
cannot work together, so the pinned pair produces no audio at all. The model
itself is fine: kokoro-onnx 0.6.1 reads it and synthesizes correctly.
"""
import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="kokoro-cli", add_help=True)
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--format", default="wav", choices=["wav"])
    args = parser.parse_args()

    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            text = handle.read().strip()
    except OSError as error:
        print(f"cannot read input: {error}", file=sys.stderr)
        return 2
    if not text:
        print("input text is empty", file=sys.stderr)
        return 2

    try:
        from kokoro_onnx import Kokoro
        import soundfile

        kokoro = Kokoro(args.model, args.voices)
        audio, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
        soundfile.write(args.output, audio, rate, subtype="PCM_16")
    except Exception as error:  # noqa: BLE001 - the exit code is the contract
        print(f"synthesis failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
