#!/bin/bash

set -e

VERSION=$(cat package.json \
  | grep version \
  | head -1 \
  | awk -F: '{ print $2 }' \
  | sed 's/[",]//g' \
  | tr -d '[[:space:]]')

echo version: $VERSION

DOCKER_BUILDKIT=1 docker build -t gigurra/kfwd:${VERSION} -f Dockerfile .
