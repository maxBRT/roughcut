#!/usr/bin/env bash
# Runs the spike transcriber over the test audio for every model/device combination.
# Usage: bash run_matrix.sh quality|speed
# Output: spikes/speech/recorded/<audio>__<model>__<device>[_b<batch>].jsonl
set -u
source "C:/Users/alice/.t3/scratch/2026-11-13-i-need-a-video-editor-651bb36b/roughcut/tools/env.sh"
S="/c/Users/alice/.t3/scratch/2026-11-13-i-need-a-video-editor-651bb36b/roughcut/.cache-dev/speech"
OUT="/c/Users/alice/.t3/scratch/2026-11-13-i-need-a-video-editor-651bb36b/roughcut/spikes/speech/recorded"
RAWOUT="$S/runs"
mkdir -p "$OUT" "$RAWOUT"
cd "$S"

run() { # audio model device batch outdir
  local audio=$1 model=$2 device=$3 batch=$4 dir=$5 extra=${6:-}
  local exe=deploy-cpu/transcriber-spike.exe threads=8
  if [ "$device" = gpu ]; then exe=deploy-gpu/transcriber-spike.exe; threads=4; fi
  local tag="${audio%.wav}__${model#sherpa-onnx-nemo-parakeet-tdt-0.6b-}__${device}_b${batch}"
  ffmpeg -v error -i "audio/$audio" -f s16le -ac 1 -ar 16000 - \
    | "./$exe" --model-dir "models/$model" --vad models/silero_vad.onnx --device "$device" \
        --threads $threads --batch "$batch" $extra > "$dir/$tag.jsonl" 2> "$RAWOUT/$tag.err"
  echo "$tag rc=$? $(tail -c 420 "$dir/$tag.jsonl" | grep -o '"stats":.*')"
}

if [ "$1" = quality ]; then
  for a in monologue_clean.wav monologue_noisy.wav ami_B_300_600.wav; do
    run $a sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 cpu 1 "$OUT" --raw
    run $a sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 cpu 1 "$OUT" --raw
    run $a sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 gpu 1 "$OUT" --raw
    run $a sherpa-onnx-nemo-parakeet-tdt-0.6b-v3 gpu 1 "$OUT" --raw
  done
fi
if [ "$1" = speed2 ]; then # repeat round, run after the first to see run-to-run spread
  for m in v2 v3; do
    run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-$m gpu 4 "$RAWOUT"
    run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-$m gpu 1 "$RAWOUT"
    run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-$m-int8 cpu 1 "$RAWOUT"
  done
fi
if [ "$1" = speed ]; then
  nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 gpu 1 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 gpu 4 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v3 gpu 1 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v3 gpu 4 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16 gpu 1 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 gpu 1 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 cpu 1 "$RAWOUT"
  run hour.wav sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 cpu 1 "$RAWOUT"
  nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
fi
