#!/usr/bin/env bash

set -eu
export GIT_OPTIONAL_LOCKS=0

git_read() {
  git --no-optional-locks -c core.fsmonitor=false "$@"
}

repository=${1:-.}

if ! root=$(git_read -C "$repository" rev-parse --show-toplevel 2>/dev/null); then
  printf 'preflight: not a Git working tree\n' >&2
  exit 2
fi

if ! branch=$(git_read -C "$root" symbolic-ref --quiet --short HEAD); then
  printf 'preflight: detached HEAD\n' >&2
  exit 3
fi

if ! head_sha=$(git_read -C "$root" rev-parse HEAD 2>/dev/null); then
  printf 'preflight: unable to resolve HEAD\n' >&2
  exit 6
fi

if ! upstream=$(git_read -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
  printf 'preflight: branch has no upstream\n' >&2
  exit 4
fi

for operation_marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer BISECT_START; do
  if ! marker_path=$(git_read -C "$root" rev-parse --path-format=absolute --git-path "$operation_marker" 2>/dev/null); then
    printf 'preflight: unable to inspect Git operation state\n' >&2
    exit 6
  fi
  if [ -e "$marker_path" ]; then
    printf 'preflight: Git operation is in progress\n' >&2
    exit 7
  fi
done

printf 'root\t%s\n' "$root"
printf 'branch\t%s\n' "$branch"
printf 'head\t%s\n' "$head_sha"
printf 'upstream\t%s\n' "$upstream"

if ! working_state=$(git_read -C "$root" status --porcelain=v1 --untracked-files=all --ignore-submodules=none 2>/dev/null); then
  printf 'preflight: unable to determine working-tree state\n' >&2
  exit 6
fi

if [ -n "$working_state" ]; then
  printf 'preflight: working tree is not clean\n' >&2
  exit 5
fi

printf 'working_tree\tclean\n'
