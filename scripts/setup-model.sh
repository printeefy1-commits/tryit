#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/models
if [ ! -s public/models/face_landmarker.task ]; then
  curl --fail --location --retry 2 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' -o public/models/face_landmarker.task.tmp
  mv public/models/face_landmarker.task.tmp public/models/face_landmarker.task
fi
