#!/usr/bin/env bash
# Prepares the runtime folders the transcriber is linked against and ships with:
#   .cache-dev/speech/sdk/cpu  sherpa-onnx C API + onnxruntime (processor only)
#   .cache-dev/speech/sdk/gpu  sherpa-onnx C API + onnxruntime with CUDA + the NVIDIA libraries
# Each holds sherpa-onnx-c-api.lib (for linking) and exactly the DLLs that must sit next to
# transcriber.exe. Point SHERPA_ONNX_LIB_DIR at one of them when building; the sherpa-onnx-sys
# build script then copies its DLLs next to the executable.
#
# Downloads (official, no installer, no administrator rights) go to .cache-dev/speech/downloads
# and are skipped when already there. Files are hard-linked where possible to save disk space.
#
# Usage: transcriber/scripts/setup-sdk.sh [cpu|gpu|all]   (default: all)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SPEECH="$ROOT/.cache-dev/speech"
DL="$SPEECH/downloads"
RUNTIME="$SPEECH/runtime"
NVIDIA="$SPEECH/nvidia"
SDK="$SPEECH/sdk"
WHAT="${1:-all}"

SHERPA_VER="2.0.1"
CPU_PKG="sherpa-onnx-v${SHERPA_VER}-win-x64-shared-MT-Release-no-tts"
GPU_PKG="sherpa-onnx-v${SHERPA_VER}-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda"
SHERPA_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VER}"
CUDART="cuda_cudart-windows-x86_64-12.9.79-archive"
CUBLAS="libcublas-windows-x86_64-12.9.2.10-archive"
CUDNN="cudnn-windows-x86_64-9.28.1.4_cuda12-archive"
NV_URL_CUDART="https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/${CUDART}.zip"
NV_URL_CUBLAS="https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/${CUBLAS}.zip"
NV_URL_CUDNN="https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/${CUDNN}.zip"

mkdir -p "$DL" "$RUNTIME" "$NVIDIA" "$SDK"

fetch() { # url file
  if [ ! -s "$DL/$2" ]; then
    echo "downloading $1"
    curl -fL --retry 3 -o "$DL/$2.part" "$1"
    mv "$DL/$2.part" "$DL/$2"
  fi
}

unpack_sherpa() { # package-name
  if [ ! -d "$RUNTIME/$1/lib" ]; then
    fetch "$SHERPA_URL/$1.tar.bz2" "$1.tar.bz2"
    tar -xjf "$DL/$1.tar.bz2" -C "$RUNTIME"
  fi
}

unpack_nvidia() { # url archive-name
  if [ ! -d "$NVIDIA/$2" ]; then
    fetch "$1" "$2.zip"
    (cd "$NVIDIA" && unzip -q "$DL/$2.zip")
  fi
}

place() { # source-file dest-dir
  local name; name="$(basename "$1")"
  [ -f "$1" ] || { echo "missing $1" >&2; exit 1; }
  rm -f "$2/$name"
  ln "$1" "$2/$name" 2>/dev/null || cp "$1" "$2/$name"
}

if [ "$WHAT" = "cpu" ] || [ "$WHAT" = "all" ]; then
  unpack_sherpa "$CPU_PKG"
  D="$SDK/cpu"; mkdir -p "$D"
  for f in sherpa-onnx-c-api.dll sherpa-onnx-c-api.lib onnxruntime.dll onnxruntime_providers_shared.dll; do
    place "$RUNTIME/$CPU_PKG/lib/$f" "$D"
  done
  echo "ready: $D"
fi

if [ "$WHAT" = "gpu" ] || [ "$WHAT" = "all" ]; then
  unpack_sherpa "$GPU_PKG"
  unpack_nvidia "$NV_URL_CUDART" "$CUDART"
  unpack_nvidia "$NV_URL_CUBLAS" "$CUBLAS"
  unpack_nvidia "$NV_URL_CUDNN" "$CUDNN"
  D="$SDK/gpu"; mkdir -p "$D"
  for f in sherpa-onnx-c-api.dll sherpa-onnx-c-api.lib onnxruntime.dll onnxruntime_providers_shared.dll onnxruntime_providers_cuda.dll; do
    place "$RUNTIME/$GPU_PKG/lib/$f" "$D"
  done
  place "$NVIDIA/$CUDART/bin/cudart64_12.dll" "$D"
  place "$NVIDIA/$CUBLAS/bin/cublas64_12.dll" "$D"
  place "$NVIDIA/$CUBLAS/bin/cublasLt64_12.dll" "$D"
  for f in cudnn64_9 cudnn_adv64_9 cudnn_cnn64_9 cudnn_engines_precompiled64_9 cudnn_engines_runtime_compiled64_9 \
           cudnn_engines_tensor_ir64_9 cudnn_ext64_9 cudnn_graph64_9 cudnn_heuristic64_9 cudnn_ops64_9; do
    place "$NVIDIA/$CUDNN/bin/x64/$f.dll" "$D"
  done
  echo "ready: $D"
fi
