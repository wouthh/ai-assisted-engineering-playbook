#!/usr/bin/env bash

set -eu

repository=${1:-.}

if ! root=$(git -C "$repository" rev-parse --show-toplevel 2>/dev/null); then
  printf 'preflight: not a Git working tree\n' >&2
  exit 2
fi

if ! branch=$(git -C "$root" symbolic-ref --quiet --short HEAD); then
  printf 'preflight: detached HEAD\n' >&2
  exit 3
fi

head_sha=$(git -C "$root" rev-parse HEAD)

if ! upstream=$(git -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
  printf 'preflight: branch has no upstream\n' >&2
  exit 4
fi

printf 'root\t%s\n' "$root"
printf 'branch\t%s\n' "$branch"
printf 'head\t%s\n' "$head_sha"
printf 'upstream\t%s\n' "$upstream"

if [ -n "$(git -C "$root" status --porcelain=v1 --untracked-files=all)" ]; then
  printf 'preflight: working tree is not clean\n' >&2
  exit 5
fi

printf 'working_tree\tclean\n'
