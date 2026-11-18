#!/usr/bin/env bash
# Builds transcriber.exe (release) and assembles a ready-to-run folder with exactly the runtime
# DLLs it needs beside it:
#   .cache-dev/speech/dist/cpu   transcriber.exe + 3 DLLs (processor only, ~22 MB)
#   .cache-dev/speech/dist/gpu   transcriber.exe + 17 DLLs (CUDA 12 / cuDNN 9, ~2.3 GB) + the
#                                Visual C++ runtime DLLs the CUDA onnxruntime build imports
# The GPU folder also runs on the processor ("--device cpu", or automatic fallback), so an
# installation needs only one of the two.
#
# Usage (Git Bash, from anywhere):  transcriber/scripts/build.sh [cpu|gpu|all]   (default: all)
# Environment: CARGO_TARGET_DIR (default target-tracks/transcriber).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/tools/env.sh"
SPEECH="$ROOT/.cache-dev/speech"
WHAT="${1:-all}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target-tracks/transcriber}"

CPU_DLLS="sherpa-onnx-c-api.dll onnxruntime.dll onnxruntime_providers_shared.dll"
GPU_DLLS="sherpa-onnx-c-api.dll onnxruntime.dll onnxruntime_providers_shared.dll onnxruntime_providers_cuda.dll \
cudart64_12.dll cublas64_12.dll cublasLt64_12.dll cudnn64_9.dll cudnn_adv64_9.dll cudnn_cnn64_9.dll \
cudnn_engines_precompiled64_9.dll cudnn_engines_runtime_compiled64_9.dll cudnn_engines_tensor_ir64_9.dll \
cudnn_ext64_9.dll cudnn_graph64_9.dll cudnn_heuristic64_9.dll cudnn_ops64_9.dll"
# Imported by the CUDA build of onnxruntime.dll / onnxruntime_providers_cuda.dll (dynamic CRT).
VC_DLLS="msvcp140.dll msvcp140_1.dll vcruntime140.dll vcruntime140_1.dll"

place() { # source-file dest-dir
  local name; name="$(basename "$1")"
  [ -f "$1" ] || { echo "missing $1" >&2; exit 1; }
  rm -f "$2/$name"
  ln "$1" "$2/$name" 2>/dev/null || cp "$1" "$2/$name"
}

build_variant() { # cpu|gpu
  local v="$1" sdk="$SPEECH/sdk/$1" dist="$SPEECH/dist/$1" dlls
  "$HERE/setup-sdk.sh" "$v"
  echo "building transcriber against $sdk"
  (cd "$ROOT" && SHERPA_ONNX_LIB_DIR="$sdk" cargo build --release -p transcriber)
  rm -rf "$dist"; mkdir -p "$dist"
  cp "$CARGO_TARGET_DIR/release/transcriber.exe" "$dist/"
  if [ "$v" = gpu ]; then dlls="$GPU_DLLS"; else dlls="$CPU_DLLS"; fi
  for f in $dlls; do place "$sdk/$f" "$dist"; done
  if [ "$v" = gpu ]; then
    local sys="${SYSTEMROOT:-C:/Windows}/System32"
    for f in $VC_DLLS; do
      if [ -f "$sys/$f" ]; then cp "$sys/$f" "$dist/"; else echo "warning: $f not found in $sys" >&2; fi
    done
  fi
  echo "ready: $dist"
  ls -l "$dist"
}

case "$WHAT" in
  cpu|gpu) build_variant "$WHAT" ;;
  all) build_variant cpu; build_variant gpu ;;
  *) echo "usage: $0 [cpu|gpu|all]" >&2; exit 2 ;;
esac
